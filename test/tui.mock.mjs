// Interactive test: the real terminal app on a simulated terminal (raw keys, echo, esc, ctrl+c) against a mock model.
// Checks that you can keep chatting: after answers, while the model works (queued messages), after esc / ctrl+c
// interrupts (also during an approval question), and after a model that stops responding (timeout).
// Run: node test/tui.mock.mjs
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "warden-tui-test-"));
Object.assign(process.env, { WARDEN_HOME: path.join(tmp, "home"), WARDEN_NO_UPDATE_CHECK: "1", NO_COLOR: "1", MOCK_KEY: "k" });

// ---------- mock model: answers by the last user message ----------
const requests = [];
const lastUser = (b) => [...b.messages].reverse().find((m) => m.role === "user")?.content || "";
const text = (s) => s.match(/.{1,4}/gs).map((p) => ({ choices: [{ delta: { content: p } }] }));
const call = (id, name, args) => [{ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] }];
const routes = {
  hello: () => text("Hi there."),
  second: (b) => text(b.messages.some((m) => m.role === "assistant" && m.content === "Hi there.") ? "Second answer, I remember hello." : "I forgot."),
  "make page": (b) => b.messages.some((m) => m.role === "tool") ? text("Page done.") : [{ delay: 900 }, ...call("w1", "write_file", { path: "index.html", content: "<h1>Hi</h1>\n" })],
  "also add a footer": (b) => text(b.messages.some((m) => m.role === "tool" && /index\.html/.test(m.content)) ? "Added the footer after writing the page." : "Footer without context?"),
  slow: () => [...text("Working on it "), { delay: 1200 }, ...text("and never finishing")],
  after: () => text("Still here after the interrupt."),
  "edit it": () => call("e1", "edit_file", { path: "index.html", old_string: "Hi", new_string: "Hello" }),
  next: () => text("Fine, ready for more."),
  stall: () => [...text("Par"), { delay: 4000 }, ...text("tial")],
  again: () => text("Recovered after the timeout."),
  slow2: () => [{ delay: 1200 }, ...text("Slow again")],
  "queued msg": () => text("Got your queued message."),
  think: () => [{ delay: 1300 }, ...text("Thought about it.")],
};
const server = http.createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d)); req.on("end", async () => {
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    const route = routes[lastUser(body)] || (() => text("default reply"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const ch of route(body)) {
      if (ch.delay) { await new Promise((r) => setTimeout(r, ch.delay)); if (res.destroyed || res.writableEnded) return; continue; }
      if (!res.destroyed) res.write(`data: ${JSON.stringify(ch)}\n\n`);
    }
    if (!res.destroyed) { res.write("data: [DONE]\n\n"); res.end(); }
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
fs.mkdirSync(process.env.WARDEN_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.WARDEN_HOME, "config.json"), JSON.stringify({ agent: {
  providers: { mock: { api: "openai", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, keyEnv: ["MOCK_KEY"] } },
  idleTimeoutSec: 1.5, requestTimeoutSec: 3, stallTimeoutSec: 3,
} }));
const proj = path.join(tmp, "proj"); fs.mkdirSync(proj);

// ---------- simulated terminal ----------
let screen = "";
const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(v) { this.isRaw = v; return this; } });
const stdout = Object.assign(new Writable({ write(c, _e, cb) { screen += String(c); cb(); } }), { isTTY: true, columns: 120, rows: 40 });
Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
Object.defineProperty(process, "stdout", { value: stdout, configurable: true });
console.log = (...a) => stdout.write(util.format(...a) + "\n");
const plain = () => screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(re, ms = 8000, from = 0) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (re.test(plain().slice(from))) return; await sleep(25); }
  throw new Error(`timed out waiting for ${re}\n---- screen tail ----\n${plain().slice(-1500)}`);
}
const type = async (s) => { for (const ch of s) { stdin.write(ch); await sleep(4); } };
const mark = () => plain().length;

// quitting calls process.exit: finish the test there instead
const realExit = process.exit;
let finished = null;
process.exit = (code) => { finished?.(code); };

const { startApp } = await import("../src/tui/app.mjs");
// started like `warden "hello"`: the first message comes from the command line
startApp({ cwd: proj, model: "mock/test-model", mode: "auto-edit", initialPrompt: "hello" });
await waitFor(/Warden/);

// 1. plain back-and-forth: the second message sees the first answer, and what you type after the first turn is visible
let m = mark(); await waitFor(/Hi there\./, 8000, m);
await sleep(100);
m = mark(); await type("second");
await waitFor(/second/, 1000, m); // echoed at the prompt (it was invisible when the turn had started from the command line)
await type("\r"); await waitFor(/Second answer, I remember hello\./, 8000, m);

// 2. type while the model works: the message is queued and reaches the model at its next step, same turn
m = mark(); await type("make page\r");
await sleep(250);
await type("also add a footer\r");
await waitFor(/queued; the model gets it at its next step: also add a footer/, 8000, m);
await waitFor(/also add a footer\s+\(sent while Warden was working\)/, 8000, m);
await waitFor(/Added the footer after writing the page\./, 8000, m);
assert.equal(fs.readFileSync(path.join(proj, "index.html"), "utf8"), "<h1>Hi</h1>\n");
const footerReq = requests.find((b) => lastUser(b) === "also add a footer");
const order = footerReq.messages.map((x) => x.role);
assert.deepEqual(order.slice(-3), ["assistant", "tool", "user"], "queued message comes right after the tool result");
// what you type while it works is not drawn into the model's output (only the "queued" note shows it)
const typedEchoes = plain().slice(m).split("also add a footer").length - 1;
assert.equal(typedEchoes, 2, "typed text appears only in the queued note and the sent line");

// 3. esc interrupts a reply mid-stream; the next message works normally
m = mark(); await type("slow\r"); await waitFor(/Working on it/, 8000, m);
stdin.write("\x1b");
await waitFor(/Interrupted\./, 8000, m);
m = mark(); await type("after\r"); await waitFor(/Still here after the interrupt\./, 8000, m);

// 4. ctrl+c during an approval question cancels it (no extra Enter needed); chatting continues
m = mark(); await type("/mode ask\r"); await waitFor(/mode: ask/, 8000, m);
m = mark(); await type("edit it\r"); await waitFor(/Allow this change\?/, 8000, m);
stdin.write("\x03");
await waitFor(/Interrupted\./, 8000, m);
assert.equal(fs.readFileSync(path.join(proj, "index.html"), "utf8"), "<h1>Hi</h1>\n", "interrupted edit was not applied");
m = mark(); await type("next\r"); await waitFor(/Fine, ready for more\./, 8000, m);

// 5. a model that stops sending: Warden gives up after the idle timeout and you can carry on
m = mark(); await type("stall\r");
await waitFor(/stopped sending anything for 1\.5s/, 8000, m);
await waitFor(/Nothing was lost/, 8000, m);
m = mark(); await type("again\r"); await waitFor(/Recovered after the timeout\./, 8000, m);
const againReq = requests.find((b) => lastUser(b) === "again");
assert.ok(againReq.messages.some((x) => x.role === "assistant" && /^Par/.test(x.content)), "partial reply kept as context");

// 6. a message queued when the turn is then interrupted is not lost: it waits on the prompt; enter sends it
// (typed while the model is still thinking, so the "queued" note shows at once)
m = mark(); await type("slow2\r"); await waitFor(/Thinking/, 8000, m);
await type("queued msg\r");
await waitFor(/queued; the model gets it/, 1000, m);
stdin.write("\x1b");
await waitFor(/Interrupting/, 2000, m);
await waitFor(/Your message was not sent yet/, 8000, m);
m = mark(); await type("\r"); await waitFor(/Got your queued message\./, 8000, m);
assert.ok(requests.some((b) => lastUser(b) === "queued msg"), "the restored message is sent exactly, without a stray ESC character");

// 6b. esc at an idle prompt does not leave an invisible character in what you type
m = mark(); stdin.write("\x1b"); await sleep(700); await type("hello\r"); await waitFor(/Hi there\./, 8000, m);

// 7. slash commands typed while busy are refused politely, not sent to the model
m = mark(); await type("think\r"); await waitFor(/Thinking/, 8000, m);
await type("/usage\r");
await waitFor(/\/usage has to wait until Warden is idle/, 1000, m);
stdin.write("\x1b"); await waitFor(/Interrupted\./, 8000, m);
assert.ok(!requests.some((b) => b.messages.some((x) => x.role === "user" && x.content === "/usage")), "/usage never reached the model");

// 8. quit
const code = await new Promise((res) => { finished = res; type("/exit\r"); });
assert.equal(code, 0);
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.stderr.write("tui.mock: all assertions passed\n");
realExit(0);
