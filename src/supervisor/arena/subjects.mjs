// Subjects: the things being compared. Each runs a task inside an isolated worktree and
// returns { ok, error, durationMs, costUsd|null, tokens|null, turns|null }.
//   claude-code  Claude Code headless with --model (e.g. opus, sonnet, haiku, or a full model id)
//   command      any other harness/CLI: "cmd" template run in a shell inside the worktree.
//                The prompt arrives on stdin AND in env WARDEN_PROMPT (never interpolated into the
//                command line, so quoting can't break or inject). Example: "gemini -p \"$WARDEN_PROMPT\""
import { spawn } from "node:child_process";
import { harnessCommand, friendlyError } from "./harnesses.mjs";

function run(cmd, args, { cwd, input, timeoutMs, shell = false, env }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { cwd, shell, windowsHide: true, env: { ...process.env, ...env } });
    let out = "", err = "", killed = false;
    const timer = setTimeout(() => { killed = true; p.kill(); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message, ms: Date.now() - t0, killed }); });
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, ms: Date.now() - t0, killed }); });
    if (input != null) p.stdin.end(input); else p.stdin.end();
  });
}

export { run };

// Tools a subject may use. Bash is limited to the task's own check commands unless the task widens it.
export function defaultAllowedTools(task) {
  const bash = (task.checks || []).map((c) => `Bash(${c.cmd}:*)`);
  return task.allowedTools || ["Read", "Edit", "Write", "Glob", "Grep", ...bash];
}

export async function runSubject(subject, task, cwd, { timeoutMs = 600_000, maxUsd = 1 } = {}) {
  if (subject.kind === "claude-code") {
    const args = ["-p", "--output-format", "json", "--no-session-persistence", "--permission-mode", "acceptEdits",
      "--max-budget-usd", String(subject.maxUsd ?? maxUsd), "--allowedTools", ...defaultAllowedTools(task)];
    if (subject.model) args.push("--model", subject.model);
    const r = await run("claude", args, { cwd, input: task.prompt, timeoutMs });
    if (r.killed) return { ok: false, error: "timed out", durationMs: r.ms, costUsd: null, tokens: null, turns: null };
    let j;
    try { j = JSON.parse(r.out); } catch { return { ok: false, error: `bad output (exit ${r.code}): ${(r.err || r.out).slice(0, 200)}`, durationMs: r.ms, costUsd: null, tokens: null, turns: null }; }
    const u = j.usage || {};
    return {
      ok: !j.is_error, error: j.is_error ? String(j.result || "error").slice(0, 300) : null,
      durationMs: j.duration_ms ?? r.ms, costUsd: j.total_cost_usd ?? null,
      tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      turns: j.num_turns ?? null,
    };
  }
  if (subject.kind === "command") {
    if (!subject.cmd) return { ok: false, error: "command subject needs `cmd`", durationMs: 0, costUsd: null, tokens: null, turns: null };
    const r = await run(subject.cmd, [], { cwd, input: task.prompt, timeoutMs, shell: true, env: { WARDEN_PROMPT: task.prompt } });
    return { ok: r.code === 0 && !r.killed, error: r.killed ? "timed out" : r.code === 0 ? null : `exit ${r.code}: ${r.err.slice(0, 200)}`, durationMs: r.ms, costUsd: null, tokens: null, turns: null };
  }
  const hc = harnessCommand(subject, task.prompt);
  if (hc) {
    // argv only, no shell: the prompt is one argument and cannot be interpreted as commands
    const r = await run(hc.cmd, hc.args, { cwd, input: null, timeoutMs });
    if (r.code === -1) return { ok: false, error: `could not start ${subject.kind}: ${r.err} (is it installed and on PATH?)`, durationMs: r.ms, costUsd: null, tokens: null, turns: null };
    const parsed = hc.parse ? hc.parse(r.out) : {};
    const fail = r.killed ? "timed out" : r.code !== 0 ? friendlyError(r.out, r.err, r.code) : parsed.error || null;
    return { ok: !fail, error: fail, durationMs: r.ms, costUsd: parsed.costUsd ?? null, tokens: parsed.tokens ?? null, turns: parsed.turns ?? null };
  }
  return { ok: false, error: `unknown subject kind "${subject.kind}"`, durationMs: 0, costUsd: null, tokens: null, turns: null };
}
