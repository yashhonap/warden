#!/usr/bin/env node
// warden CLI: daemon | watch | sessions | replay <id> | diff <id>
import readline from "node:readline/promises";
import { startDaemon, PORT } from "./daemon.mjs";
import { loadConfig } from "./config.mjs";
import { ROLES, buildContext, estimate, planReviewers, runReviewers } from "./review.mjs";
import { resolveSpec } from "./providers.mjs";

import { openDb } from "./db.mjs";
import { loadTask, runArena, rank, leaderboard } from "./arena/arena.mjs";
import { pickJudges } from "./arena/judge.mjs";
import { defaultAllowedTools } from "./arena/subjects.mjs";
import { HARNESSES, describeHarness, resolveBin } from "./arena/harnesses.mjs";
import { execFileSync } from "node:child_process";

const s_tools = (task) => defaultAllowedTools(task).join(", ") + "  (claude-code subjects only)";
const fromRow = (r) => ({ subject: r.subject, model: r.model, ok: !!r.ok, error: r.error, checks: JSON.parse(r.checks || "[]"), checksPassed: !!r.checks_passed, judgeAvg: r.judge_avg, costUsd: r.cost_usd, durationMs: r.duration_ms, tokens: r.tokens, turns: r.turns, filesChanged: r.files_changed, linesAdded: r.lines_added, linesRemoved: r.lines_removed, human: r.human });

function printArena(runId, ranked, task) {
  const ms = (x) => (x == null ? "-" : x >= 60000 ? `${(x / 60000).toFixed(1)}m` : `${(x / 1000).toFixed(0)}s`);
  console.log(`\n${c.dim}run ${runId}  ${String(task.prompt || "").slice(0, 80)}${c.reset}`);
  console.log(`${"#".padEnd(3)}${"subject".padEnd(16)} ${"checks".padEnd(8)} ${"judge".padStart(6)} ${"cost".padStart(8)} ${"time".padStart(6)} ${"tokens".padStart(8)} ${"turns".padStart(5)} ${"files +/-".padStart(12)}`);
  ranked.forEach((r, i) => {
    if (!r.ok) r._unranked = true;
    const chk = !r.ok ? c.red + "ERROR" + c.reset : r.checksPassed ? c.green + "PASS" + c.reset : c.red + "FAIL" + c.reset;
    const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.replace(/\x1b\[[0-9;]*m/g, "").length));
    console.log(`${(r._unranked ? "-" : String(i + 1)).padEnd(3)}${r.subject.padEnd(16)} ${pad(chk, 8)} ${(r.judgeAvg == null ? "-" : r.judgeAvg.toFixed(1)).padStart(6)} ${(r.costUsd == null ? "?" : "$" + r.costUsd.toFixed(3)).padStart(8)} ${ms(r.durationMs).padStart(6)} ${String(r.tokens ?? "-").padStart(8)} ${String(r.turns ?? "-").padStart(5)} ${(`${r.filesChanged ?? "-"} +${r.linesAdded ?? 0}/-${r.linesRemoved ?? 0}`).padStart(12)}`);
    if (!r.ok) console.log(`   ${c.dim}${r.error}${c.reset}`);
  });
}

function printReport(r) {
  const vc = { pass: c.green, concerns: c.yellow, fail: c.red, error: c.red }[r.verdict] || "";
  console.log(`\n${vc}VERDICT: ${String(r.verdict).toUpperCase()}${c.reset}  ${c.dim}cost $${(r.cost_usd ?? 0).toFixed(3)}${r.cost_unknown_for?.length ? " + unpriced: " + r.cost_unknown_for.join(", ") : ""}${c.reset}`);
  for (const x of r.roles) console.log(`  ${x.ok ? "•" : "x"} ${x.role.padEnd(12)} ${x.ok ? x.verdict : "ERROR " + x.error}${x.summary ? c.dim + "  " + x.summary + c.reset : ""}`);
  for (const f of r.findings) {
    const sc = { high: c.red, medium: c.yellow, low: c.dim }[f.severity] || "";
    console.log(`\n  ${sc}[${f.severity}]${c.reset} ${f.file ?? ""}${f.line ? ":" + f.line : ""} ${c.dim}(${f.roles.join(", ")})${c.reset}\n    ${f.message}`);
  }
  if (!r.findings.length) console.log("\n  no findings");
}

const BASE = `http://127.0.0.1:${PORT}`;
const c = { dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", magenta: "\x1b[35m", red: "\x1b[31m", reset: "\x1b[0m" };
const col = { PreToolUse: c.cyan, PostToolUse: c.green, UserPromptSubmit: c.magenta, Stop: c.yellow, SubagentStop: c.yellow, Snapshot: c.dim };
const line = (e) =>
  `${c.dim}${new Date(e.ts).toLocaleTimeString()} ${String(e.session_id || "").slice(0, 8)}${c.reset} ` +
  `${col[e.type] || ""}${e.type.padEnd(16)}${c.reset} ${e.tool_name ? e.tool_name + " " : ""}${e.summary || ""}` +
  (e.duration_ms != null ? ` ${c.dim}${e.duration_ms}ms${c.reset}` : "");

async function get(path) {
  try { const r = await fetch(BASE + path); if (!r.ok) throw new Error(`${r.status}`); return await r.json(); }
  catch (err) { console.error(`${c.red}cannot reach daemon at ${BASE}${c.reset} (${err.message}). Start it: warden daemon`); process.exit(1); }
}
// resolve a session id prefix
async function resolveId(prefix) {
  const all = await get("/sessions");
  const hit = all.filter((s) => s.id.startsWith(prefix));
  if (hit.length !== 1) { console.error(hit.length ? "ambiguous id prefix" : "no such session"); process.exit(1); }
  return hit[0].id;
}

// Wrapped in a function (no top-level await) so the standalone build can bundle it.
async function main() {
const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "daemon":
    await startDaemon();
    break;
  case "watch": {
    const res = await fetch(BASE + "/stream").catch(() => null);
    if (!res) { console.error("daemon not running. Start it: warden daemon"); process.exit(1); }
    console.log(`${c.dim}watching ${BASE}/stream (ctrl+c to quit)${c.reset}`);
    const dec = new TextDecoder(); let buf = "";
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const msg = buf.slice(0, i); buf = buf.slice(i + 2);
        if (msg.startsWith("data: ")) console.log(line(JSON.parse(msg.slice(6))));
      }
    }
    break;
  }
  case "sessions": {
    for (const s of await get("/sessions")) {
      console.log(`${s.id.slice(0, 8)}  ${s.status.padEnd(8)} ${String(s.event_count).padStart(4)} events  ${new Date(s.started_at).toLocaleString()}  ${c.dim}${s.cwd}${c.reset}\n          ${c.dim}${(s.first_prompt || "").slice(0, 90)}${c.reset}`);
    }
    break;
  }
  case "replay": {
    if (!arg) { console.error("usage: warden replay <session-id-prefix>"); process.exit(1); }
    const id = await resolveId(arg);
    for (const e of await get(`/sessions/${id}/events`)) console.log(line({ ...e, session_id: id }));
    break;
  }
  case "diff": {
    if (!arg) { console.error("usage: warden diff <session-id-prefix>"); process.exit(1); }
    const snap = await get(`/sessions/${await resolveId(arg)}/snapshot`);
    console.log(`${c.dim}git status:${c.reset}\n${snap.git_status || "(clean or not a repo)"}\n${c.dim}git diff:${c.reset}\n${snap.git_diff || "(none)"}`);
    break;
  }
  case "review": {
    if (!arg) { console.error("usage: warden review <id> [--yes] [--roles a,b] [--with provider:model,provider:model]"); process.exit(1); }
    const flags = process.argv.slice(4);
    const flagVal = (n) => flags.find((f) => f.startsWith(`--${n}=`))?.slice(n.length + 3) ?? (flags.includes(`--${n}`) ? flags[flags.indexOf(`--${n}`) + 1] : null);
    const cfg = loadConfig();
    const rolesArg = flagVal("roles"), withArg = flagVal("with");
    const specs = planReviewers(cfg, { roles: rolesArg ? rolesArg.split(",") : null, withModels: withArg ? withArg.split(",") : null });
    const bad = specs.filter((s) => !ROLES[s.role]);
    if (bad.length) { console.error(`unknown role(s): ${bad.map((s) => s.role).join(", ")}. Available: ${Object.keys(ROLES).join(", ")}`); process.exit(1); }
    try { specs.forEach((s) => s.provider === "claude-cli" || resolveSpec(cfg, s.provider)); } catch (e) { console.error(e.message); process.exit(1); }
    if (cfg.mode === "observe") { console.error("mode is 'observe': reviews are disabled. Change mode in ~/.warden/config.json"); process.exit(1); }

    const id = await resolveId(arg);
    const [session, events, snap] = await Promise.all([get("/sessions").then((a) => a.find((s) => s.id === id)), get(`/sessions/${id}/events`), get(`/sessions/${id}/snapshot`)]);
    const ctx = buildContext(session, events, snap, cfg);
    const est = estimate(ctx, specs, cfg);
    const spent = (await get("/spend/today")).usd;
    // where the (redacted) context will actually be sent
    const dest = (p) => { if (p === "claude-cli") return "Anthropic via your Claude Code login"; try { return new URL(resolveSpec(cfg, p).baseUrl).host; } catch { return p; } };

    console.log(`\nReview proposal for session ${id.slice(0, 8)}  ${c.dim}${(session.first_prompt || "").slice(0, 70)}${c.reset}`);
    console.log(`  reviewers:`);
    for (const s of specs) console.log(`    ${s.label.padEnd(42)} ${c.dim}-> ${dest(s.provider)}${c.reset}`);
    console.log(`  sends:     ${ctx.length} chars (secrets redacted) to each destination above`);
    console.log(`  est. cost: ~$${est.usd}${est.unknown.length ? ` + UNKNOWN for ${est.unknown.length} reviewer(s) (no price configured)` : ""}  (today's spend $${spent.toFixed(3)} of $${cfg.maxUsdPerDay}; output capped at ${cfg.maxOutputTokens} tokens)`);
    if (spent + est.usd > cfg.maxUsdPerDay) { console.error(`${c.red}Refusing: would exceed the daily cap of $${cfg.maxUsdPerDay}.${c.reset}`); process.exit(1); }

    if (!flags.includes("--yes")) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ans = await rl.question("Approve and run? [y/N] "); rl.close();
      if (!/^y(es)?$/i.test(ans.trim())) { console.log("Cancelled. Nothing was sent."); break; }
    }
    const report = await runReviewers({ context: ctx, cfg, specs, onProgress: (r, s) => console.log(`${c.dim}  ${r}: ${s}${c.reset}`) });
    await fetch(BASE + "/reviews", { method: "POST", body: JSON.stringify({ session_id: id, ...report }) }).catch(() => {});
    printReport(report);
    break;
  }
  case "reviews": {
    if (!arg) { console.error("usage: warden reviews <id>"); process.exit(1); }
    for (const r of await get(`/sessions/${await resolveId(arg)}/reviews`)) { console.log(`\n${c.dim}${new Date(r.ts).toLocaleString()}${c.reset}`); printReport(JSON.parse(r.report)); }
    break;
  }
  case "harnesses": {
    // which agent CLIs can the Arena use on this machine?
    for (const [kind, h] of [["claude-code", { bin: "claude", evidence: "used by Warden itself" }], ...Object.entries(HARNESSES)]) {
      const { cmd, pre } = resolveBin(h.bin);
      let ver = null;
      try { ver = execFileSync(cmd, [...pre, "--version"], { encoding: "utf8", timeout: 15000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0]; } catch {}
      console.log(`${(ver ? c.green + "found    " : c.red + "missing  ") + c.reset}${kind.padEnd(12)} ${ver ? ver.padEnd(14) : "".padEnd(14)} ${c.dim}${h.evidence}${c.reset}`);
    }
    console.log(`${c.dim}gemini: no adapter (docs say Gemini CLI was replaced by Antigravity CLI; use a generic "command" subject).${c.reset}`);
    break;
  }
  case "arena": {
    const [, , , sub, a1, a2] = process.argv; // warden arena <sub> ...
    const flags = process.argv.slice(3);
    const db = openDb();
    const fmtMs = (ms) => (ms == null ? "-" : ms >= 60000 ? `${(ms / 60000).toFixed(1)}m` : `${(ms / 1000).toFixed(0)}s`);
    const fmtUsd = (u) => (u == null ? "?" : `$${u.toFixed(3)}`);
    if (sub === "run") {
      if (!a1) { console.error("usage: warden arena run <task.json> [--yes] [--keep]"); process.exit(1); }
      const cfg = loadConfig();
      const task = loadTask(a1);
      const judgeCfg = (task.judges || cfg.judges || []).map((j) => (typeof j === "string" ? { provider: j.split(":")[0], model: j.split(":").slice(1).join(":") || null } : j));
      const { used, warnings } = pickJudges(judgeCfg, task.subjects.map((s) => ({ subject: s.name, provider: s.kind === "claude-code" ? "claude-cli" : "", model: s.model })));
      const cap = task.maxUsdPerSubject ?? 1;
      console.log(`\nArena proposal: ${c.dim}${task.id}${c.reset}\n  task:      ${task.prompt.slice(0, 120)}`);
      console.log(`  repo:      ${task.repo}  (base ${task.base || "HEAD"}; each subject gets its own git worktree, your checkout is not touched)`);
      console.log(`  subjects:`);
      for (const s of task.subjects) {
        console.log(`    ${s.name.padEnd(16)} ${s.kind}${s.model ? " / " + s.model : ""}${s.cmd ? "  cmd: " + s.cmd : ""}${s.extraArgs?.length ? "  extra args: " + s.extraArgs.join(" ") : ""}`);
        const hd = describeHarness(s.kind);
        if (hd) console.log(`      ${c.yellow}${hd.risk}${c.reset}\n      ${c.dim}adapter status: ${hd.evidence}${c.reset}`);
      }
      console.log(`  tools:     ${s_tools(task)}`);
      console.log(`  checks run in each worktree after the subject finishes (commands from the task file):`);
      for (const k of task.checks) console.log(`    ${k.name || ""}: ${k.cmd}`);
      console.log(`  judges:    ${used.length ? used.map((j) => `${j.provider}:${j.model ?? "default"}`).join(", ") : "none"}  (blind, each run twice with the order swapped)`);
      for (const w of warnings) console.log(`  ${c.yellow}note: ${w}${c.reset}`);
      console.log(`  max spend: up to $${(cap * task.subjects.length).toFixed(2)} for subjects (${cap}/subject cap) + judging`);
      console.log(`  subjects run ${task.subjects.some((s) => s.kind === "command") ? c.yellow + "arbitrary commands from the task file (command subjects) " + c.reset : ""}with ${task.subjects.length} parallel agents, each editing files in its worktree.`);
      if (!flags.includes("--yes")) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ans = await rl.question("Approve and run? [y/N] "); rl.close();
        if (!/^y(es)?$/i.test(ans.trim())) { console.log("Cancelled. Nothing was run."); break; }
      }
      const out = await runArena({ task, db, cfg, keep: flags.includes("--keep"), onProgress: (n, s) => console.log(`${c.dim}  ${n}: ${s}${c.reset}`) });
      printArena(out.runId, out.ranked, task);
      for (const e of out.judgeErrors) console.log(`${c.yellow}judge error (${e.judge}): ${e.error}${c.reset}`);
      console.log(`\n${c.dim}saved as run ${out.runId}. Rate: warden arena rate ${out.runId} <subject> up|down${c.reset}`);
    } else if (sub === "board") {
      const rows = leaderboard(db, a1);
      if (!rows.length) { console.log("no arena runs yet"); break; }
      console.log(`\n${"subject".padEnd(16)} ${"runs".padStart(4)} ${"wins".padStart(5)} ${"checks".padStart(7)} ${"judge".padStart(6)} ${"avg cost".padStart(9)} ${"avg time".padStart(9)} ${"human".padStart(6)}`);
      for (const r of rows) console.log(`${r.subject.padEnd(16)} ${String(r.runs).padStart(4)} ${(r.winRate * 100).toFixed(0).padStart(4)}% ${(r.passRate * 100).toFixed(0).padStart(6)}% ${(r.judgeAvg == null ? "-" : r.judgeAvg.toFixed(1)).padStart(6)} ${fmtUsd(r.costAvg).padStart(9)} ${fmtMs(r.msAvg).padStart(9)} ${(r.human >= 0 ? "+" : "") + r.human}`.replace("NaN", "-"));
      console.log(`${c.dim}${rows[0].runs < 5 ? "Few runs so far: treat rankings as anecdotes, not evidence." : ""}${c.reset}`);
    } else if (sub === "show") {
      const run = db.prepare("SELECT * FROM arena_runs WHERE id LIKE ?").get(`${a1 || ""}%`);
      if (!run) { console.error("no such run"); process.exit(1); }
      const rows = db.prepare("SELECT * FROM arena_results WHERE run_id=?").all(run.id);
      printArena(run.id, rank(rows.map(fromRow)), { prompt: run.prompt });
    } else if (sub === "diff") {
      const row = db.prepare("SELECT diff FROM arena_results WHERE run_id LIKE ? AND subject=?").get(`${a1 || ""}%`, a2);
      console.log(row?.diff || "(no diff)");
    } else if (sub === "rate") {
      const val = { up: 1, down: -1 }[flags[3]];
      if (!a1 || !a2 || val == null) { console.error("usage: warden arena rate <runId> <subject> up|down"); process.exit(1); }
      const r = db.prepare("UPDATE arena_results SET human=? WHERE run_id LIKE ? AND subject=?").run(val, `${a1}%`, a2);
      console.log(r.changes ? "saved" : "no matching run/subject");
    } else {
      console.log("usage: warden arena <run <task.json> | board [taskId] | show <runId> | diff <runId> <subject> | rate <runId> <subject> up|down>");
    }
    db.close();
    break;
  }
  default:
    console.log("usage: warden <daemon | watch | sessions | replay <id> | diff <id> | review <id> | reviews <id> | arena ...>");
}
}

main().catch((e) => { console.error(`warden: ${e?.stack || e}`); process.exitCode = 1; });
