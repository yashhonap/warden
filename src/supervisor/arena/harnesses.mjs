// Adapters that let the Arena run other coding-agent CLIs as subjects.
//
// Evidence level of each adapter (be honest about what was actually checked):
//   opencode  flags read from the installed `opencode run --help` (v2.2.4). Output schema NOT checked, so cost/tokens stay unknown.
//   pi        flags read from the installed `pi --help` (0.87.1). Same: cost/tokens unknown.
//   codex     flags and the --json event schema taken from OpenAI's docs. NOT installed here, never run. Model flag
//             (-m/--model) comes from third-party docs, not the official page.
//   gemini    deliberately NOT an adapter: its docs banner says the CLI was replaced by Antigravity CLI (June 2026) and
//             the model/approval flags could not be confirmed. Use a generic `command` subject instead (see README).
//
// The prompt is always passed as a single argv element and never through a shell, so quotes or `&` in a task prompt
// cannot be interpreted as commands. On Windows npm installs a .cmd shim; we resolve it to the real exe/js it launches.
import fs from "node:fs";
import path from "node:path";

export function resolveBin(name, env = process.env) {
  if (process.platform !== "win32") return { cmd: name, pre: [] };
  const exts = [".exe", ".cmd"];
  for (const dir of (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      if (!fs.existsSync(file)) continue;
      if (ext === ".exe") return { cmd: file, pre: [] };
      // npm shim: find the real target it launches
      const txt = fs.readFileSync(file, "utf8");
      const targets = [...txt.matchAll(/"%dp0%\\?([^"]+\.(?:exe|js))"/gi)].map((m) => path.join(dir, m[1]));
      const real = targets.at(-1);
      if (real && fs.existsSync(real)) return real.toLowerCase().endsWith(".js") ? { cmd: process.execPath, pre: [real] } : { cmd: real, pre: [] };
    }
  }
  return { cmd: name, pre: [] }; // not found: spawn will fail with a clear ENOENT
}

const extra = (s) => (Array.isArray(s.extraArgs) ? s.extraArgs.map(String) : []);

export const HARNESSES = {
  opencode: {
    bin: "opencode",
    evidence: "flags verified against installed --help; metrics unknown",
    risk: "opencode runs with --auto: ALL tool permissions (including shell commands) are auto-approved and nothing is sandboxed. It is started in the worktree, but nothing stops it from touching other paths.",
    build: (s, prompt) => ({
      // --standalone: private server per run so parallel runs don't share the background service
      args: ["run", "--auto", "--standalone", "--format", "json", ...(s.model ? ["--model", s.model] : []), ...extra(s), "--", prompt],
    }),
  },
  pi: {
    bin: "pi",
    evidence: "run live with Gemini models (works); tokens/cost/turns parsed from `--mode json` as observed; cost is pi's own estimate",
    risk: "pi is limited to read/edit/write tools (no shell) unless the subject sets `tools`. Your personal extensions and skills are disabled so runs are reproducible.",
    build: (s, prompt) => ({
      args: ["-p", "--no-session", "--no-extensions", "--no-skills", "--tools", Array.isArray(s.tools) ? s.tools.join(",") : "read,edit,write",
        "--mode", "json", ...(s.model ? ["--model", s.model] : []), ...extra(s), "--", prompt],
    }),
    // Schema observed from a real `pi --mode json` run (0.87.1, google provider): every model call ends with
    // {"type":"message_end","message":{"role":"assistant","usage":{"totalTokens":..,"cost":{"total":..}},"stopReason":..}}.
    // The cost is computed by pi from its own price list, not from a bill.
    parse: (stdout) => {
      let tokens = 0, cost = 0, turns = 0, err = null;
      for (const line of String(stdout).split("\n")) {
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        const m = ev.type === "message_end" ? ev.message : null;
        if (!m || m.role !== "assistant") continue;
        turns++;
        tokens += m.usage?.totalTokens ?? 0;
        cost += m.usage?.cost?.total ?? 0;
        if (m.stopReason === "error") err = m.errorMessage || "model call failed";
      }
      return turns ? { tokens, costUsd: cost, turns, error: err } : { tokens: null, costUsd: null, turns: null, error: null };
    },
  },
  codex: {
    bin: "codex",
    evidence: "from OpenAI docs; not installed here, never run",
    risk: "codex runs with --sandbox workspace-write (writes limited to the worktree, no network by default per Codex's sandbox).",
    build: (s, prompt) => ({
      args: ["exec", "--sandbox", "workspace-write", "--json", ...(s.model ? ["--model", s.model] : []), ...extra(s), prompt],
    }),
    // JSONL: turn.completed carries usage { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens } per docs
    parse: (stdout) => {
      let tokens = 0, seen = false, failed = null;
      for (const line of String(stdout).split("\n")) {
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "turn.completed" && ev.usage) { seen = true; tokens += (ev.usage.input_tokens ?? 0) + (ev.usage.output_tokens ?? 0); }
        if (ev.type === "turn.failed" || ev.type === "error") failed = ev.message || ev.error?.message || ev.type;
      }
      return { tokens: seen ? tokens : null, error: failed };
    },
  },
};

// Pull a readable message out of a failed run. Harnesses that stream JSON events (opencode --format json) bury the
// real error in a nested object; otherwise fall back to the tail of stderr/stdout.
export function friendlyError(stdout, stderr, code) {
  const messages = [];
  const walk = (v, depth = 0) => {
    if (!v || typeof v !== "object" || depth > 6) return;
    if (typeof v.message === "string" && v.message.trim()) messages.push(v.message.trim());
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  for (const line of String(stdout).split("\n")) { try { walk(JSON.parse(line)); } catch {} }
  const err = messages.filter((m) => /error|credit|quota|key|auth|denied|limit|rate|not found|invalid/i.test(m)).at(-1) || messages.at(-1);
  return `exit ${code}: ${(err || String(stderr).trim() || String(stdout).trim()).replace(/\s+/g, " ").slice(-240)}`;
}

export function describeHarness(kind) { return HARNESSES[kind] ? { evidence: HARNESSES[kind].evidence, risk: HARNESSES[kind].risk } : null; }

export function harnessCommand(subject, prompt) {
  const h = HARNESSES[subject.kind];
  if (!h) return null;
  const { cmd, pre } = resolveBin(h.bin);
  return { cmd, args: [...pre, ...h.build(subject, prompt).args], parse: h.parse };
}
