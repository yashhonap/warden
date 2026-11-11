// Offline test: every API shape against a local mock server. No network, no real keys.
// Run: node test/providers.mock.mjs
import http from "node:http";
import assert from "node:assert/strict";
import { runReviewers, planReviewers, estimate } from "../src/supervisor/review.mjs";

const seen = [];
const verdictJson = (extra = {}) => JSON.stringify({ verdict: "fail", summary: "mock", findings: [{ severity: "high", file: "calc.py", line: 2, message: "wrong operator" }], ...extra });

const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    const b = body ? JSON.parse(body) : {};
    seen.push({ url: req.url, auth: req.headers.authorization, xkey: req.headers["x-api-key"], gkey: req.headers["x-goog-api-key"], body: b });
    const send = (code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url.startsWith("/boom/")) return send(500, { error: "server exploded" });
    if (req.url.endsWith("/chat/completions")) return send(200, { choices: [{ message: { content: verdictJson() } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } });
    if (req.url.endsWith("/messages")) return send(200, { content: [{ type: "text", text: verdictJson() }], usage: { input_tokens: 1000, output_tokens: 200 } });
    if (req.url.includes(":generateContent")) return send(200, { candidates: [{ content: { parts: [{ text: verdictJson() }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 150, thoughtsTokenCount: 50 } });
    send(404, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

Object.assign(process.env, { OPENAI_API_KEY: "test-openai", OPENROUTER_API_KEY: "test-or", GEMINI_API_KEY: "test-gem", ANTHROPIC_API_KEY: "test-ant" });
delete process.env.GOOGLE_API_KEY;

const cfg = {
  maxOutputTokens: 2000, maxDiffChars: 60000,
  providers: {
    openai: { baseUrl: `${base}/v1` }, openrouter: { baseUrl: `${base}/or/v1` }, gemini: { baseUrl: `${base}/v1beta` },
    anthropic: { baseUrl: `${base}/ant/v1` }, ollama: { baseUrl: `${base}/ollama/v1` },
    broken: { kind: "openai", baseUrl: `${base}/boom/v1`, keyEnv: [] },
  },
  prices: { "openai/m-openai": { in: 1, out: 2 }, "gemini/m-gem": { in: 0.5, out: 1 } }, // $/1M, test values only
};

const specs = [
  { role: "correctness", provider: "openai", model: "m-openai" },
  { role: "correctness", provider: "gemini", model: "m-gem" },
  { role: "security", provider: "anthropic", model: "m-ant" },       // no price -> cost unknown
  { role: "test-gap", provider: "openrouter", model: "vendor/m-or" }, // no price -> unknown
  { role: "scope-creep", provider: "ollama", model: "llama-local" },  // free
  { role: "security", provider: "broken", model: "x" },               // must fail in isolation
].map((s) => ({ ...s, label: `${s.role}@${s.provider}/${s.model}` }));

const report = await runReviewers({ context: "## Diff\n-return a - b\n+return a * b", cfg, specs });

// 1. every provider got a call with the right auth, in the right place
const by = (frag) => seen.find((s) => (frag.startsWith("/v1/") ? s.url === frag : s.url.includes(frag)));
assert.equal(by("/v1/chat/completions").auth, "Bearer test-openai");
assert.equal(by("/or/v1/chat/completions").auth, "Bearer test-or");
assert.equal(by("/ant/v1/messages").xkey, "test-ant");
const g = by(":generateContent");
assert.equal(g.gkey, "test-gem");
assert.ok(!g.url.includes("test-gem"), "gemini key must not appear in the URL");
assert.equal(by("/ollama/v1/chat/completions").auth, undefined, "local provider sends no auth");
assert.equal(by("/v1/chat/completions").body.max_completion_tokens, 2000, "openai uses max_completion_tokens");
assert.equal(by("/or/v1/chat/completions").body.max_tokens, 2000, "compat servers use max_tokens");

// 2. failures are isolated, others still reported
const broken = report.roles.find((r) => r.role.includes("@broken"));
assert.equal(broken.ok, false);
assert.equal(report.roles.filter((r) => r.ok).length, 5);
assert.equal(report.verdict, "fail");

// 3. findings from 5 models at calc.py:2 collapse into ONE finding with 5 reviewers
assert.equal(report.findings.length, 1);
assert.equal(report.findings[0].roles.length, 5);

// 4. cost: openai (1000*1+200*2)/1e6 + gemini (1000*0.5+200*1)/1e6 ; unknown ones listed, ollama free
const expected = (1000 * 1 + 200 * 2) / 1e6 + (1000 * 0.5 + 200 * 1) / 1e6;
assert.ok(Math.abs(report.cost_usd - expected) < 1e-9, `cost ${report.cost_usd} vs ${expected}`);
assert.equal(report.cost_unknown_for.length, 2);

// 5. estimate flags unknown prices instead of guessing
const est = estimate("x".repeat(4000), specs.slice(0, 5), cfg);
assert.equal(est.unknown.length, 2);

// 6. --with expands roles x models
const cross = planReviewers({ provider: "claude-cli", model: null, roles: ["correctness", "security"], reviewers: null }, { withModels: ["gemini:m-gem", "openai:m-openai"] });
assert.equal(cross.length, 4);
assert.equal(cross[0].label, "correctness@gemini/m-gem");

// 7. missing key gives a clear error (and no request is made)
delete process.env.OPENAI_API_KEY;
const n = seen.length;
const r2 = await runReviewers({ context: "x", cfg, specs: [specs[0]] });
assert.match(r2.roles[0].error, /OPENAI_API_KEY/);
assert.equal(seen.length, n);

server.close();
console.log("providers.mock: all assertions passed");
