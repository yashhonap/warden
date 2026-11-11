// Arena: same task x N subjects, each in its own git worktree from the same base commit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runSubject, run } from "./subjects.mjs";
import { judgePanel, pickJudges } from "./judge.mjs";

const git = (cwd, args, opts = {}) => run("git", args, { cwd, timeoutMs: 120_000, ...opts });

export function loadTask(file) {
  const t = JSON.parse(fs.readFileSync(file, "utf8"));
  const dir = path.dirname(path.resolve(file));
  if (!t.id || !t.prompt || !Array.isArray(t.subjects) || t.subjects.length < 2) throw new Error("task needs id, prompt and at least 2 subjects");
  const names = t.subjects.map((s) => s.name);
  if (new Set(names).size !== names.length) throw new Error("subject names must be unique");
  t.repo = path.resolve(dir, t.repo || ".");
  t.checks = t.checks || [];
  return t;
}

export async function setupWorktree(task, runId, subject) {
  const base = task.base || "HEAD";
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `warden-arena-${runId}-`)), subject.name.replace(/[^\w.-]/g, "_"));
  const r = await git(task.repo, ["worktree", "add", "--detach", dir, base]);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.err.slice(0, 200)}`);
  return dir;
}

export async function removeWorktree(task, dir) {
  await git(task.repo, ["worktree", "remove", "--force", dir]);
  try { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); } catch {}
}

async function runChecks(task, cwd) {
  const out = [];
  for (const c of task.checks) {
    const r = await run(c.cmd, [], { cwd, shell: true, timeoutMs: c.timeoutMs || 180_000 });
    out.push({ name: c.name || c.cmd, pass: r.code === 0 && !r.killed, ms: r.ms });
  }
  return out;
}

async function diffStats(cwd, base) {
  await git(cwd, ["add", "-A"]);
  const d = await git(cwd, ["diff", "--cached", base], { timeoutMs: 120_000 });
  const n = await git(cwd, ["diff", "--cached", "--numstat", base]);
  let added = 0, removed = 0, files = 0;
  for (const l of n.out.split("\n").filter(Boolean)) { const [a, r] = l.split("\t"); files++; added += Number(a) || 0; removed += Number(r) || 0; }
  return { diff: d.out, files, added, removed };
}

// Measure one subject end to end.
export async function evaluateSubject(task, runId, subject, { keep = false, timeoutMs, maxUsd } = {}) {
  let dir;
  const res = { subject: subject.name, model: subject.model ?? null, provider: subject.kind === "claude-code" ? "claude-cli" : "", checks: [] };
  try {
    dir = await setupWorktree(task, runId, subject);
    const base = (await git(dir, ["rev-parse", "HEAD"])).out.trim();
    Object.assign(res, await runSubject(subject, task, dir, { timeoutMs, maxUsd }));
    res.checks = await runChecks(task, dir);
    Object.assign(res, await diffStats(dir, base).then((s) => ({ diff: s.diff, filesChanged: s.files, linesAdded: s.added, linesRemoved: s.removed })));
  } catch (err) {
    res.ok = false; res.error = err.message;
  } finally {
    if (dir && !keep) await removeWorktree(task, dir);
    else if (dir) res.worktree = dir;
  }
  res.checksPassed = res.checks.length > 0 && res.checks.every((c) => c.pass);
  return res;
}

async function pool(items, limit, fn) {
  const results = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

// Ranking: passing every check beats failing; then judge score; then cheaper; then faster. Fully visible, no hidden weights.
export function rank(results) {
  const key = (r) => [r.ok ? 1 : 0, r.checksPassed ? 1 : 0, r.judgeAvg ?? -1, -(r.costUsd ?? Infinity), -(r.durationMs ?? Infinity)];
  return results.slice().sort((a, b) => { const ka = key(a), kb = key(b); for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i]; return 0; });
}

export async function runArena({ task, db, cfg, keep = false, concurrency = 3, rng, judgeProvider, onProgress = () => {} }) {
  const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12) + "-" + crypto.randomBytes(2).toString("hex");
  const results = await pool(task.subjects, concurrency, async (s) => {
    onProgress(s.name, "running");
    const r = await evaluateSubject(task, runId, s, { keep, timeoutMs: task.timeoutMs, maxUsd: task.maxUsdPerSubject });
    onProgress(s.name, r.ok ? (r.checksPassed ? "done, checks pass" : "done, checks FAIL") : `error: ${r.error}`);
    return r;
  });

  // Blind judging
  const judgeCfg = (task.judges || cfg.judges || []).map((j) => (typeof j === "string" ? { provider: j.split(":")[0], model: j.split(":").slice(1).join(":") || null } : j));
  const contestants = task.subjects.map((s) => ({ subject: s.name, provider: s.kind === "claude-code" ? "claude-cli" : "", model: s.model }));
  const { used, warnings } = pickJudges(judgeCfg, contestants);
  // Only judge subjects that actually finished: errored ones have nothing to compare, and judging costs money.
  // A blind comparison also needs at least two candidates.
  const finished = results.filter((r) => r.ok);
  const doJudge = used.length > 0 && finished.length >= 2;
  onProgress("judges", doJudge ? `${used.length} judge(s), blind, position-swapped` : finished.length < 2 ? "skipped (fewer than 2 subjects finished)" : "none");
  const panel = doJudge
    ? await judgePanel({ task, candidates: finished.map((r) => ({ subject: r.subject, diff: r.diff, checks: r.checks, ok: r.ok })), judges: used, cfg, rng, ...(judgeProvider ? { provider: judgeProvider } : {}) })
    : { scores: {}, detail: [] };
  for (const r of results) r.judgeAvg = panel.scores[r.subject] ?? null;

  const ranked = rank(results);
  db.prepare("INSERT INTO arena_runs (id, ts, task_id, prompt, repo, base, judges) VALUES (?,?,?,?,?,?,?)")
    .run(runId, Date.now(), task.id, task.prompt, task.repo, task.base || "HEAD", JSON.stringify({ used, warnings }));
  const ins = db.prepare(`INSERT INTO arena_results (run_id, subject, model, ok, error, duration_ms, cost_usd, tokens, turns, checks, checks_passed,
    files_changed, lines_added, lines_removed, diff, judge_avg, judge_detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of results) {
    ins.run(runId, r.subject, r.model, r.ok ? 1 : 0, r.error ?? null, r.durationMs ?? null, r.costUsd ?? null, r.tokens ?? null, r.turns ?? null,
      JSON.stringify(r.checks), r.checksPassed ? 1 : 0, r.filesChanged ?? null, r.linesAdded ?? null, r.linesRemoved ?? null, r.diff ?? null,
      r.judgeAvg, JSON.stringify(panel.detail.filter((d) => d.scores?.[r.subject] != null || d.error).map((d) => ({ judge: d.judge, order: d.order, score: d.scores?.[r.subject], note: d.notes?.[r.subject], error: d.error }))));
  }
  return { runId, ranked, warnings, judgeErrors: panel.detail.filter((d) => d.error) };
}

// Cross-run leaderboard per subject: wins (rank 1), runs, pass rate, avg judge, avg cost, human votes.
export function leaderboard(db, taskId) {
  const runs = db.prepare(`SELECT id FROM arena_runs ${taskId ? "WHERE task_id=?" : ""} ORDER BY ts`).all(...(taskId ? [taskId] : []));
  const stats = new Map();
  for (const { id } of runs) {
    const rows = db.prepare("SELECT * FROM arena_results WHERE run_id=?").all(id);
    const ranked = rank(rows.map((r) => ({ ...r, ok: !!r.ok, checksPassed: !!r.checks_passed, judgeAvg: r.judge_avg, costUsd: r.cost_usd, durationMs: r.duration_ms })));
    ranked.forEach((r, i) => {
      const s = stats.get(r.subject) || { subject: r.subject, model: r.model, runs: 0, wins: 0, passes: 0, judge: [], cost: [], ms: [], human: 0 };
      s.runs++; if (i === 0) s.wins++; if (r.checksPassed) s.passes++;
      if (r.judgeAvg != null) s.judge.push(r.judgeAvg); if (r.costUsd != null) s.cost.push(r.costUsd); if (r.durationMs != null) s.ms.push(r.durationMs);
      s.human += r.human ?? 0; stats.set(r.subject, s);
    });
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return [...stats.values()].map((s) => ({ ...s, winRate: s.wins / s.runs, passRate: s.passes / s.runs, judgeAvg: avg(s.judge), costAvg: avg(s.cost), msAvg: avg(s.ms) }))
    .sort((a, b) => b.winRate - a.winRate || b.passRate - a.passRate || (b.judgeAvg ?? 0) - (a.judgeAvg ?? 0));
}
