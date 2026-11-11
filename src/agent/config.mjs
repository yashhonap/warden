// Agent settings live in ~/.warden/config.json under "agent" (the supervisor uses the rest of that file).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = process.env.WARDEN_HOME || path.join(os.homedir(), ".warden");
export const CONFIG_FILE = path.join(HOME, "config.json");
export const SESSIONS_DIR = path.join(HOME, "sessions");

export const AGENT_DEFAULTS = {
  model: null,               // "provider/model"; null = pick from the API keys you have
  mode: "ask",               // ask | auto-edit | yolo
  maxOutputTokens: 8192,
  maxSteps: 60,              // model calls per user message before Warden stops and asks you
  contextTokens: 120000,     // rough budget; old tool output is trimmed above this
  providers: {},             // extra or overridden providers: { "name": { "api": "openai", "baseUrl": "...", "keyEnv": ["ENV"] } }
  recentModels: [],
};

function readAll() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; }
}

export function loadAgentConfig() {
  return { ...AGENT_DEFAULTS, ...(readAll().agent || {}) };
}

// Saves only the given keys, preserving everything else in the file (including supervisor settings).
export function saveAgentConfig(patch) {
  const all = readAll();
  all.agent = { ...(all.agent || {}), ...patch };
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(all, null, 2));
}

// First model we can actually use, based on which keys are set.
export function pickDefaultModel(env = process.env) {
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return "gemini/gemini-2.5-flash";
  if (env.GROQ_API_KEY) return "groq/llama-3.3-70b-versatile";
  if (env.OPENROUTER_API_KEY) return "openrouter/openrouter/auto";
  if (env.ANTHROPIC_API_KEY) return "anthropic/claude-sonnet-5-5";
  if (env.OPENAI_API_KEY) return "openai/gpt-4.1-mini";
  return "gemini/gemini-2.5-flash";
}
