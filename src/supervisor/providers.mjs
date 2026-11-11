// Provider adapters. Each: complete({system, prompt, model, ...}) -> {text, costUsd|null, usage}
//   claude-cli  your Claude Code login, no API key
//   anthropic   Messages API            (ANTHROPIC_API_KEY)
//   openai      Chat Completions        (OPENAI_API_KEY)
//   openrouter  OpenAI-compatible       (OPENROUTER_API_KEY), hundreds of models
//   gemini      generateContent         (GEMINI_API_KEY or GOOGLE_API_KEY)
//   ollama      local, OpenAI-compatible, free, no key
// Add any other OpenAI-compatible server (LM Studio, vLLM, ...) via config `providers`.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Neutral cwd with no hooks, so reviewer runs never trigger Warden's own hooks.
const NEUTRAL_CWD = fs.mkdtempSync(path.join(os.tmpdir(), "warden-reviewer-"));

function runClaude(args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn("claude", args, { cwd: NEUTRAL_CWD, windowsHide: true }); // claude.exe, no shell, so args are not mangled
    let out = "", err = "";
    const t = setTimeout(() => { p.kill(); reject(new Error("reviewer timed out")); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`)); });
    p.stdin.end(input);
  });
}

async function claudeCli({ system, prompt, model, maxUsd = 0.5, timeoutMs = 240_000 }) {
  const args = ["-p", "--output-format", "json", "--tools", "", "--no-session-persistence",
    "--max-budget-usd", String(maxUsd),
    // replace Claude Code's large default system prompt: it costs ~$0.4 per call and a reviewer doesn't need it
    "--system-prompt", system, "--exclude-dynamic-system-prompt-sections",
    // don't load your MCP servers, skills/slash commands or settings into a reviewer: pure token overhead
    "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", ""];
  if (model) args.push("--model", model);
  const j = JSON.parse(await runClaude(args, prompt, timeoutMs));
  if (j.is_error) throw new Error(j.result || "claude error");
  return { text: j.result, costUsd: j.total_cost_usd ?? 0, usage: j.usage };
}

// ---- HTTP providers -------------------------------------------------------

export const PRESETS = {
  anthropic:  { kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", keyEnv: ["ANTHROPIC_API_KEY"] },
  openai:     { kind: "openai", baseUrl: "https://api.openai.com/v1", keyEnv: ["OPENAI_API_KEY"], maxTokensParam: "max_completion_tokens" },
  openrouter: { kind: "openai", baseUrl: "https://openrouter.ai/api/v1", keyEnv: ["OPENROUTER_API_KEY"] },
  gemini:     { kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  ollama:     { kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", keyEnv: [], free: true },
};

function keyFor(name, spec) {
  if (!spec.keyEnv?.length) return null;
  for (const v of spec.keyEnv) if (process.env[v]) return process.env[v];
  throw new Error(`${name}: set ${spec.keyEnv.join(" or ")}`);
}

// Never echo response bodies into errors verbatim at length, and never include request headers.
async function post(name, url, headers, body, timeoutMs) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${name} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const kinds = {
  async anthropic({ name, spec, key, system, prompt, model, maxOutputTokens, timeoutMs }) {
    const j = await post(name, `${spec.baseUrl}/messages`, { "x-api-key": key, "anthropic-version": "2023-06-01" },
      { model, max_tokens: maxOutputTokens, system, messages: [{ role: "user", content: prompt }] }, timeoutMs);
    return { text: (j.content || []).map((b) => b.text || "").join(""), tokensIn: j.usage?.input_tokens, tokensOut: j.usage?.output_tokens };
  },
  async openai({ name, spec, key, system, prompt, model, maxOutputTokens, timeoutMs }) {
    // OpenAI wants max_completion_tokens; most compatible servers still use max_tokens
    const limit = { [spec.maxTokensParam || "max_tokens"]: maxOutputTokens };
    const j = await post(name, `${spec.baseUrl}/chat/completions`, key ? { authorization: `Bearer ${key}` } : {},
      { model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], ...limit }, timeoutMs);
    return { text: j.choices?.[0]?.message?.content ?? "", tokensIn: j.usage?.prompt_tokens, tokensOut: j.usage?.completion_tokens, reportedCost: j.usage?.cost };
  },
  async gemini({ name, spec, key, system, prompt, model, maxOutputTokens, timeoutMs }) {
    // key goes in a header, not the URL, so it can't leak into logs
    const j = await post(name, `${spec.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, { "x-goog-api-key": key },
      { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxOutputTokens } }, timeoutMs);
    const u = j.usageMetadata || {};
    return {
      text: (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""),
      tokensIn: u.promptTokenCount, tokensOut: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    };
  },
};

// Price lookup: user config `prices` = { "model-name" | "provider/model-name": { in, out } } in USD per 1M tokens.
// No built-in price table on purpose: prices change and wrong numbers are worse than "unknown".
export function priceFor(cfg, name, model) {
  const p = cfg.prices?.[`${name}/${model}`] ?? cfg.prices?.[model];
  return p && typeof p.in === "number" && typeof p.out === "number" ? p : null;
}

export function resolveSpec(cfg, name) {
  const spec = { ...PRESETS[name], ...(cfg.providers?.[name] || {}) };
  if (!spec.kind || !spec.baseUrl) throw new Error(`unknown provider "${name}". Built in: claude-cli, ${Object.keys(PRESETS).join(", ")}; or define it under config.providers`);
  return spec;
}

export function getProvider(name, cfg) {
  if (name === "claude-cli") return { name, complete: (o) => claudeCli({ ...o, maxUsd: cfg.maxUsdPerRun }) };
  const spec = resolveSpec(cfg, name);
  return {
    name,
    async complete({ system, prompt, model, timeoutMs = 240_000 }) {
      if (!model) throw new Error(`${name}: a model is required (config.model or the reviewer's model)`);
      const key = keyFor(name, spec);
      const r = await kinds[spec.kind]({ name, spec, key, system, prompt, model, maxOutputTokens: cfg.maxOutputTokens, timeoutMs });
      const price = priceFor(cfg, name, model);
      let costUsd = null;
      if (typeof r.reportedCost === "number") costUsd = r.reportedCost;
      else if (spec.free) costUsd = 0;
      else if (price && r.tokensIn != null && r.tokensOut != null) costUsd = (r.tokensIn * price.in + r.tokensOut * price.out) / 1e6;
      return { text: r.text, costUsd, usage: { tokensIn: r.tokensIn, tokensOut: r.tokensOut } };
    },
  };
}
