// Offline test of adding models: saved keys, the /add wizard (driven through a pipe), tool-support detection, the text
// tool-call fallback for models without native tools, and /model /providers /remove. No network, no real keys.
// Run: node test/models.mock.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "warden-models-test-"));
process.env.WARDEN_HOME = path.join(tmp, "home");
const { parseTextToolCalls, ToolTagFilter, toTextProtocol } = await import("../src/agent/texttools.mjs");
const { probeToolSupport } = await import("../src/agent/models.mjs");
const { keyFor, resolveProvider } = await import("../src/agent/providers.mjs");
const { saveKey, removeKey, CREDENTIALS_FILE } = await import("../src/agent/credentials.mjs");
const { runTurn } = await import("../src/agent/loop.mjs");
const { Session } = await import("../src/agent/session.mjs");

// ---------- 1. text tool format ----------
let p = parseTextToolCalls('I will look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.py"}}\n</tool_call>\n<tool_call>```json\n{"name":"list_dir","arguments":{},}\n```</tool_call>');
assert.equal(p.text, "I will look.");
assert.deepEqual(p.toolCalls.map((c) => c.name), ["read_file", "list_dir"]);
assert.equal(p.toolCalls[0].args.path, "a.py");
p = parseTextToolCalls("<tool_call>not json</tool_call>");
assert.equal(p.toolCalls[0].name, "__invalid__");
assert.equal(parseTextToolCalls("plain answer").toolCalls.length, 0);

let shown = "";
const f = new ToolTagFilter((s) => (shown += s));
for (const piece of ["Reading ", "now <to", "ol_call>{\"name\":\"x\"}</tool", "_call> done", " <b>ok</b>"]) f.write(piece);
f.end();
assert.equal(shown, "Reading now  done <b>ok</b>", "tool tags hidden from the stream, other tags kept");

const conv = toTextProtocol([{ role: "user", content: "hi" }, { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read_file", args: { path: "a" } }] }, { role: "tool", toolCallId: "1", name: "read_file", content: "A" }, { role: "tool", toolCallId: "2", name: "list_dir", content: "B" }]);
assert.deepEqual(conv.map((m) => m.role), ["user", "assistant", "user"], "strict alternation, consecutive results merged");
assert.match(conv[2].content, /<tool_result name="read_file">[\s\S]*<tool_result name="list_dir">/);

// ---------- mock server: three models with different tool abilities ----------
const KEY = "sk-mock-0123456789-secret";
const seen = [];
const sse = (res, chunks) => { res.writeHead(200, { "content-type": "text/event-stream" }); for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`); res.end("data: [DONE]\n\n"); };
const textChunks = (s) => s.match(/.{1,5}/gs).map((x) => ({ choices: [{ delta: { content: x } }] }));
const server = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); return res.end(JSON.stringify({ error: { message: "invalid api key" } })); }
    if (req.url.endsWith("/models")) { res.writeHead(200); return res.end(JSON.stringify({ data: [{ id: "tooly" }, { id: "plain" }, { id: "dumb" }] })); }
    const body = JSON.parse(b);
    seen.push(body);
    const sys = body.messages[0]?.content || "";
    const last = body.messages.at(-1).content || "";
    if (body.tools && body.model !== "tooly") { res.writeHead(400); return res.end(JSON.stringify({ error: { message: "tools is not supported for this model" } })); }
    if (body.model === "tooly") {
      if (/ping tool/.test(last)) return sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "p1", function: { name: "ping", arguments: '{"message":"hello"}' } }] } }] }]);
      return sse(res, textChunks("ok"));
    }
    if (body.model === "dumb") return sse(res, textChunks("I cannot do that."));
    // "plain": no native tools, but follows the text format
    if (/ping tool/.test(last) && /<tool_call>/.test(sys)) return sse(res, textChunks('<tool_call>{"name":"ping","arguments":{"message":"hello"}}</tool_call>'));
    if (!/<tool_result/.test(last)) return sse(res, textChunks('Let me read it.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "calc.py"}}\n</tool_call>'));
    return sse(res, textChunks("calc.py subtracts instead of adding."));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${server.address().port}/v1`;

// ---------- 2. saved keys: env beats saved; removal ----------
const cfg = { maxOutputTokens: 500, maxSteps: 10, contextTokens: 50000, providers: { mock: { label: "mock", api: "openai", baseUrl: URL_, keyEnv: ["MOCK_ENV_KEY"] } }, models: [] };
assert.throws(() => keyFor("mock", resolveProvider("mock", cfg), {}), /run \/add/);
saveKey("mock", KEY);
assert.equal(keyFor("mock", resolveProvider("mock", cfg), {}), KEY);
assert.equal(keyFor("mock", resolveProvider("mock", cfg), { MOCK_ENV_KEY: "from-env" }), "from-env");

// ---------- 3. tool-support detection ----------
assert.equal((await probeToolSupport("mock/tooly", cfg)).mode, "native");
assert.equal((await probeToolSupport("mock/plain", cfg)).mode, "text");
assert.equal((await probeToolSupport("mock/dumb", cfg)).mode, "none");
saveKey("mock", "wrong-key");
await assert.rejects(probeToolSupport("mock/tooly", cfg), /401/, "a bad key is reported, not mistaken for missing tool support");
saveKey("mock", KEY);

// ---------- 4. agent loop on a model without native tools ----------
const proj = path.join(tmp, "proj"); fs.mkdirSync(proj);
fs.writeFileSync(path.join(proj, "calc.py"), "def add(a, b):\n    return a - b\n");
const ui = (log) => ({ onText: (d) => log.push(d), onNotice: (m) => log.push("NOTICE " + m), confirm: async () => "yes", onToolEnd: (c, t, r) => log.push("TOOL " + c.name) });
// 4a. saved as "text": works directly
cfg.models = [{ name: "plain", spec: "mock/plain", ctx: 8000, tools: "text" }];
let log = [], s = new Session({ cwd: proj, model: "mock/plain" });
let r = await runTurn({ session: s, userText: "what is wrong with calc.py?", cfg, ui: ui(log), perm: { mode: "ask", allowed: new Set() } });
assert.equal(r.done, true);
assert.ok(log.includes("TOOL read_file"));
assert.ok(!log.join("").includes("<tool_call>"), "tags never reach the screen");
assert.match(s.messages.at(-1).content, /subtracts/);
const lastReq = seen.at(-1);
assert.equal(lastReq.tools, undefined); assert.match(lastReq.messages.at(-1).content, /<tool_result name="read_file">[\s\S]*return a - b/);
// 4b. not saved: starts native, gets rejected, falls back to text by itself
cfg.models = [];
log = []; s = new Session({ cwd: proj, model: "mock/plain" });
r = await runTurn({ session: s, userText: "what is wrong with calc.py?", cfg, ui: ui(log), perm: { mode: "ask", allowed: new Set() } });
assert.equal(r.done, true); assert.ok(log.some((l) => /switching it to Warden's text tool format/.test(l))); assert.ok(log.includes("TOOL read_file"));

// ---------- 5. the /add wizard and friends, through a pipe ----------
removeKey("mock");
fs.writeFileSync(path.join(process.env.WARDEN_HOME, "config.json"), JSON.stringify({ agent: { model: "mock/tooly" } }));
const cli = path.resolve(import.meta.dirname, "../src/cli.mjs");
const input = [
  "/add", "c", "mock", URL_, KEY,   // custom source, its URL, the key (hidden)
  "",                               // search: enter (no free info -> all)
  "2",                              // pick "plain" (list sorted: dumb, plain, tooly)
  "",                               // name: keep suggestion
  "/model", "",                     // list saved models, keep current
  "/providers",
  "/remove plain",
  "/exit",
].join("\n") + "\n";
const out = await new Promise((resolve) => {
  const pr = spawn(process.execPath, [cli], { cwd: proj, env: { ...process.env, NO_COLOR: "1" } });
  let o = ""; pr.stdout.on("data", (d) => (o += d)); pr.stderr.on("data", (d) => (o += d));
  pr.stdin.end(input); pr.on("close", () => resolve(o));
});
assert.match(out, /Where do you want models from\?/);
assert.match(out, /OpenRouter/); assert.match(out, /Hugging Face/); assert.match(out, /NVIDIA/); assert.match(out, /DeepSeek/);
assert.match(out, /Saved sk-m…cret to/);
assert.ok(!out.includes(KEY), "the full key is never printed");
assert.match(out, /3 models/);
assert.match(out, /Works\. no native tool calling; Warden's text format works/);
assert.match(out, /Added plain\./);
assert.match(out, /model: plain = mock\/plain/);
assert.match(out, /1\s+● plain\s+mock\/plain\s+text tools/);
assert.match(out, /mock\s+key saved by \/add\s+1 saved model/);
assert.match(out, /Removed model "plain"/);
const creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
assert.equal(creds.mock, KEY);
const conf = JSON.parse(fs.readFileSync(path.join(process.env.WARDEN_HOME, "config.json"), "utf8")).agent;
assert.equal(conf.providers.mock.baseUrl, URL_);
assert.deepEqual(conf.models, []);
assert.equal(conf.model, "mock/plain", "switched model saved as default");

server.close();
console.log("models.mock: all assertions passed");
