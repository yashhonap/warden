// Coding tools the model can call. Each tool: { name, description, parameters (JSON schema), kind, run(args, ctx) }.
// kind drives permissions: "read" (free inside the project), "edit" (changes files), "bash" (runs commands).
// run() returns { content: string for the model, display: { title, lines?, diff? } for the terminal }.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const MAX_OUT = 40_000;
const SKIP_DIRS = new Set([".git", "node_modules", ".hg", ".svn", "dist", "build", ".next", ".venv", "venv", "__pycache__", ".cache", "target", ".idea"]);

const clip = (s, n = MAX_OUT) => (s.length > n ? s.slice(0, n) + `\n[... ${s.length - n} more characters cut]` : s);
export const resolveIn = (cwd, p) => path.resolve(cwd, String(p ?? "."));
export const isInside = (cwd, abs) => { const rel = path.relative(cwd, abs); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };
const relOf = (cwd, abs) => (isInside(cwd, abs) ? path.relative(cwd, abs) || "." : abs);
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

function walk(root, onFile, limit = 20000) {
  let n = 0;
  const stack = [root];
  while (stack.length && n < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(full); }
      else if (e.isFile()) { n++; if (onFile(full) === false) return; }
    }
  }
}

export function globToRegex(glob) {
  let re = "", i = 0;
  const g = glob.replace(/\\/g, "/");
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") { re += g[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += g[i + 2] === "/" ? 3 : 2; continue; }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") { const end = g.indexOf("}", i); if (end > i) { re += "(?:" + g.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")"; i = end + 1; continue; } re += "\\{"; }
    else re += c.replace(/[.+^$()|[\]\\}]/g, "\\$&");
    i++;
  }
  return new RegExp("^" + re + "$", process.platform === "win32" ? "i" : "");
}

// ---- shell -----------------------------------------------------------------

export function detectShell() {
  if (process.platform !== "win32") return { cmd: fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh", args: (c) => ["-c", c], name: "bash" };
  for (const p of [process.env.WARDEN_BASH, "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]) {
    if (p && fs.existsSync(p)) return { cmd: p, args: (c) => ["-c", c], name: "bash (Git Bash on Windows)" };
  }
  return { cmd: "powershell.exe", args: (c) => ["-NoProfile", "-NonInteractive", "-Command", c], name: "PowerShell (Windows)" };
}

const UNIX = process.platform !== "win32";
const shellEnv = () => ({ ...process.env, WARDEN: "1" });

// Kill a shell and everything it started. Killing only the shell is not enough: a dev server or watcher it launched
// keeps running and keeps the output pipe open, so the command would never finish.
export function killTree(p) {
  if (!p?.pid) return;
  if (!UNIX) {
    try { spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 }); } catch {}
    try { p.kill(); } catch {}
    return;
  }
  try { process.kill(-p.pid, "SIGTERM"); } catch { try { p.kill("SIGTERM"); } catch {} }
  const t = setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch {} }, 1500);
  t.unref?.();
}

const spawnShell = (command, cwd) => {
  const sh = detectShell();
  // detached on Unix = its own process group, so killTree can stop the whole group
  return spawn(sh.cmd, sh.args(command), { cwd, windowsHide: true, detached: UNIX, env: shellEnv() });
};

// Runs a command to completion. Always returns: on exit, on timeout, on interrupt, and also when the shell exits but
// something it started in the background still holds the output open.
function runShell(command, { cwd, timeoutMs, signal, onOutput }) {
  return new Promise((resolve) => {
    let p;
    try { p = spawnShell(command, cwd); } catch (e) { return resolve({ code: -1, out: `failed to start shell: ${e.message}`, killed: null }); }
    let out = "", killed = null, done = false, code = null, lingered = false;
    const timers = [];
    const later = (ms, fn) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      signal?.removeEventListener("abort", onAbort);
      try { p.stdout.destroy(); p.stderr.destroy(); } catch {}
      resolve({ code, out, killed, lingered });
    };
    const kill = (why) => {
      if (killed || done) return;
      killed = why;
      killTree(p);
      later(4000, finish); // never wait forever, even if the kill did not take
    };
    const onAbort = () => kill("interrupted");
    later(timeoutMs, () => kill("timeout"));
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
    const add = (d) => {
      const s = String(d);
      if (out.length < MAX_OUT * 2) out += s;
      try { onOutput?.(s); } catch {}
    };
    p.stdout.on("data", add); p.stderr.on("data", add);
    p.on("error", (e) => { out += `failed to start shell: ${e.message}`; code = -1; finish(); });
    p.on("exit", (c) => {
      code = c;
      // the shell is done; if the output stays open, a process it started is still running
      later(500, () => { lingered = !killed; finish(); });
    });
    p.on("close", (c) => { code ??= c; finish(); });
    p.stdin.end();
  });
}

// ---- background jobs (dev servers, watchers) ----------------------------------

const JOBS = new Map();
let jobSeq = 0;
const tail = (s, n = 4000) => (s.length > n ? `[… ${s.length - n} earlier characters]\n` + s.slice(-n) : s);

export function startJob(command, cwd) {
  const p = spawnShell(command, cwd);
  const job = { id: ++jobSeq, command, cwd, pid: p.pid, started: Date.now(), out: "", exit: undefined, p };
  const add = (d) => { job.out += d; if (job.out.length > 200_000) job.out = job.out.slice(-100_000); };
  p.stdout.on("data", add); p.stderr.on("data", add);
  p.on("error", (e) => { job.out += `failed to start: ${e.message}\n`; job.exit = -1; });
  p.on("exit", (c, sig) => { job.exit = job.stopped ? "stopped" : c ?? sig ?? "stopped"; });
  p.stdin.end();
  // a running job must not keep `warden -p` alive; Warden stops all jobs when it exits
  p.unref(); p.stdout.unref?.(); p.stderr.unref?.();
  JOBS.set(job.id, job);
  return job;
}

export const listJobs = () => [...JOBS.values()];
export const jobRunning = (j) => j.exit === undefined;

export function stopJob(job) {
  if (!jobRunning(job)) return false;
  job.stopped = true;
  killTree(job.p);
  job.exit = "stopped";
  return true;
}

export function stopAllJobs() { for (const j of JOBS.values()) stopJob(j); }
process.on("exit", stopAllJobs);

export function describeJob(j) {
  const secs = Math.round((Date.now() - j.started) / 1000);
  const state = jobRunning(j) ? `running for ${secs}s` : `exited (${j.exit})`;
  return `job ${j.id} (pid ${j.pid}) ${state}: ${j.command}`;
}

// ---- edit helpers ---------------------------------------------------------------

// Finds old_string as whole lines while ignoring trailing spaces (a common reason exact matches fail).
// Returns [{ start, end, line }] character ranges in `text`.
function findLooseLines(text, oldS, cmp = (a, b) => a.trimEnd() === b.trimEnd()) {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(nl);
  const want = oldS.replace(/\r\n/g, "\n").split("\n");
  const endsWithNl = want.length > 1 && want.at(-1) === "";
  if (endsWithNl) want.pop();
  if (!want.some((l) => l.trim())) return [];
  const offs = []; let o = 0;
  for (const l of lines) { offs.push(o); o += l.length + nl.length; }
  const hits = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length && ok; k++) ok = cmp(lines[i + k], want[k]);
    if (!ok) continue;
    const last = i + want.length - 1;
    let end = offs[last] + lines[last].length;
    if (endsWithNl && last < lines.length - 1) end += nl.length;
    hits.push({ start: offs[i], end, line: i + 1 });
  }
  return hits;
}

const numbered = (text, from, count) => text.replace(/\r\n/g, "\n").split("\n").slice(from - 1, from - 1 + count).map((l, i) => `${from + i}\t${l}`).join("\n");

// A useful message when old_string is not in the file: where the closest text is, and what it really says.
function notFoundHelp(text, oldS) {
  const wantLines = oldS.replace(/\r\n/g, "\n").split("\n");
  const indentHits = findLooseLines(text, oldS, (a, b) => a.trim() === b.trim());
  if (indentHits.length) {
    const h = indentHits[0];
    return `old_string was not found exactly, but the same lines with different indentation are at line ${h.line}. Copy the exact text (from the tab after the line number) and try again:\n${numbered(text, h.line, Math.min(wantLines.length, 30))}`;
  }
  const first = wantLines.find((l) => l.trim())?.trim();
  if (first) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const at = lines.findIndex((l) => l.includes(first));
    if (at >= 0) return `old_string was not found. Its first line matches line ${at + 1}, but the lines after it differ. The file there says:\n${numbered(text, at + 1, Math.min(Math.max(wantLines.length + 2, 5), 30))}\nCopy the exact text and try again.`;
  }
  return "old_string was not found in the file. The file may have changed since you last read it: read it again and copy the exact text, including whitespace.";
}

// ---- diff for display ------------------------------------------------------

function lineDiff(oldText, newText, startLine) {
  const a = oldText.split("\n"), b = newText.split("\n");
  const lines = [];
  a.forEach((l, i) => lines.push({ t: "-", n: startLine + i, s: l }));
  b.forEach((l, i) => lines.push({ t: "+", n: startLine + i, s: l }));
  return lines;
}

// ---- tools -----------------------------------------------------------------

export const TOOLS = [
  {
    name: "read_file", kind: "read",
    description: "Read a text file. Returns numbered lines (`N\\tline`). Use offset/limit for large files. Always read a file before editing it.",
    parameters: { type: "object", properties: { path: { type: "string", description: "File path, relative to the project root or absolute" }, offset: { type: "integer", description: "1-based line to start at" }, limit: { type: "integer", description: "Max lines (default 2000)" } }, required: ["path"] },
    paths: (a) => [a.path],
    run(a, { cwd }) {
      const abs = resolveIn(cwd, a.path);
      const buf = fs.readFileSync(abs);
      if (isBinary(buf)) throw new Error("file looks binary; not shown");
      const all = buf.toString("utf8").replace(/\r\n/g, "\n").split("\n");
      const start = Math.max(1, a.offset || 1), lim = Math.max(1, Math.min(a.limit || 2000, 5000));
      const slice = all.slice(start - 1, start - 1 + lim);
      const body = slice.map((l, i) => `${start + i}\t${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`).join("\n");
      const more = start - 1 + lim < all.length ? `\n[file has ${all.length} lines; showing ${start}-${start + slice.length - 1}]` : "";
      return { content: clip(body + more) || "(empty file)", display: { title: `Read ${relOf(cwd, abs)}`, lines: [`${slice.length} lines`] } };
    },
  },
  {
    name: "write_file", kind: "edit",
    description: "Create a file or completely replace its contents. Prefer edit_file for changing existing files. For a large file (more than about 300 lines), write it in parts: the first part normally, then each further part with append=true.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, append: { type: "boolean", description: "Add content to the end of the file instead of replacing it" } }, required: ["path", "content"] },
    paths: (a) => [a.path],
    run(a, { cwd }) {
      const abs = resolveIn(cwd, a.path);
      const existed = fs.existsSync(abs);
      const content = String(a.content ?? "");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      let firstLine = 1;
      if (a.append && existed) {
        const prev = fs.readFileSync(abs, "utf8");
        firstLine = prev.split("\n").length; // the appended text starts on the file's last (possibly empty) line
        fs.appendFileSync(abs, content);
      } else fs.writeFileSync(abs, content);
      const n = content.split("\n").length;
      const rel = relOf(cwd, abs);
      const verb = a.append && existed ? "Append to" : existed ? "Overwrite" : "Create";
      const total = a.append && existed ? fs.readFileSync(abs, "utf8").split("\n").length : n;
      return {
        content: a.append && existed ? `Appended ${n} lines to ${rel} (now ${total} lines)` : `${existed ? "Overwrote" : "Created"} ${rel} (${n} lines)`,
        display: { title: `${verb} ${rel}`, diff: content.split("\n").slice(0, 40).map((s, i) => ({ t: "+", n: firstLine + i, s })), lines: n > 40 ? [`… ${n - 40} more lines`] : [] },
      };
    },
  },
  {
    name: "edit_file", kind: "edit",
    description: "Replace an exact string in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first.",
    parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_string", "new_string"] },
    paths: (a) => [a.path],
    run(a, { cwd }) {
      const abs = resolveIn(cwd, a.path);
      if (!fs.existsSync(abs)) throw new Error(`file not found: ${relOf(cwd, abs)} (use write_file to create it)`);
      let text = fs.readFileSync(abs, "utf8");
      let oldS = String(a.old_string), newS = String(a.new_string ?? "");
      if (!oldS) throw new Error("old_string is empty; use write_file to create or replace a whole file");
      // Windows files: let the model write \n while the file uses \r\n
      if (text.includes("\r\n") && !oldS.includes("\r\n")) { oldS = oldS.replace(/\n/g, "\r\n"); newS = newS.replace(/\n/g, "\r\n"); }
      let count = text.split(oldS).length - 1;
      let note = "";
      if (count === 0) {
        // Same lines apart from trailing spaces: safe to apply, using the file's real text.
        const loose = findLooseLines(text, oldS);
        if (loose.length !== 1) throw new Error(loose.length > 1 ? `old_string matches ${loose.length} places (ignoring trailing spaces); add more surrounding lines to make it unique` : notFoundHelp(text, oldS));
        oldS = text.slice(loose[0].start, loose[0].end);
        count = 1;
        note = " (matched ignoring trailing spaces)";
      }
      if (count > 1 && !a.replace_all) throw new Error(`old_string appears ${count} times; add more surrounding context to make it unique, or set replace_all`);
      const startLine = text.slice(0, text.indexOf(oldS)).split("\n").length;
      text = a.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
      fs.writeFileSync(abs, text);
      const norm = (s) => s.replace(/\r\n/g, "\n");
      return { content: `Edited ${relOf(cwd, abs)} (${a.replace_all ? count : 1} replacement${count > 1 && a.replace_all ? "s" : ""})${note}`, display: { title: `Edit ${relOf(cwd, abs)}`, diff: lineDiff(norm(oldS), norm(newS), startLine).slice(0, 60) } };
    },
  },
  {
    name: "list_dir", kind: "read",
    description: "List a directory (folders end with /).",
    parameters: { type: "object", properties: { path: { type: "string", description: "Directory, default the project root" } } },
    paths: (a) => [a.path || "."],
    run(a, { cwd }) {
      const abs = resolveIn(cwd, a.path || ".");
      const items = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.name !== ".git").sort((x, y) => (y.isDirectory() - x.isDirectory()) || x.name.localeCompare(y.name)).map((e) => e.name + (e.isDirectory() ? "/" : ""));
      return { content: clip(items.slice(0, 1000).join("\n") + (items.length > 1000 ? `\n[${items.length - 1000} more]` : "")) || "(empty)", display: { title: `List ${relOf(cwd, abs)}`, lines: [`${items.length} entries`] } };
    },
  },
  {
    name: "glob", kind: "read",
    description: "Find files by glob pattern, e.g. **/*.ts or src/**/test_*.py. Skips .git, node_modules and build folders.",
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "Folder to search, default the project root" } }, required: ["pattern"] },
    paths: (a) => [a.path || "."],
    run(a, { cwd }) {
      const root = resolveIn(cwd, a.path || ".");
      const re = globToRegex(a.pattern);
      const hits = [];
      walk(root, (f) => { const rel = path.relative(root, f).replace(/\\/g, "/"); if (re.test(rel)) hits.push(rel); if (hits.length >= 500) return false; });
      return { content: hits.length ? hits.sort().join("\n") + (hits.length >= 500 ? "\n[stopped at 500 results]" : "") : "no files matched", display: { title: `Glob ${a.pattern}`, lines: [`${hits.length} files`] } };
    },
  },
  {
    name: "grep", kind: "read",
    description: "Search file contents with a regular expression (JavaScript syntax). Returns path:line: text.",
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "File or folder, default the project root" }, glob: { type: "string", description: "Only files matching this glob, e.g. **/*.py" }, ignore_case: { type: "boolean" } }, required: ["pattern"] },
    paths: (a) => [a.path || "."],
    run(a, { cwd }) {
      const root = resolveIn(cwd, a.path || ".");
      let re;
      try { re = new RegExp(a.pattern, a.ignore_case ? "i" : ""); } catch (e) { throw new Error(`invalid regex: ${e.message}`); }
      const only = a.glob ? globToRegex(a.glob) : null;
      const hits = [];
      const scan = (f) => {
        const rel = path.relative(cwd, f).replace(/\\/g, "/") || path.basename(f);
        if (only && !only.test(path.relative(root, f).replace(/\\/g, "/"))) return;
        let buf; try { const st = fs.statSync(f); if (st.size > 1_000_000) return; buf = fs.readFileSync(f); } catch { return; }
        if (isBinary(buf)) return;
        const lines = buf.toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) { hits.push(`${rel}:${i + 1}: ${lines[i].slice(0, 300)}`); if (hits.length >= 300) return false; }
      };
      if (fs.statSync(root).isFile()) scan(root); else walk(root, scan);
      return { content: hits.length ? clip(hits.join("\n")) + (hits.length >= 300 ? "\n[stopped at 300 matches]" : "") : "no matches", display: { title: `Grep ${a.pattern}`, lines: [`${hits.length} matches`] } };
    },
  },
  {
    name: "bash", kind: "bash",
    description: "Run a shell command in the project root and return its combined stdout/stderr and exit code. Use for tests, builds, git, installing packages. Not for reading or editing files (use the file tools). Anything that keeps running (dev servers, `npm run dev`, `npx serve`, `python -m http.server`, watchers) MUST use background=true, otherwise it blocks until the timeout.",
    parameters: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "integer", description: "Default 120000, max 600000" }, background: { type: "boolean", description: "Start it and return after a few seconds with its first output; it keeps running. Check on it or stop it with the job tool." } }, required: ["command"] },
    paths: () => [],
    async run(a, { cwd, signal, onOutput }) {
      const cmd = String(a.command ?? "");
      const title = `Bash ${cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd}`;
      const shorten = (lines) => (lines.length > 12 ? [...lines.slice(0, 6), `… ${lines.length - 10} more lines`, ...lines.slice(-4)] : lines);
      if (a.background) {
        const job = startJob(cmd, cwd);
        // give it a moment to print its address or fail fast (port in use, missing command)
        const waitMs = 3000;
        await new Promise((res) => {
          const t0 = Date.now();
          const tick = setInterval(() => { if (!jobRunning(job) || Date.now() - t0 >= waitMs || signal?.aborted) { clearInterval(tick); res(); } }, 100);
        });
        const out = job.out.trim();
        const head = jobRunning(job)
          ? `Started in the background as job ${job.id} (pid ${job.pid}). It keeps running; use the job tool with id ${job.id} to see new output or stop it. Warden stops it when Warden exits.`
          : `Job ${job.id} exited right away (${job.exit}).`;
        return { content: clip(`${head}\nOutput so far:\n${out || "(none yet)"}`), display: { title: `${title} ${jobRunning(job) ? "(background)" : ""}`.trim(), lines: [...shorten(out ? out.split("\n") : []), jobRunning(job) ? `[running in the background as job ${job.id}]` : `[exited: ${job.exit}]`] }, isError: !jobRunning(job) && job.exit !== 0 };
      }
      const timeoutMs = Math.min(Math.max(a.timeout_ms || 120_000, 1000), 600_000);
      const r = await runShell(cmd, { cwd, timeoutMs, signal, onOutput });
      let status = r.killed === "timeout" ? `timed out after ${Math.round(timeoutMs / 1000)}s and was stopped` : r.killed === "interrupted" ? "interrupted by the user" : `exit code ${r.code}`;
      if (r.killed === "timeout") status += ". If this is a server or watcher, run it again with background=true";
      if (r.lingered) status += ". Note: it left a process running in the background that Warden does not track; next time use background=true for long-running commands";
      const out = r.out.trim();
      return { content: clip(`${out || "(no output)"}\n[${status}]`), display: { title, lines: [...shorten(out ? out.split("\n") : []), `[${status}]`] }, isError: r.code !== 0 || !!r.killed };
    },
  },
  {
    name: "job", kind: "read",
    description: "Check on commands started with bash background=true. With an id: its status and latest output; add stop=true to stop it. Without an id: list all jobs.",
    parameters: { type: "object", properties: { id: { type: "integer" }, stop: { type: "boolean" } } },
    paths: () => [],
    run(a) {
      if (a.id == null) {
        const all = listJobs();
        return { content: all.length ? all.map(describeJob).join("\n") : "No background jobs.", display: { title: "Jobs", lines: [`${all.length} job${all.length === 1 ? "" : "s"}`] } };
      }
      const j = JOBS.get(Number(a.id));
      if (!j) throw new Error(`no job ${a.id}. Jobs: ${listJobs().map((x) => x.id).join(", ") || "none"}`);
      if (a.stop) {
        const was = stopJob(j);
        return { content: was ? `Stopped job ${j.id}.` : `Job ${j.id} had already exited (${j.exit}).`, display: { title: `Stop job ${j.id}`, lines: [j.command] } };
      }
      return { content: `${describeJob(j)}\nLatest output:\n${tail(j.out.trim()) || "(none)"}`, display: { title: `Job ${j.id}`, lines: [describeJob(j)] } };
    },
  },
];

export const toolByName = (n) => TOOLS.find((t) => t.name === n);

// ---- permissions -----------------------------------------------------------
// modes: "ask" (edits and commands need approval), "auto-edit" (edits inside the project are automatic), "yolo" (everything automatic)
export const MODES = ["ask", "auto-edit", "yolo"];

export function needsApproval(tool, args, { cwd, mode, allowed }) {
  if (mode === "yolo") return false;
  const outside = (tool.paths?.(args) || []).some((p) => !isInside(cwd, resolveIn(cwd, p)));
  if (allowed.has(tool.name) && !outside) return false;
  if (tool.kind === "read") return outside;              // reading outside the project needs approval
  if (tool.kind === "edit") return mode !== "auto-edit" || outside;
  return true;                                             // bash
}

export function describeCall(tool, args, cwd) {
  if (!tool) return "unknown tool";
  if (tool.name === "bash") return `run: ${args.command}`;
  const p = args.path ? relOf(cwd, resolveIn(cwd, args.path)) : ".";
  return `${tool.name.replace("_", " ")} ${p}${tool.name === "grep" || tool.name === "glob" ? ` (${args.pattern})` : ""}`;
}
