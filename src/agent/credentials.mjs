// API keys pasted into /add are stored in ~/.warden/credentials.json (plain text, readable only by your user account
// where the OS allows). Environment variables always take priority over saved keys.
import fs from "node:fs";
import path from "node:path";
import { HOME } from "./config.mjs";

export const CREDENTIALS_FILE = path.join(HOME, "credentials.json");

function readAll() {
  try { return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8")) || {}; } catch { return {}; }
}

export function savedKey(provider) {
  const v = readAll()[provider];
  return typeof v === "string" && v ? v : null;
}

export function saveKey(provider, key) {
  const all = readAll();
  all[provider] = String(key).trim();
  writeAll(all);
}

export function removeKey(provider) {
  const all = readAll();
  if (!(provider in all)) return false;
  delete all[provider];
  writeAll(all);
  return true;
}

function writeAll(all) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CREDENTIALS_FILE, 0o600); } catch {}
}

export const mask = (k) => (k && k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : "****");
