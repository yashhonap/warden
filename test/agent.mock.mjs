// Offline test of the Warden agent: a mock OpenAI-compatible server that streams tool calls, the real tools on a temp
// project, permissions, retries, interrupts, and the terminal app driven through a pipe. No network, no keys.
// Run: node test/agent.mock.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "warden-agent-test-"));
process.env.WARDEN_HOME = path.join(tmp, "home");
const { runTurn, trimContext } = await import("../src/agent/loop.mjs");
const { Session } = await import("../src/agent/session.mjs");
const { toAnthropic, chat } = await import("../src/agent/providers.mjs");
const { TOOLS, toolByName, needsApproval, globToRegex } = await import("../src/agent/tools.mjs");

// ---------- mock model server ----------
const requests = [];
let script = null; // (body, n) => array of SSE chunk objects, or {status, headers, body}
const server = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", async () => {
    const body = JSON.parse(b || "{}");
    requests.push({ url: req.url, auth: req.headers.authorization, body });
    const out = script(body, requests.length);
    if (out.status) { res.writeHead(out.status, out.headers || {}); return res.end(out.body || ""); }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const ch of out) {
      if (ch.delay) { await new Promise((r) => setTimeout(r, ch.delay)); if (res.destroyed) return; continue; }
      res.write(`data: ${JSON.stringify(ch)}\n\n`);
    }
    res.write("data: [DONE]\n\n"); res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/v1`;
const cfg = { maxOutputTokens: 1000, maxSteps: 20, contextTokens: 100000, providers: { mock: { api: "openai", baseUrl: BASE, keyEnv: ["MOCK_KEY"] } } };
process.env.MOCK_KEY = "test-key";

const text = (s) => s.match(/.{1,4}/gs).map((piece) => ({ choices: [{ delta: { content: piece } }] }));
const toolCall = (id, name, args) => {
  const a = JSON.stringify(args);
  return [
    { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] } }] },
    ...a.match(/.{1,7}/gs).map((piece) => ({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }] })),
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
};
const toolCount = (body) => body.messages.filter((m) => m.role === "tool").length;

// ---------- temp project ----------
const proj = path.join(tmp, "proj"); fs.mkdirSync(proj);
fs.writeFileSync(path.join(proj, "calc.py"), "def add(a, b):\r\n    return a - b\r\n"); // CRLF on purpose
fs.mkdirSync(path.join(proj, "src")); fs.writeFileSync(path.join(proj, "src", "util.js"), "export const x = 1; // TODO fix\n");

const uiLog = [];
const makeUi = (confirmAnswer = "yes") => ({
  onText: (d) => uiLog.push(["text", d]), onToolEnd: (c, t, r) => uiLog.push(["tool", c.name, r?.denied ? "denied" : r?.error ? "error" : "ok"]),
  confirm: async () => confirmAnswer, onRetry: (r) => uiLog.push(["retry", r.status]), onNotice: () => {},
});

// 1. full tool loop: read -> edit -> bash -> final answer, streamed in small pieces
script = (body) => {
  const n = toolCount(body);
  if (n === 0) return toolCall("c1", "read_file", { path: "calc.py" });
  if (n === 1) return toolCall("c2", "edit_file", { path: "calc.py", old_string: "    return a - b", new_string: "    return a + b" });
  if (n === 2) return toolCall("c3", "bash", { command: 'node -e "console.log(40+2)"' });
  return [...text("Fixed add(); it now returns a + b."), { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 30 } }];
};
let s = new Session({ cwd: proj, model: "mock/test-model" });
let r = await runTurn({ session: s, userText: "fix add", cfg, ui: makeUi(), perm: { mode: "yolo", allowed: new Set() }, signal: new AbortController().signal });
assert.equal(r.done, true);
assert.equal(fs.readFileSync(path.join(proj, "calc.py"), "utf8"), "def add(a, b):\r\n    return a + b\r\n", "edit applied, CRLF preserved");
assert.equal(requests[0].auth, "Bearer test-key");
assert.ok(requests[0].body.messages[0].role === "system" && /Warden/.test(requests[0].body.messages[0].content));
assert.equal(requests[0].body.tools.length, TOOLS.length);
assert.equal(requests[0].body.stream, true);
const last = requests.at(-1).body.messages;
assert.equal(last.filter((m) => m.role === "tool").length, 3);
assert.equal(last.find((m) => m.tool_call_id === "c3").content.includes("42"), true, "bash output reached the model");
assert.match(last.find((m) => m.tool_call_id === "c1").content, /1\tdef add/, "read_file returns numbered lines");
assert.deepEqual(JSON.parse(last.find((m) => m.role === "assistant" && m.tool_calls?.[0]?.id === "c2").tool_calls[0].function.arguments).new_string, "    return a + b");
assert.equal(s.usage.input, 120); assert.equal(s.usage.output, 30);
assert.equal(s.messages.at(-1).content, "Fixed add(); it now returns a + b.");

// session saved and resumable
const loaded = Session.load(s.id);
assert.equal(loaded.messages.length, s.messages.length);

// 2. ask mode: user denies the edit -> file unchanged, model told why
fs.writeFileSync(path.join(proj, "calc.py"), "def add(a, b):\n    return a - b\n");
requests.length = 0;
script = (body) => toolCount(body) === 0 ? toolCall("d1", "edit_file", { path: "calc.py", old_string: "a - b", new_string: "a * b" }) : text("OK, I won't change it.");
s = new Session({ cwd: proj, model: "mock/test-model" });
await runTurn({ session: s, userText: "change it", cfg, ui: makeUi({ reason: "use addition" }), perm: { mode: "ask", allowed: new Set() } });
assert.equal(fs.readFileSync(path.join(proj, "calc.py"), "utf8"), "def add(a, b):\n    return a - b\n");
assert.match(requests.at(-1).body.messages.find((m) => m.role === "tool").content, /User denied.*use addition/);

// 3. rate limit: 429 with retry-after 0, then success
requests.length = 0;
script = (body, n) => (n === 1 ? { status: 429, headers: { "retry-after": "0" }, body: JSON.stringify({ error: { message: "quota" } }) } : text("hi"));
s = new Session({ cwd: proj, model: "mock/test-model" });
uiLog.length = 0;
r = await runTurn({ session: s, userText: "hello", cfg, ui: makeUi(), perm: { mode: "ask", allowed: new Set() } });
assert.equal(r.done, true); assert.ok(uiLog.some((e) => e[0] === "retry" && e[1] === 429)); assert.equal(requests.length, 2);

// 4. non-retryable error surfaces clearly
script = () => ({ status: 404, body: JSON.stringify({ error: { message: "model not found" } }) });
s = new Session({ cwd: proj, model: "mock/nope" });
await assert.rejects(runTurn({ session: s, userText: "x", cfg, ui: makeUi(), perm: { mode: "ask", allowed: new Set() } }), /404 model not found/);

// 5. interrupt while streaming: conversation stays valid
script = () => [...text("Working on "), { delay: 400 }, ...text("it now")];
s = new Session({ cwd: proj, model: "mock/test-model" });
const ac = new AbortController();
setTimeout(() => ac.abort(), 150);
r = await runTurn({ session: s, userText: "slow", cfg, ui: makeUi(), perm: { mode: "ask", allowed: new Set() }, signal: ac.signal });
assert.equal(r.interrupted, true);
assert.match(s.messages.at(-1).content, /interrupted by the user/);

// 6. interrupt during tools: every tool call still gets a result
script = (body) => toolCount(body) === 0 ? [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "bash", arguments: JSON.stringify({ command: 'node -e "setTimeout(()=>{},5000)"' }) } }, { index: 1, id: "t2", function: { name: "list_dir", arguments: "{}" } }] } }] },
] : text("done");
s = new Session({ cwd: proj, model: "mock/test-model" });
const ac2 = new AbortController();
setTimeout(() => ac2.abort(), 600);
r = await runTurn({ session: s, userText: "two tools", cfg, ui: makeUi(), perm: { mode: "yolo", allowed: new Set() }, signal: ac2.signal });
assert.equal(r.interrupted, true);
const toolMsgs = s.messages.filter((m) => m.role === "tool");
assert.deepEqual(toolMsgs.map((m) => m.toolCallId), ["t1", "t2"]);
assert.match(toolMsgs[0].content, /interrupted/); assert.match(toolMsgs[1].content, /Interrupted by the user/);

// 7. tools directly
const ctx = { cwd: proj };
assert.match(toolByName("glob").run({ pattern: "**/*.js" }, ctx).content, /src\/util\.js/);
assert.match(toolByName("grep").run({ pattern: "TODO" }, ctx).content, /src\/util\.js:1:/);
assert.throws(() => toolByName("edit_file").run({ path: "calc.py", old_string: "nope", new_string: "x" }, ctx), /not found/);
fs.writeFileSync(path.join(proj, "dup.txt"), "a\na\n");
assert.throws(() => toolByName("edit_file").run({ path: "dup.txt", old_string: "a", new_string: "b" }, ctx), /appears 2 times/);
toolByName("edit_file").run({ path: "dup.txt", old_string: "a", new_string: "b", replace_all: true }, ctx);
assert.equal(fs.readFileSync(path.join(proj, "dup.txt"), "utf8"), "b\nb\n");
assert.ok(globToRegex("src/**/*.{js,ts}").test("src/a/b/c.ts"));
assert.ok(globToRegex("**/*.py").test("calc.py"));

// 8. permissions
const P = (mode, tool, args) => needsApproval(toolByName(tool), args, { cwd: proj, mode, allowed: new Set() });
assert.equal(P("ask", "read_file", { path: "calc.py" }), false);
assert.equal(P("ask", "read_file", { path: path.join(tmp, "elsewhere.txt") }), true, "reading outside the project asks");
assert.equal(P("ask", "edit_file", { path: "calc.py" }), true);
assert.equal(P("auto-edit", "edit_file", { path: "calc.py" }), false);
assert.equal(P("auto-edit", "write_file", { path: "../escape.txt" }), true, "edits outside the project always ask");
assert.equal(P("auto-edit", "bash", { command: "ls" }), true);
assert.equal(P("yolo", "bash", { command: "ls" }), false);

// 9. Anthropic message conversion: consecutive tool results merge into one user message
const a = toAnthropic([{ role: "user", content: "hi" }, { role: "assistant", content: "", toolCalls: [{ id: "x", name: "read_file", args: { path: "a" } }, { id: "y", name: "list_dir", args: {} }] }, { role: "tool", toolCallId: "x", content: "A" }, { role: "tool", toolCallId: "y", content: "B" }]);
assert.equal(a.length, 3); assert.equal(a[2].content.length, 2); assert.equal(a[1].content[0].type, "tool_use");

// 10. context trimming blanks the oldest big tool outputs first
const msgs = [{ role: "user", content: "x" }, ...Array.from({ length: 10 }, (_, i) => ({ role: "tool", toolCallId: String(i), content: "y".repeat(4000) }))];
assert.ok(trimContext(msgs, 3000) > 0); assert.match(msgs[1].content, /removed/); assert.equal(msgs.at(-1).content.length, 4000);

// 11. the terminal app, driven through a pipe (yolo so nothing waits for approval)
fs.writeFileSync(path.join(proj, "calc.py"), "def add(a, b):\n    return a - b\n");
fs.mkdirSync(process.env.WARDEN_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.WARDEN_HOME, "config.json"), JSON.stringify({ agent: { providers: { mock: { api: "openai", baseUrl: BASE, keyEnv: ["MOCK_KEY"] } } } }));
script = (body) => {
  const n = toolCount(body);
  if (n === 0) return toolCall("p1", "edit_file", { path: "calc.py", old_string: "a - b", new_string: "a + b" });
  return text("Done. **Fixed** `add`.\n- one\n```py\nprint(1)\n```\n");
};
const cli = path.resolve(import.meta.dirname, "../src/cli.mjs");
const outTxt = await new Promise((resolve) => {
  const p = spawn(process.execPath, [cli, "--model", "mock/test-model", "--mode", "yolo"], { cwd: proj, env: { ...process.env, NO_COLOR: "1" } });
  let o = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d));
  p.stdin.end("fix add please\n/usage\n/mode ask\n/exit\n");
  p.on("close", () => resolve(o));
});
assert.match(outTxt, /Warden/); assert.match(outTxt, /mock\/test-model/);
assert.match(outTxt, /Edit calc\.py/); assert.match(outTxt, /Done\. Fixed add\./, "inline markdown rendered without markers");
assert.match(outTxt, /• one/); assert.match(outTxt, /print\(1\)/);
assert.match(outTxt, /model calls/); assert.match(outTxt, /mode: ask/); assert.match(outTxt, /Saved conversation/);
assert.equal(fs.readFileSync(path.join(proj, "calc.py"), "utf8"), "def add(a, b):\n    return a + b\n");

// 12. headless -p denies edits in ask mode, and reports it
fs.writeFileSync(path.join(proj, "calc.py"), "def add(a, b):\n    return a - b\n");
script = (body) => toolCount(body) === 0 ? toolCall("h1", "edit_file", { path: "calc.py", old_string: "a - b", new_string: "a + b" }) : text("Could not edit.");
const head = await new Promise((resolve) => {
  const p = spawn(process.execPath, [cli, "-p", "fix add", "--model", "mock/test-model"], { cwd: proj, env: process.env });
  let o = "", e = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (e += d));
  p.on("close", (code) => resolve({ o, e, code }));
});
assert.equal(head.code, 0); assert.match(head.e, /denied/); assert.match(head.o, /Could not edit/);
assert.equal(fs.readFileSync(path.join(proj, "calc.py"), "utf8"), "def add(a, b):\n    return a - b\n");

server.close();
console.log("agent.mock: all assertions passed");
