// ~/.warden/config.json (created with safe defaults on first read)
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db.mjs";

export const DEFAULTS = {
  mode: "ask",                  // observe | ask. ("auto-on-stop" comes later.)
  provider: "claude-cli",
  model: null,                  // null = provider default
  roles: ["correctness", "test-gap", "security"],
  maxUsdPerRun: 0.5,            // hard cap per reviewer call
  maxUsdPerDay: 3,              // refuse new reviews once today's spend reaches this
  maxDiffChars: 60000,
  maxOutputTokens: 2000,        // bounds spend for API providers
  // Optional. Run specific roles on specific models, e.g.
  //   "reviewers": [{"role":"correctness","provider":"gemini","model":"<model>"},
  //                 {"role":"security","provider":"openai","model":"<model>"}]
  reviewers: null,
  // Arena judges, e.g. ["gemini:<model>", "openai:<model>"]. Judges that are also contestants are excluded.
  judges: ["claude-cli"],
  // Optional USD per 1M tokens, needed to cost API calls: "prices": {"gemini/<model>": {"in": 0, "out": 0}}
  prices: {},
  // Optional custom OpenAI-compatible servers: "providers": {"lmstudio": {"kind":"openai","baseUrl":"http://127.0.0.1:1234/v1","free":true}}
  providers: {},
};

const FILE = path.join(DATA_DIR, "config.json");

export function loadConfig() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
  return { ...DEFAULTS, ...user };
}
