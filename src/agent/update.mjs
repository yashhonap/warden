// Update notice: at most once a day Warden asks the npm registry for the latest version number of warden-agent.
// Nothing about you or your code is sent; it is a plain GET of a public URL. Turn it off with
// WARDEN_NO_UPDATE_CHECK=1 or "updateCheck": false under "agent" in ~/.warden/config.json.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { isSea } from "node:sea";
import { HOME } from "./config.mjs";
import { VERSION, PACKAGE, REPO } from "../version.mjs";

const FILE = path.join(HOME, "update.json");
const DAY = 24 * 3600 * 1000;

export function newer(a, b) { // is a newer than b? (x.y.z)
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

export const updateCheckEnabled = (cfg) => !process.env.WARDEN_NO_UPDATE_CHECK && cfg.updateCheck !== false;

function read() { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; } }

// Returns the newer version seen on the last check (or null), and refreshes in the background when due.
export function updateNotice(cfg) {
  if (!updateCheckEnabled(cfg)) return null;
  const st = read();
  if (!st.checked || Date.now() - st.checked > DAY) refresh().catch(() => {});
  return st.latest && newer(st.latest, VERSION) ? st.latest : null;
}

export async function fetchLatest(timeoutMs = 4000) {
  const r = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`registry answered ${r.status}`);
  return (await r.json()).version;
}

async function refresh() {
  let latest = null;
  try { latest = await fetchLatest(); } catch {}
  try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ checked: Date.now(), latest })); } catch {}
}

// Standalone builds (warden.exe) cannot update through npm.
export const isStandalone = () => { try { return isSea(); } catch { return false; } };

export async function runUpdate() {
  let latest;
  try { latest = await fetchLatest(8000); } catch (e) { console.error(`Could not reach the npm registry: ${e.message}`); return 1; }
  if (!newer(latest, VERSION)) { console.log(`Warden ${VERSION} is the latest version.`); return 0; }
  if (isStandalone()) {
    console.log(`Warden ${latest} is available (you have ${VERSION}). Download it from https://github.com/${REPO}/releases/latest`);
    return 0;
  }
  console.log(`Updating Warden ${VERSION} -> ${latest} with: npm install -g ${PACKAGE}@latest`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((res) => {
    const p = spawn(npm, ["install", "-g", `${PACKAGE}@latest`], { stdio: "inherit", shell: process.platform === "win32" });
    p.on("close", (code) => res(code ?? 1));
    p.on("error", (e) => { console.error(`Could not run npm: ${e.message}`); res(1); });
  });
}
