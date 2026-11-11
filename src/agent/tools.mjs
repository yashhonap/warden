// Coding tools the model can call. Each tool: { name, description, parameters (JSON schema), kind, run(args, ctx) }.
// kind drives permissions: "read" (free inside the project), "edit" (changes files), "bash" (runs commands).
// run() returns { content: string for the model, display: { title, lines?, diff? } for the terminal }.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

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

function runShell(command, { cwd, timeoutMs, signal }) {
  const sh = detectShell();
  return new Promise((resolve) => {
    const p = spawn(sh.cmd, sh.args(command), { cwd, windowsHide: true, env: { ...process.env, WARDEN: "1" } });
    let out = "", killed = null;
    const kill = (why) => { killed = why; try { p.kill(); } catch {} };
    const t = setTimeout(() => kill("timeout"), timeoutMs);
    const onAbort = () => kill("interrupted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const add = (d) => { if (out.length < MAX_OUT * 2) out += d; };
    p.stdout.on("data", add); p.stderr.on("data", add);
    p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out: `failed to start shell: ${e.message}`, killed }); });
    p.on("close", (code) => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); resolve({ code, out, killed }); });
    p.stdin.end();
  });
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
    description: "Create a file or completely replace its contents. Prefer edit_file for changing existing files.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    paths: (a) => [a.path],
    run(a, { cwd }) {
      const abs = resolveIn(cwd, a.path);
      const existed = fs.existsSync(abs);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, a.content ?? "");
      const n = String(a.content ?? "").split("\n").length;
      return { content: `${existed ? "Overwrote" : "Created"} ${relOf(cwd, abs)} (${n} lines)`, display: { title: `${existed ? "Overwrite" : "Create"} ${relOf(cwd, abs)}`, diff: String(a.content ?? "").split("\n").slice(0, 40).map((s, i) => ({ t: "+", n: i + 1, s })), lines: n > 40 ? [`… ${n - 40} more lines`] : [] } };
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
      const count = text.split(oldS).length - 1;
      if (count === 0) throw new Error("old_string was not found in the file. Re-read the file and copy the exact text, including whitespace.");
      if (count > 1 && !a.replace_all) throw new Error(`old_string appears ${count} times; add more surrounding context to make it unique, or set replace_all`);
      const startLine = text.slice(0, text.indexOf(oldS)).split("\n").length;
      text = a.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
      fs.writeFileSync(abs, text);
      const norm = (s) => s.replace(/\r\n/g, "\n");
      return { content: `Edited ${relOf(cwd, abs)} (${a.replace_all ? count : 1} replacement${count > 1 && a.replace_all ? "s" : ""})`, display: { title: `Edit ${relOf(cwd, abs)}`, diff: lineDiff(norm(oldS), norm(newS), startLine).slice(0, 60) } };
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
    description: "Run a shell command in the project root and return its combined stdout/stderr and exit code. Use for tests, builds, git, installing packages. Not for reading or editing files (use the file tools).",
    parameters: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "integer", description: "Default 120000, max 600000" } }, required: ["command"] },
    paths: () => [],
    async run(a, { cwd, signal }) {
      const timeoutMs = Math.min(Math.max(a.timeout_ms || 120_000, 1000), 600_000);
      const r = await runShell(String(a.command), { cwd, timeoutMs, signal });
      const status = r.killed === "timeout" ? `timed out after ${timeoutMs} ms` : r.killed === "interrupted" ? "interrupted by the user" : `exit code ${r.code}`;
      const out = r.out.trim();
      const lines = out ? out.split("\n") : [];
      const shown = lines.length > 12 ? [...lines.slice(0, 6), `… ${lines.length - 10} more lines`, ...lines.slice(-4)] : lines;
      return { content: clip(`${out || "(no output)"}\n[${status}]`), display: { title: `Bash ${a.command.length > 80 ? a.command.slice(0, 80) + "…" : a.command}`, lines: [...shown, `[${status}]`] }, isError: r.code !== 0 };
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
