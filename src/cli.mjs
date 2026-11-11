#!/usr/bin/env node
// warden                      interactive coding agent in this folder
// warden "fix the tests"      same, starting with that message
// warden -p "task"            one-shot, no interface (answer on stdout)
// warden doctor | update | --version
// warden daemon|watch|review|arena|...   the supervisor tools (watch and review Claude Code, compare models)
// (No top-level await here: the standalone build bundles this file as CommonJS.)
import { VERSION } from "./version.mjs";

const SUPERVISOR = new Set(["daemon", "watch", "sessions", "replay", "diff", "review", "reviews", "arena", "harnesses"]);

const HELP = `Warden ${VERSION}: a coding agent for any model, in your terminal.

Usage:
  warden                         start a conversation in this folder (first run walks you through getting a free key)
  warden "message"               start with a message
  warden -p "message"            answer once and exit (for scripts); add --json for JSON output
  warden --continue              continue the last conversation in this folder
  warden --resume [id]           resume a conversation by id (or the last one here)
  warden doctor [--chat]         check your setup and say how to fix problems
  warden update                  update to the latest version
  warden --version

Options:
  --model <name or provider/model>   e.g. gemini/gemini-2.5-flash, or a name saved with /add
  --mode ask|auto-edit|yolo          ask: approve edits and commands (default)
                                     auto-edit: file edits in this folder run without asking
                                     yolo: everything runs without asking

Inside Warden: /add to add models (free ones too), /model to switch, /help for the rest.

Supervisor tools (record and review Claude Code, compare models):
  warden daemon | watch | sessions | replay <id> | diff <id> | review <id> | reviews <id>
  warden arena run <task.json> | board | show <run> | rate ...    warden harnesses`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] && SUPERVISOR.has(argv[0])) { await import("./supervisor/cli.mjs"); return; } // it reads process.argv itself
  if (argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return; }
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") { console.log(VERSION); return; }
  if (argv[0] === "doctor") { const { runDoctor } = await import("./agent/doctor.mjs"); process.exitCode = await runDoctor({ testChat: argv.includes("--chat") }); return; }
  if (argv[0] === "update") { const { runUpdate } = await import("./agent/update.mjs"); process.exitCode = await runUpdate(); return; }

  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const flagsWithValue = new Set(["--model", "-m", "--mode", "-p", "--print", "--resume"]);
  const model = opt("--model") ?? opt("-m");
  const mode = opt("--mode");
  const printIdx = Math.max(argv.indexOf("-p"), argv.indexOf("--print"));
  if (printIdx >= 0) {
    const prompt = argv[printIdx + 1];
    if (!prompt) { console.error('usage: warden -p "message"'); process.exitCode = 2; return; }
    const { runHeadless } = await import("./agent/headless.mjs");
    process.exitCode = await runHeadless({ prompt, model, mode, json: argv.includes("--json") });
    return;
  }
  let resume;
  const ri = argv.indexOf("--resume");
  if (ri >= 0) resume = argv[ri + 1] && !argv[ri + 1].startsWith("-") ? argv[ri + 1] : true;
  if (argv.includes("--continue") || argv.includes("-c")) resume = true;
  // first bare word(s) not belonging to a flag = initial message
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    if (flagsWithValue.has(argv[i])) { i++; continue; }
    if (argv[i].startsWith("-")) continue;
    words.push(argv[i]);
  }
  const { startApp } = await import("./tui/app.mjs");
  await startApp({ model, mode, resume, initialPrompt: words.join(" ") || undefined });
}

main().catch((e) => { console.error(`warden: ${e?.stack || e}`); process.exitCode = 1; });
