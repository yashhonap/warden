// Release checks: version numbers agree, --version/--help work, first run helps someone with no key,
// and `warden doctor` explains a missing key. Offline (doctor's network checks may fail; that is fine).
// Run: node test/meta.mock.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { VERSION } from "../src/version.mjs";
import { newer } from "../src/agent/update.mjs";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(pkg.version, VERSION, "package.json and src/version.mjs must agree");
assert.ok(pkg.files.includes("src") && pkg.bin.warden === "src/cli.mjs");

assert.equal(newer("0.10.0", "0.9.9"), true); assert.equal(newer("0.4.0", "0.4.0"), false); assert.equal(newer("0.3.9", "0.4.0"), false);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "warden-meta-test-"));
// a person with no keys at all: strip every key variable
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/API_KEY|HF_TOKEN|_TOKEN$/i.test(k)));
const env = { ...cleanEnv, WARDEN_HOME: path.join(tmp, "home"), NO_COLOR: "1", WARDEN_NO_UPDATE_CHECK: "1" };
const run = (args, input = "") => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(root, "src/cli.mjs"), ...args], { cwd: tmp, env });
  let o = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d));
  p.stdin.end(input); p.on("close", (code) => resolve({ o, code }));
});

let r = await run(["--version"]);
assert.equal(r.o.trim(), VERSION);
r = await run(["--help"]);
assert.match(r.o, /warden doctor/); assert.match(r.o, /\/add/);

// first run: no key -> welcome + the /add list with Gemini first; enter skips; nothing is sent anywhere
r = await run([], "\n/exit\n");
assert.match(r.o, /Welcome to Warden/);
assert.match(r.o, /aistudio\.google\.com\/apikey/);
assert.match(r.o, / 1 {2}○ Google Gemini/);
assert.match(r.o, /Saved conversation/);
assert.ok(!fs.existsSync(path.join(tmp, "home", "credentials.json")), "skipping setup saves no key");

// doctor names the missing key and the fix, and exits non-zero
r = await run(["doctor"]);
assert.match(r.o, /FIX\s+no key for gemini/);
assert.match(r.o, /aistudio\.google\.com\/apikey/);
assert.notEqual(r.code, 0);

console.log("meta.mock: all assertions passed");
