// Offline test of the harness adapters using fake CLIs (no network, no real agents).
// Run: node test/harnesses.mock.mjs     (Windows: npm-shim style .cmd files; elsewhere plain scripts)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolveBin, harnessCommand, HARNESSES } from "../src/supervisor/arena/harnesses.mjs";
import { runSubject } from "../src/supervisor/arena/subjects.mjs";
import { loadTask, runArena } from "../src/supervisor/arena/arena.mjs";
import { openDb } from "../src/supervisor/db.mjs";

if (process.platform !== "win32") { console.log("harnesses.mock: skipped (shim resolution is Windows-specific)"); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "warden-harness-test-"));
const bin = path.join(tmp, "bin"); fs.mkdirSync(path.join(bin, "node_modules", "pi-fake", "dist"), { recursive: true });
const argvLog = path.join(tmp, "argv.json");

// fake `pi`: records its argv, then "fixes" add.mjs in cwd (the prompt is the arg after `--`)
fs.writeFileSync(path.join(bin, "node_modules", "pi-fake", "dist", "cli.js"), `
const fs=require("fs");
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
if (process.argv.includes("--crash")) process.exit(9);
fs.writeFileSync("add.mjs","export const add = (a, b) => a + b;\\n");
`);
// shim in the same format npm generates for a node CLI
fs.writeFileSync(path.join(bin, "pi.cmd"), `@ECHO off
SETLOCAL
CALL :find_dp0
"%_prog%"  "%dp0%\\node_modules\\pi-fake\\dist\\cli.js" %*
`);
// fake `codex`: emits documented JSONL events, edits the file
fs.mkdirSync(path.join(bin, "node_modules", "codex-fake"), { recursive: true });
fs.writeFileSync(path.join(bin, "node_modules", "codex-fake", "cli.js"), `
const fs=require("fs");
fs.writeFileSync(${JSON.stringify(argvLog + ".codex")}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync("add.mjs","export const add = (a, b) => a + b;\\n");
console.log(JSON.stringify({type:"thread.started"}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1000,cached_input_tokens:200,output_tokens:150,reasoning_output_tokens:50}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:500,output_tokens:50}}));
`);
fs.writeFileSync(path.join(bin, "codex.cmd"), `@ECHO off
"%dp0%\\node_modules\\codex-fake\\cli.js" %*
`.replace('"%dp0%\\node_modules\\codex-fake\\cli.js"', '"node"  "%dp0%\\node_modules\\codex-fake\\cli.js"'));
process.env.PATH = bin + path.delimiter + process.env.PATH;

// 1. shim resolution: node-js shim -> node + script path; real npm shims on this machine resolve to an existing target
const r = resolveBin("pi");
assert.equal(r.cmd, process.execPath);
assert.ok(r.pre[0].endsWith(path.join("pi-fake", "dist", "cli.js")) && fs.existsSync(r.pre[0]));
assert.deepEqual(resolveBin("definitely-not-installed-xyz"), { cmd: "definitely-not-installed-xyz", pre: [] });

// 2. hostile prompt reaches the CLI as exactly ONE argument, untouched (no shell involved)
const hostile = `fix it"; & calc.exe && echo pwned | more\n  second "line" 'x' %PATH% $(id) \`id\``;
const repo = path.join(tmp, "repo"); fs.mkdirSync(repo);
const g = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
g("init", "-q");
fs.writeFileSync(path.join(repo, "add.mjs"), "export const add = (a, b) => a - b;\n");
fs.writeFileSync(path.join(repo, "test.mjs"), 'import { add } from "./add.mjs"; import assert from "node:assert"; assert.equal(add(2, 3), 5);\n');
g("add", "-A"); g("commit", "-qm", "init");

const piSubject = { name: "pi-a", kind: "pi", model: "anthropic/some-model" };
const res = await runSubject(piSubject, { prompt: hostile, checks: [] }, repo, { timeoutMs: 30000 });
assert.equal(res.ok, true, res.error);
const argv = JSON.parse(fs.readFileSync(argvLog, "utf8"));
assert.equal(argv.at(-1), hostile, "prompt must arrive intact as a single argument");
assert.equal(argv.at(-2), "--", "prompt must come after -- so a leading dash can't become a flag");
assert.deepEqual(argv.slice(0, 9), ["-p", "--no-session", "--no-extensions", "--no-skills", "--tools", "read,edit,write", "--mode", "json", "--model"]);
assert.ok(!fs.existsSync(path.join(repo, "pwned")) );
g("checkout", "--", ".");

// 3. exit code failure is reported, with a clear error
const crash = await runSubject({ name: "c", kind: "pi", extraArgs: ["--crash"] }, { prompt: "x", checks: [] }, repo, { timeoutMs: 30000 });
assert.equal(crash.ok, false); assert.match(crash.error, /exit 9/);

// 4. missing binary gives an actionable error, not a crash
const missing = harnessCommand({ kind: "opencode" }, "p");
assert.ok(missing.args.includes("--standalone") && missing.args.includes("--auto"));
const saved = process.env.PATH; process.env.PATH = path.join(tmp, "empty");
const nobin = await runSubject({ name: "o", kind: "opencode" }, { prompt: "x", checks: [] }, repo, { timeoutMs: 10000 });
process.env.PATH = saved;
assert.equal(nobin.ok, false); assert.match(nobin.error, /could not start opencode/);

// 5. codex: tokens summed from documented turn.completed usage events, argv shape
const cx = await runSubject({ name: "cx", kind: "codex", model: "some-model" }, { prompt: "do it", checks: [] }, repo, { timeoutMs: 30000 });
assert.equal(cx.ok, true, cx.error);
assert.equal(cx.tokens, 1000 + 150 + 500 + 50);
const cxArgv = JSON.parse(fs.readFileSync(argvLog + ".codex", "utf8"));
assert.deepEqual(cxArgv, ["exec", "--sandbox", "workspace-write", "--json", "--model", "some-model", "do it"]);
assert.deepEqual(HARNESSES.codex.parse('{"type":"turn.failed","error":{"message":"boom"}}\nnot json'), { tokens: null, error: "boom" });
g("checkout", "--", ".");

// 5b. pi parser on the message_end shape observed from a real run: sums usage over assistant messages only
const piLines = [
  { type: "message_end", message: { role: "user", content: [] } },
  { type: "message_end", message: { role: "assistant", usage: { totalTokens: 500, cost: { total: 0.000057 } }, stopReason: "toolUse" } },
  { type: "message_update", usage: { totalTokens: 9999, cost: { total: 9 } } },
  { type: "message_end", message: { role: "assistant", usage: { totalTokens: 700, cost: { total: 0.0001 } }, stopReason: "stop" } },
].map((e) => JSON.stringify(e)).join("\n");
const pp = HARNESSES.pi.parse(piLines);
assert.equal(pp.tokens, 1200); assert.equal(pp.turns, 2); assert.ok(Math.abs(pp.costUsd - 0.000157) < 1e-12); assert.equal(pp.error, null);
assert.equal(HARNESSES.pi.parse("plain text, no json").tokens, null);

// 6. end to end: a `pi` subject inside a real arena run (worktree, check command, diff stats, cleanup)
fs.writeFileSync(path.join(tmp, "task.json"), JSON.stringify({
  id: "harness-e2e", prompt: "add() is broken. Fix it.", repo, checks: [{ name: "tests", cmd: "node test.mjs" }],
  subjects: [{ name: "pi-fake", kind: "pi" }, { name: "codex-fake", kind: "codex" }],
}));
process.env.WARDEN_HOME = path.join(tmp, "home");
const db = openDb();
const out = await runArena({ task: loadTask(path.join(tmp, "task.json")), db, cfg: { judges: [] } });
for (const r of out.ranked) { assert.equal(r.ok, true, r.error); assert.equal(r.checksPassed, true); assert.equal(r.filesChanged, 1); }
assert.equal(fs.readFileSync(path.join(repo, "add.mjs"), "utf8").split("\r").join(""), "export const add = (a, b) => a - b;\n", "main checkout untouched");
assert.equal(g("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
db.close();

console.log("harnesses.mock: all assertions passed");
