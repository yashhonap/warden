// Offline arena test: real git worktrees + real check commands, scripted "agents", mock judge.
// Run: node test/arena.mock.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { loadTask, runArena, leaderboard } from "../src/supervisor/arena/arena.mjs";
import { pickJudges } from "../src/supervisor/arena/judge.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "warden-arena-test-"));
const repo = path.join(tmp, "repo"); fs.mkdirSync(repo);
const g = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
g("init", "-q");
fs.writeFileSync(path.join(repo, "add.mjs"), "export const add = (a, b) => a - b;\n");
fs.writeFileSync(path.join(repo, "test.mjs"), 'import { add } from "./add.mjs"; import assert from "node:assert"; assert.equal(add(2, 3), 5); assert.equal(add(-1, 1), 0);\n');
g("add", "-A"); g("commit", "-qm", "init");

// scripted agents (stand-ins for real harnesses)
const scripts = {
  good:  'require("fs").writeFileSync("add.mjs","export const add = (a, b) => a + b;\\n")',
  noisy: 'const fs=require("fs");fs.writeFileSync("add.mjs","export const add = (a, b) => a + b;\\n");fs.writeFileSync("unrelated.txt","x\\n".repeat(40))',
  wrong: 'require("fs").writeFileSync("add.mjs","export const add = (a, b) => a * b;\\n")',
  crash: "process.exit(3)",
};
const subjects = Object.keys(scripts).map((name) => {
  const f = path.join(tmp, `${name}.cjs`); fs.writeFileSync(f, scripts[name]);
  return { name, kind: "command", model: `model-${name}`, cmd: `node "${f}"` };
});

const taskFile = path.join(tmp, "task.json");
fs.writeFileSync(taskFile, JSON.stringify({ id: "fix-add", prompt: "add() is broken. Fix it.", repo, checks: [{ name: "tests", cmd: "node test.mjs" }], subjects }));
const task = loadTask(taskFile);

// mock judge: records prompts; scores PASS candidates high, smaller diffs higher
const judgePrompts = [];
const judgeProvider = () => ({
  complete: async ({ prompt }) => {
    judgePrompts.push(prompt);
    const scores = {};
    for (const m of prompt.matchAll(/## Candidate ([A-Z])\nChecks: ([^\n]*)\n([\s\S]*?)(?=\n## Candidate|$)/g)) {
      const pass = /tests: PASS/.test(m[2]); const lines = (m[3].match(/\n\+/g) || []).length;
      scores[m[1]] = pass ? Math.max(5, 9 - Math.floor(lines / 20)) : 2;
    }
    return { text: JSON.stringify({ scores, notes: {} }), costUsd: 0 };
  },
});

const { openDb } = await import("../src/supervisor/db.mjs");
const realDb = openDb(path.join(tmp, "t.db"));

const out = await runArena({
  task, db: realDb, cfg: { judges: ["claude-cli"] }, rng: (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })(),
  judgeProvider,
});
const by = Object.fromEntries(out.ranked.map((r) => [r.subject, r]));

// 1. objective signals measured in isolated worktrees
assert.equal(by.good.checksPassed, true);
assert.equal(by.noisy.checksPassed, true);
assert.equal(by.wrong.checksPassed, false);
assert.equal(by.crash.ok, false);
assert.equal(by.good.filesChanged, 1);
assert.equal(by.noisy.filesChanged, 2);
assert.ok(by.noisy.linesAdded > by.good.linesAdded);

// 2. your real checkout was never touched, and worktrees were cleaned up
assert.equal(fs.readFileSync(path.join(repo, "add.mjs"), "utf8"), "export const add = (a, b) => a - b;\n");
assert.equal(g("status", "--porcelain").trim(), "");
assert.equal(g("worktree", "list", "--porcelain").split("worktree ").length - 1, 1, "extra worktrees left behind");

// 3. judging is blind (no subject or model names) and position-swapped (2 calls per judge)
assert.ok(judgePrompts.length >= 2 && judgePrompts.length % 2 === 0);
for (const p of judgePrompts) for (const s of subjects) assert.ok(!p.includes(`model-${s.name}`) && !p.includes(`Candidate ${s.name}`));
const first = [...judgePrompts[0].matchAll(/## Candidate ([A-Z])\nChecks: (\S+: \w+)/g)].map((m) => m[2]).join("|");
const second = [...judgePrompts[1].matchAll(/## Candidate ([A-Z])\nChecks: (\S+: \w+)/g)].map((m) => m[2]).join("|");
assert.equal(first.split("|").reverse().join("|"), second, "second pass must be the reverse order");

// 4. ranking: passing + minimal diff first; failing checks below; errored last
assert.deepEqual(out.ranked.map((r) => r.subject), ["good", "noisy", "wrong", "crash"]);
assert.ok(by.good.judgeAvg > by.wrong.judgeAvg);

// 5. persistence + leaderboard
const lb = leaderboard(realDb);
assert.equal(lb[0].subject, "good"); assert.equal(lb[0].wins, 1); assert.equal(lb.length, 4);

// 6. judge independence rules
const pj = pickJudges([{ provider: "claude-cli", model: "opus" }, { provider: "gemini", model: "g1" }], [{ subject: "a", provider: "claude-cli", model: "opus" }]);
assert.deepEqual(pj.used.map((j) => j.provider), ["gemini"]);
assert.ok(pj.warnings.some((w) => /excluded/.test(w)));
const pj2 = pickJudges([{ provider: "claude-cli", model: "sonnet" }], [{ subject: "a", provider: "claude-cli", model: "opus" }]);
assert.equal(pj2.used.length, 1); assert.ok(pj2.warnings.some((w) => /self-preference/.test(w)));

realDb.close();
console.log("arena.mock: all assertions passed");
