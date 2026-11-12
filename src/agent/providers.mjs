// Model providers for the Warden agent. Two wire protocols cover almost everything:
//   "openai"     Chat Completions with streaming + tool calls. Used by OpenAI, Gemini (Google's OpenAI-compatible
//                endpoint), OpenRouter, Groq, Ollama, LM Studio, and any other compatible server.
//   "anthropic"  Messages API (non-streaming here) with tool use.
//
// Internal message format (provider-neutral):
//   { role: "user", content: string }
//   { role: "assistant", content: string, toolCalls?: [{ id, name, args }] }
//   { role: "tool", toolCallId, name, content: string }

import { CATALOG } from "./catalog.mjs";
import { savedKey } from "./credentials.mjs";
import { textToolsPrompt, toTextProtocol, parseTextToolCalls, ToolTagFilter } from "./texttools.mjs";

export const PROVIDERS = CATALOG;

// "gemini/gemini-2.5-flash" -> { provider: "gemini", model: "gemini-2.5-flash" }. Model ids may contain "/" (openrouter).
export function parseModelSpec(spec) {
  const i = String(spec || "").indexOf("/");
  if (i <= 0) throw new Error(`model must look like provider/model, e.g. gemini/gemini-2.5-flash (got "${spec}")`);
  return { provider: spec.slice(0, i), model: spec.slice(i + 1) };
}

export function resolveProvider(name, cfg = {}) {
  const p = { ...PROVIDERS[name], ...(cfg.providers?.[name] || {}) };
  if (!p.api || !p.baseUrl) throw new Error(`unknown provider "${name}". Built in: ${Object.keys(PROVIDERS).join(", ")}. Add others under "providers" in ~/.warden/config.json`);
  return p;
}

// Environment variables win; then a key saved with /add; local servers need none.
export function keyFor(name, p, env = process.env) {
  for (const v of p.keyEnv || []) if (env[v]) return env[v];
  const saved = savedKey(name);
  if (saved) return saved;
  if (!p.keyEnv?.length) return null;
  throw new Error(`no API key for ${name}: run /add and pick ${p.label || name}, or set ${p.keyEnv.join(" or ")}`);
}

export function keyStatus(name, cfg = {}, env = process.env) {
  const p = resolveProvider(name, cfg);
  const v = (p.keyEnv || []).find((k) => env[k]);
  if (v) return `key from ${v}`;
  if (savedKey(name)) return "key saved by /add";
  if (!p.keyEnv?.length) return "no key needed";
  return `missing key (${p.keyEnv.join(" or ")})`;
}

// A provider that rejects the tools parameter answers 400/404/422 and usually names tools/functions in the error.
export const toolsUnsupported = (e) => [400, 404, 422].includes(e?.status) && /tool|function/i.test(e?.message || "");

// ---- conversion ------------------------------------------------------------

export function toOpenAI(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const msg = { role: "assistant", content: m.content || "" };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }));
        if (!m.content) msg.content = null;
      }
      out.push(msg);
    } else if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
  }
  return out;
}

export function toAnthropic(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      // a message typed while tools ran (or after a failed request) follows another user turn: merge them
      const last = out.at(-1);
      if (last?.role === "user") last.content.push({ type: "text", text: m.content });
      else out.push({ role: "user", content: [{ type: "text", text: m.content }] });
    } else if (m.role === "assistant") {
      const content = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const c of m.toolCalls || []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      out.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "(no output)" }] });
    } else if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out.at(-1);
      // consecutive tool results belong in one user message
      if (last?.role === "user" && last.content.every((b) => b.type === "tool_result")) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

const toolsOpenAI = (tools) => tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
const toolsAnthropic = (tools) => tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

// ---- HTTP with retries (free tiers rate-limit a lot) -----------------------

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); }, { once: true });
});

// ---- timeouts ------------------------------------------------------------------
// A model request must never hang forever. Three limits, all in seconds and changeable in settings:
//   requestTimeoutSec  no answer at all (not even headers) after this long: give up on the attempt (retried once)
//   idleTimeoutSec     a streaming reply goes completely silent this long: stop
//   stallTimeoutSec    only keep-alive pings, no text / reasoning / tool calls, this long: stop
export const TIMEOUT_DEFAULTS = { requestTimeoutSec: 180, idleTimeoutSec: 120, stallTimeoutSec: 300 };

export class ModelTimeoutError extends Error {
  constructor(message) { super(message); this.name = "ModelTimeoutError"; this.timeout = true; }
}

export function timeoutsFrom(cfg = {}) {
  const sec = (k) => { const v = Number(cfg?.[k]); return (Number.isFinite(v) && v > 0 ? v : TIMEOUT_DEFAULTS[k]) * 1000; };
  return { request: sec("requestTimeoutSec"), idle: sec("idleTimeoutSec"), stall: sec("stallTimeoutSec") };
}
const secs = (ms) => (ms % 1000 ? (ms / 1000).toFixed(1) : String(ms / 1000));

// Reads a fetch body, calling onLine for each line, and stops with ModelTimeoutError when the stream goes quiet.
// progress() is called by the parser when real content arrives (text, reasoning or tool calls).
async function readStream(r, { signal, idleMs, stallMs, onLine, label }) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", fired = null;
  const stop = (why) => { if (!fired) { fired = why; reader.cancel().catch(() => {}); } };
  let idle = setTimeout(() => stop("idle"), idleMs);
  let stall = setTimeout(() => stop("stall"), stallMs);
  const progress = () => { clearTimeout(stall); stall = setTimeout(() => stop("stall"), stallMs); };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(idle); idle = setTimeout(() => stop("idle"), idleMs);
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        onLine(line, progress);
      }
    }
    if (buf.trim()) onLine(buf.trim(), progress);
  } catch (e) {
    if (!fired || signal?.aborted) { reader.cancel().catch(() => {}); throw e; }
  } finally {
    clearTimeout(idle); clearTimeout(stall);
  }
  if (fired === "idle") throw new ModelTimeoutError(`${label} stopped sending anything for ${secs(idleMs)}s, so Warden stopped waiting. Send your message again, or switch models with /model.`);
  if (fired === "stall") throw new ModelTimeoutError(`${label} kept the connection open for ${secs(stallMs)}s without sending any reply (it may be overloaded), so Warden stopped waiting. Try again, or switch models with /model.`);
}

async function postWithRetry(url, headers, body, { signal, onRetry, retries = 4, timeoutMs = TIMEOUT_DEFAULTS.requestTimeoutSec * 1000, label = "The model" }) {
  let timeoutRetries = 1;
  for (let attempt = 0; ; attempt++) {
    // each attempt gets its own deadline for the response to start; the user's interrupt still applies throughout
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    let r;
    try {
      r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal });
    } catch (e) {
      if (signal?.aborted || !deadline.signal.aborted) throw e;
      if (timeoutRetries-- > 0) {
        onRetry?.({ status: "no response", waitMs: 0, attempt: attempt + 1, message: `no response after ${secs(timeoutMs)}s` });
        continue;
      }
      throw new ModelTimeoutError(`${label} did not respond within ${secs(timeoutMs)}s (tried twice). It may be overloaded: try again, or switch models with /model.`);
    } finally {
      clearTimeout(timer);
    }
    if (r.ok) return r;
    const text = await r.text().catch(() => "");
    let msg = text, hintedDelay = null;
    try {
      const j = JSON.parse(text);
      const err = Array.isArray(j) ? j[0]?.error : j.error;
      msg = err?.message || j.message || text;
      // Google puts the wait time in error.details[].retryDelay, e.g. "33s"
      const rd = (err?.details || []).find((d) => d?.retryDelay)?.retryDelay;
      if (rd) hintedDelay = parseFloat(rd) * 1000;
    } catch {}
    const ra = Number(r.headers.get("retry-after"));
    if (Number.isFinite(ra) && ra > 0) hintedDelay ??= ra * 1000;
    const fail = (extra = "") => { const e = new Error(`${r.status} ${String(msg).replace(/\s+/g, " ").slice(0, 400)}${extra}`); e.status = r.status; return e; };
    const retryable = r.status === 429 || r.status >= 500;
    if (!retryable || attempt >= retries) throw fail();
    // A long or daily quota is not worth waiting for: say so now instead of retrying.
    if (r.status === 429 && (hintedDelay > 60_000 || (/per ?day|daily|PerDay/i.test(msg) && !hintedDelay))) {
      const e = fail(" [quota used up for now; switch model with /model or try again later]");
      e.quota = true;
      throw e;
    }
    const wait = hintedDelay != null ? Math.min(Math.max(hintedDelay, 1000), 60_000) : Math.min(2000 * 2 ** attempt, 30_000);
    onRetry?.({ status: r.status, waitMs: wait, attempt: attempt + 1, message: String(msg).slice(0, 160) });
    await sleep(wait, signal);
  }
}

// ---- streaming chat --------------------------------------------------------

/**
 * One model call. Streams text through onText. Returns { text, toolCalls, usage, stopReason }.
 */
export async function chat({ spec, system, messages, tools, cfg = {}, signal, onText = () => {}, onReasoning = () => {}, onToolDelta = () => {}, onRetry, maxOutputTokens = 8192, env = process.env, toolMode = "native", timeouts }) {
  const { provider, model } = parseModelSpec(spec);
  const p = resolveProvider(provider, cfg);
  const key = keyFor(provider, p, env);
  const t = timeoutsFrom(timeouts || cfg);
  const label = `The model (${spec})`;
  const common = { p, key, model, signal, onRetry, maxOutputTokens, t, label, onReasoning, onToolDelta };
  const send = (o) => (p.api === "anthropic" ? anthropicChat({ ...common, ...o }) : openaiChat({ ...common, ...o }));

  if (toolMode === "text" && tools?.length) {
    // the model writes <tool_call> blocks; hide them from the stream and parse them afterwards
    const filter = new ToolTagFilter(onText);
    let hidden = "";
    const res = await send({ system: system + textToolsPrompt(tools), messages: toTextProtocol(messages), tools: null, onText: (d) => {
      filter.write(d);
      if (filter.inside) { hidden += d; try { onToolDelta(hidden.match(/"name"s*:s*"([w-]+)"/)?.[1] || "", hidden); } catch {} } else hidden = "";
    } });
    filter.end();
    const parsed = parseTextToolCalls(res.text);
    return { ...res, text: parsed.text, toolCalls: parsed.toolCalls };
  }
  if (toolMode === "none" || !tools?.length) {
    const note = "\n\nNote: this model is in chat-only mode. You cannot read files or run commands; answer from the conversation and ask the user to paste what you need.";
    return send({ system: toolMode === "none" ? system + note : system, messages: toTextProtocol(messages), tools: null, onText });
  }
  return send({ system, messages, tools, onText });
}

async function openaiChat({ p, key, model, system, messages, tools, signal, onText, onReasoning, onToolDelta, onRetry, maxOutputTokens, t, label }) {
  const body = { model, messages: toOpenAI(system, messages), stream: true, [p.maxTokensParam || "max_tokens"]: maxOutputTokens };
  if (tools?.length) body.tools = toolsOpenAI(tools);
  if (p.streamUsage !== false && !p.local) body.stream_options = { include_usage: true };
  const headers = key ? { authorization: `Bearer ${key}` } : {};
  const post = () => postWithRetry(`${p.baseUrl}/chat/completions`, headers, body, { signal, onRetry, timeoutMs: t.request, label });
  let r;
  try {
    r = await post();
  } catch (e) {
    // some compatible servers reject stream_options; retry once without it
    if (e.status === 400 && body.stream_options && /stream_options|include_usage|unknown/i.test(e.message)) {
      delete body.stream_options;
      r = await post();
    } else throw e;
  }

  let text = "", stopReason = null, usage = null;
  const calls = new Map(); // index -> {id, name, args}
  const handle = (data, progress) => {
    if (data === "[DONE]") return;
    let j; try { j = JSON.parse(data); } catch { return; }
    if (j.error) { const e = new Error(j.error.message || JSON.stringify(j.error)); e.status = Number(j.error.code) || undefined; throw e; }
    if (j.usage) usage = { input: j.usage.prompt_tokens ?? 0, output: j.usage.completion_tokens ?? 0 };
    const ch = j.choices?.[0];
    if (!ch) return;
    const d = ch.delta || ch.message || {};
    // reasoning models stream their thinking separately (field name differs by server); show activity, keep it out of the reply
    const thought = d.reasoning_content ?? d.reasoning ?? d.thinking;
    if (typeof thought === "string" && thought) { progress(); onReasoning(thought); }
    if (typeof d.content === "string" && d.content) { progress(); text += d.content; onText(d.content); }
    for (const tc of d.tool_calls || []) {
      progress();
      const idx = tc.index ?? calls.size;
      const cur = calls.get(idx) || { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
      calls.set(idx, cur);
      try { onToolDelta(cur.name, cur.args); } catch {}
    }
    if (ch.finish_reason) stopReason = ch.finish_reason;
  };
  // lines starting with ":" are keep-alive comments (OpenRouter sends them while a model is queued): not progress
  await readStream(r, { signal, idleMs: t.idle, stallMs: t.stall, label, onLine: (line, progress) => { if (line.startsWith("data:")) handle(line.slice(5).trim(), progress); } });

  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c], n) => {
    let args = {};
    try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = { __invalid_json: c.args }; }
    return { id: c.id || `call_${Date.now().toString(36)}_${n}`, name: c.name, args };
  }).filter((c) => c.name);
  return { text, toolCalls, usage, stopReason };
}

async function anthropicChat({ p, key, model, system, messages, tools, signal, onText, onRetry, maxOutputTokens, t, label }) {
  const body = { model, system, max_tokens: maxOutputTokens, messages: toAnthropic(messages) };
  if (tools?.length) body.tools = toolsAnthropic(tools);
  // not streamed: the whole reply arrives at once, so allow the request time plus the stall time for it
  const r = await postWithRetry(`${p.baseUrl}/messages`, { "x-api-key": key, "anthropic-version": "2023-06-01" }, body, { signal, onRetry, timeoutMs: t.request + t.stall, label });
  const j = await r.json();
  let text = "";
  const toolCalls = [];
  for (const b of j.content || []) {
    if (b.type === "text") text += b.text;
    if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, args: b.input || {} });
  }
  if (text) onText(text);
  return { text, toolCalls, usage: j.usage ? { input: j.usage.input_tokens ?? 0, output: j.usage.output_tokens ?? 0 } : null, stopReason: j.stop_reason };
}

// Models a provider offers: [{ id, ctx, free, tools }] (null = unknown). Uses the source's public list when it has one.
export async function listModels(name, cfg = {}, env = process.env) {
  const p = resolveProvider(name, cfg);
  let key = null;
  try { key = keyFor(name, p, env); } catch (e) { if (!p.publicList) throw e; }
  const fetchJson = async (url) => {
    const r = await fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(20000) });
    if (!r.ok) { const e = new Error(`${r.status} ${(await r.text()).replace(/\s+/g, " ").slice(0, 200)}`); e.status = r.status; throw e; }
    return r.json();
  };
  let list;
  if (p.list) list = await p.list(fetchJson);
  else if (p.api === "openai") {
    const j = await fetchJson(`${p.baseUrl}/models`);
    list = (j.data || j.models || []).map((m) => ({ id: String(m.id || m.name || "").replace(/^models\//, ""), ctx: m.context_length ?? m.context_window ?? null, free: null, tools: null }));
  } else throw new Error(`listing models is not supported for ${name}; type the model id instead`);
  return list.filter((m) => m.id).sort((a, b) => a.id.localeCompare(b.id));
}
