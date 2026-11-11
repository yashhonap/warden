// Builds a single-file Warden executable that includes Node.js (Node "single executable application").
//   node scripts/build-standalone.mjs        -> dist/warden-<os>-<arch>[.exe]
// Uses the Node.js that runs this script, so build each OS on that OS (the release workflow does this).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { VERSION } from "../src/version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const os = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform] || process.platform;
const exeName = `warden-${os}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`;
const exe = path.join(dist, exeName);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" && !path.isAbsolute(cmd) });

// 1. one CommonJS file (the SEA entry must be a script), with the dashboard page embedded as an asset
await build({
  entryPoints: [path.join(root, "src/cli.mjs")], bundle: true, platform: "node", format: "cjs", target: "node22",
  outfile: path.join(dist, "warden.cjs"), define: { __WARDEN_SEA__: "true" }, logLevel: "warning", legalComments: "none",
});
const bundlePath = path.join(dist, "warden.cjs");
fs.writeFileSync(bundlePath, fs.readFileSync(bundlePath, "utf8").replace(/^#!.*\n/, "")); // a shebang is not valid inside the SEA wrapper

// 2. the SEA blob
const seaConfig = path.join(dist, "sea-config.json");
fs.writeFileSync(seaConfig, JSON.stringify({
  main: bundlePath, output: path.join(dist, "sea-prep.blob"), disableExperimentalSEAWarning: true, useCodeCache: false,
  assets: { "dashboard.html": path.join(root, "src/supervisor/dashboard/index.html") },
}));
run(process.execPath, ["--experimental-sea-config", seaConfig]);

// 3. copy this node binary and inject the blob
fs.copyFileSync(process.execPath, exe);
if (process.platform === "darwin") run("codesign", ["--remove-signature", exe]);
const postject = path.join(root, "node_modules", "postject", "dist", "cli.js");
run(process.execPath, [postject, exe, "NODE_SEA_BLOB", path.join(dist, "sea-prep.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])]);
if (process.platform === "darwin") run("codesign", ["--sign", "-", exe]);

// 4. smoke test: the binary must report the right version
const out = execFileSync(exe, ["--version"], { encoding: "utf8" }).trim();
if (out !== VERSION) throw new Error(`built binary says "${out}", expected ${VERSION}`);
for (const f of ["warden.cjs", "sea-config.json", "sea-prep.blob"]) fs.rmSync(path.join(dist, f));
console.log(`built ${path.relative(root, exe)} (${(fs.statSync(exe).size / 1e6).toFixed(0)} MB), version ${out}`);
