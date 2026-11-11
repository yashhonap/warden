// Fills a Warden home with FAKE demo data (clearly labelled) so the dashboard can be viewed.
// Usage: WARDEN_HOME=<dir> node test/seed-demo.mjs   (daemon must be running on WARDEN_PORT, default 7777)
// Includes hostile strings on purpose: the dashboard must render them as plain text.
import path from "node:path";
import { openDb } from "../src/supervisor/db.mjs";

const BASE = `http://127.0.0.1:${process.env.WARDEN_PORT || 7777}`;
const cwd = path.resolve(import.meta.dirname, "../../warden-spike/scratch-project");
const post = (p, o) => fetch(BASE + p, { method: "POST", body: JSON.stringify(o) });
const XSS = `<img src=x onerror="document.title='PWNED'"><script>document.title='PWNED'</script>`;

const sid = "demo0001-seeded-session";
for (const e of [
  { hook_event_name: "UserPromptSubmit", prompt: `DEMO: calc.py has a bug in add(). Fix it. ${XSS}` },
  { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "calc.py" } },
  { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "calc.py" }, duration_ms: 31 },
  { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `echo ${XSS}` } },
  { hook_event_name: "Stop", last_assistant_message: "Fixed add() and all tests pass." },
]) await post("/event", { session_id: sid, cwd, ...e });
await post("/reviews", {
  session_id: sid, verdict: "fail", cost_usd: 0.06, cost_unknown_for: [],
  roles: [{ role: "correctness@claude-cli", ok: true, verdict: "fail", summary: "add() still wrong" }, { role: "security@claude-cli", ok: true, verdict: "concerns", summary: `hardcoded key ${XSS}` }],
  findings: [{ severity: "high", file: "calc.py", line: 2, message: "DEMO: add() returns a * b, not a + b.", roles: ["correctness@claude-cli", "security@claude-cli"] },
    { severity: "medium", file: "client.py", line: 4, message: "DEMO: os.system with unvalidated input.", roles: ["security@claude-cli"] }],
});

const db = openDb();
const rid = "202611111400-demo";
db.prepare("INSERT OR REPLACE INTO arena_runs (id, ts, task_id, prompt, repo, base, judges) VALUES (?,?,?,?,?,?,?)")
  .run(rid, Date.now() - 3600e3, "demo-seed", "DEMO DATA: fix slugify() so test.mjs passes", "demo", "HEAD", JSON.stringify({ used: [{ provider: "claude-cli", model: null }], warnings: ["judge claude-cli:default shares a vendor with a contestant: possible self-preference bias"] }));
const ins = db.prepare(`INSERT INTO arena_results (run_id, subject, model, ok, error, duration_ms, cost_usd, tokens, turns, checks, checks_passed, files_changed, lines_added, lines_removed, diff, judge_avg, judge_detail)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const diff = "diff --git a/slug.mjs b/slug.mjs\n--- a/slug.mjs\n+++ b/slug.mjs\n@@ -1,4 +1,9 @@\n export function slugify(s) {\n-  return s.toLowerCase().replace(/ /g, \"-\");\n+  return s.normalize(\"NFD\").replace(/[\\u0300-\\u036f]/g, \"\")\n+    .toLowerCase().replace(/[^a-z0-9]+/g, \"-\").replace(/^-+|-+$/g, \"\");\n }\n";
const chk = (p) => JSON.stringify([{ name: "tests", pass: p, ms: 90 }]);
const jd = (sc, note) => JSON.stringify([{ judge: "claude-cli:default", order: 0, score: sc, note }, { judge: "claude-cli:default", order: 1, score: sc, note }]);
ins.run(rid, "sonnet", "sonnet", 1, null, 84000, 0.161, 416414, 10, chk(true), 1, 1, 6, 1, diff, 8.0, jd(8, "Minimal and correct. " + XSS));
ins.run(rid, "opus", "opus", 1, null, 29000, 0.311, 312900, 11, chk(true), 1, 1, 6, 1, diff, 8.0, jd(8, "Same approach, NFKD."));
ins.run(rid, "haiku", "haiku", 1, null, 17000, 0.007, 155009, 6, chk(false), 0, 0, 0, 0, "", 1.0, jd(1, "Made no changes."));
db.close();
console.log("seeded demo data (session demo0001, arena run " + rid + ")");
