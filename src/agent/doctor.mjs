// `warden doctor`: checks the things that usually go wrong and says how to fix each one in plain words.
// Safe to paste when asking for help: keys are never printed, only where they come from.
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { VERSION } from "../version.mjs";
import { HOME, loadAgentConfig, pickDefaultModel, CONFIG_FILE } from "./config.mjs";
import { CATALOG, ADD_ORDER } from "./catalog.mjs";
import { keyStatus, parseModelSpec, resolveProvider, chat } from "./providers.mjs";
import { savedModels } from "./models.mjs";
import { detectShell } from "./tools.mjs";
import { isStandalone, fetchLatest, newer } from "./update.mjs";

export async function runDoctor({ testChat = false } = {}) {
  const cfg = loadAgentConfig();
  let problems = 0;
  const ok = (m) => console.log(`  ok    ${m}`);
  const bad = (m, fix) => { problems++; console.log(`  FIX   ${m}\n        -> ${fix}`); };
  const info = (m) => console.log(`  info  ${m}`);

  console.log(`\nWarden doctor (Warden ${VERSION}${isStandalone() ? ", standalone build" : ""})\n`);

  // Node
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj > 22 || (maj === 22 && min >= 13)) ok(`Node.js ${process.versions.node}`);
  else bad(`Node.js ${process.versions.node} is too old (Warden needs 22.13 or newer)`, "install the LTS version from https://nodejs.org, then reinstall Warden");
  info(`${os.platform()} ${os.release()} (${os.arch()}); shell for commands: ${detectShell().name}`);

  // git (used for project info, diffs and the arena)
  try { const v = execFileSync("git", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true }).trim(); ok(v); }
  catch { info("git not found. Warden works without it, but cannot show git status (install from https://git-scm.com)"); }

  // settings folder
  try { fs.mkdirSync(HOME, { recursive: true }); fs.accessSync(HOME, fs.constants.W_OK); ok(`settings folder ${HOME}`); }
  catch (e) { bad(`cannot write to ${HOME} (${e.code || e.message})`, "set WARDEN_HOME to a folder you can write to"); }
  if (fs.existsSync(CONFIG_FILE)) { try { JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { bad(`${CONFIG_FILE} is not valid JSON`, "fix or delete that file (Warden recreates it)"); } }

  // model + keys
  const model = cfg.model || pickDefaultModel();
  let provider;
  try { provider = parseModelSpec(model).provider; resolveProvider(provider, cfg); ok(`model ${model}`); }
  catch (e) { bad(`model "${model}": ${e.message}`, "run warden, then /add to pick a model"); }
  const withKey = ADD_ORDER.filter((n) => { try { return !/missing/.test(keyStatus(n, cfg)) && !CATALOG[n].local; } catch { return false; } });
  if (provider) {
    let st = ""; try { st = keyStatus(provider, cfg); } catch {}
    if (/missing/.test(st)) bad(`no key for ${provider}`, "run warden and follow the setup, or /add (free: Google Gemini, https://aistudio.google.com/apikey)");
    else ok(`${provider}: ${st}`);
  }
  info(`sources with a key: ${withKey.length ? withKey.join(", ") : "none"}; saved models: ${savedModels(cfg).length}`);

  // internet + the provider
  if (provider) {
    const p = resolveProvider(provider, cfg);
    try {
      const r = await fetch(`${p.baseUrl}/models`, { signal: AbortSignal.timeout(8000) });
      ok(`can reach ${new URL(p.baseUrl).host} (HTTP ${r.status})`);
    } catch (e) {
      if (p.local) bad(`cannot reach ${p.label} at ${p.baseUrl}`, `start ${p.label} and download a model, or pick another source with /add`);
      else bad(`cannot reach ${new URL(p.baseUrl).host} (${e.cause?.code || e.message})`, "check your internet connection, VPN or company proxy (set HTTPS_PROXY if you use one)");
    }
  }
  if (testChat && provider) {
    try {
      const r = await chat({ spec: model, cfg, system: "Reply with the single word: ready", messages: [{ role: "user", content: "ping" }], maxOutputTokens: 20 });
      ok(`${model} answered: "${r.text.trim().slice(0, 40)}"`);
    } catch (e) { bad(`${model} did not answer: ${e.message.slice(0, 200)}`, /401|403|key/i.test(e.message) ? "the key is wrong or expired: /add it again" : /429/.test(e.message) ? "quota used up: try another model with /model" : "try another model with /add"); }
  } else info("add --chat to also send one tiny test message to the model (uses one request of your quota)");

  // version
  try { const latest = await fetchLatest(5000); if (newer(latest, VERSION)) info(`Warden ${latest} is available: warden update`); else ok("Warden is up to date"); }
  catch { info("could not check for updates (offline, or not published yet)"); }

  console.log(problems ? `\n${problems} thing${problems > 1 ? "s" : ""} to fix (see FIX above).\n` : "\nEverything looks fine.\n");
  return problems ? 1 : 0;
}
