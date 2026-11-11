// Models you added with /add, saved in ~/.warden/config.json under agent.models:
//   [{ name: "nemotron-free", spec: "openrouter/nvidia/nemotron-3.5-lightning:free", ctx: 262144, tools: "native" | "text" | "none" | null }]
// tools = how this model gets to use Warden's tools: its own tool calling, the text fallback, or chat only.
import { saveAgentConfig } from "./config.mjs";
import { chat, toolsUnsupported } from "./providers.mjs";

export const savedModels = (cfg) => (Array.isArray(cfg.models) ? cfg.models : []);

export function findModel(cfg, nameOrSpec) {
  return savedModels(cfg).find((m) => m.name === nameOrSpec) || savedModels(cfg).find((m) => m.spec === nameOrSpec) || null;
}

// "nemotron-free" -> its spec; "provider/model" passes through.
export function resolveModelInput(cfg, input) {
  const s = String(input || "").trim();
  const hit = savedModels(cfg).find((m) => m.name === s);
  if (hit) return hit.spec;
  if (s.includes("/")) return s;
  throw new Error(`no saved model called "${s}". /model lists them; /add adds one; or use provider/model`);
}

function persist(cfg, models) { cfg.models = models; saveAgentConfig({ models }); }

export function addModel(cfg, entry) {
  const models = savedModels(cfg).filter((m) => m.name !== entry.name && m.spec !== entry.spec);
  models.push(entry);
  persist(cfg, models);
}

export function removeModel(cfg, name) {
  const before = savedModels(cfg);
  const after = before.filter((m) => m.name !== name);
  if (after.length === before.length) return false;
  persist(cfg, after);
  return true;
}

export function removeModelsOf(cfg, provider) {
  const after = savedModels(cfg).filter((m) => !m.spec.startsWith(provider + "/"));
  const n = savedModels(cfg).length - after.length;
  if (n) persist(cfg, after);
  return n;
}

export function toolModeFor(cfg, spec) { return findModel(cfg, spec)?.tools || "native"; }

export function setToolMode(cfg, spec, mode) {
  const models = savedModels(cfg).map((m) => (m.spec === spec ? { ...m, tools: mode } : m));
  if (!models.some((m) => m.spec === spec)) return; // only remembered for saved models
  persist(cfg, models);
}

// Short readable default name from a model id: "nvidia/nemotron-3.5-lightning:free" -> "nemotron-3.5-lightning-free"
export function suggestName(id) {
  const last = String(id).split("/").pop();
  return last.replace(/:free$/, "-free").replace(/[^\w.-]+/g, "-").toLowerCase().slice(0, 40);
}

const PING = [{ name: "ping", description: "Health check. Call it whenever you are asked to.", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } }];
const ASK = [{ role: "user", content: "Call the ping tool with message \"hello\". Do not reply with text." }];

/**
 * Works out how a model can use tools. Returns { mode: "native" | "text" | "none", detail }.
 * Throws for errors unrelated to tools (bad key, unknown model, no credits) so the caller can show them.
 */
export async function probeToolSupport(spec, cfg, { signal, onRetry } = {}) {
  const base = { spec, cfg, signal, onRetry, system: "You are a test harness. Follow the instruction exactly.", maxOutputTokens: 300 };
  try {
    const r = await chat({ ...base, messages: ASK, tools: PING, toolMode: "native" });
    if (r.toolCalls.some((c) => c.name === "ping")) return { mode: "native", detail: "uses its own tool calling" };
  } catch (e) {
    if (!toolsUnsupported(e)) throw e;
  }
  const r2 = await chat({ ...base, messages: ASK, tools: PING, toolMode: "text" });
  if (r2.toolCalls.some((c) => c.name === "ping")) return { mode: "text", detail: "no native tool calling; Warden's text format works" };
  return { mode: "none", detail: "could not call tools either way; chat only (it cannot read or edit files)" };
}
