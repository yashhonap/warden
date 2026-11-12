// Warden interactive terminal app: chat with any model, which reads, edits and runs code in this folder.
import readline from "node:readline";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { C, MarkdownStream, Spinner, toolHeader, toolBody, fmtTokens, stripAnsi } from "./render.mjs";
import { runTurn } from "../agent/loop.mjs";
import { Session } from "../agent/session.mjs";
import { loadAgentConfig, saveAgentConfig, pickDefaultModel, CONFIG_FILE } from "../agent/config.mjs";
import { parseModelSpec, keyStatus, listModels, resolveProvider } from "../agent/providers.mjs";
import { MODES, detectShell, listJobs, stopJob, jobRunning, describeJob } from "../agent/tools.mjs";
import { CATALOG, ADD_ORDER } from "../agent/catalog.mjs";
import { saveKey, removeKey, mask, CREDENTIALS_FILE } from "../agent/credentials.mjs";
import { savedModels, findModel, resolveModelInput, addModel, removeModel, removeModelsOf, suggestName, probeToolSupport } from "../agent/models.mjs";

import { VERSION } from "../version.mjs";
import { updateNotice } from "../agent/update.mjs";
const COMMANDS = {
  "/help": "show commands",
  "/add": "add a model: pick a source (OpenRouter, Hugging Face, NVIDIA, DeepSeek, Ollama…), paste a key, pick a model",
  "/model": "pick from your saved models, or /model <name> or /model provider/model",
  "/models": "browse a source's models: /models openrouter nemotron --free",
  "/providers": "which sources are connected",
  "/remove": "remove a saved model, or a source's saved key: /remove <name>",
  "/mode": "permission mode: ask | auto-edit | yolo (also shift+tab)",
  "/clear": "start a new conversation",
  "/resume": "continue an earlier conversation",
  "/usage": "tokens used in this conversation",
  "/jobs": "background commands the model started (dev servers…); /jobs stop <id>",
  "/init": "have the model write a WARDEN.md with notes about this project",
  "/exit": "quit (also ctrl+d)",
};

export async function startApp({ cwd = process.cwd(), model, mode, resume, initialPrompt } = {}) {
  const cfg = loadAgentConfig();
  const out = process.stdout;
  const tty = !!process.stdin.isTTY;
  let session;
  if (resume) {
    try { session = resume === true ? latestFor(cwd) : Session.load(resume); } catch (e) { console.error(C.red(e.message)); }
  }
  // --model accepts a saved name too
  if (model) { try { model = resolveModelInput(cfg, model); } catch (e) { console.error(C.red(e.message)); model = undefined; } }
  session ||= new Session({ cwd, model: model || cfg.model || pickDefaultModel() });
  if (model) session.model = model;
  const perm = { mode: MODES.includes(mode) ? mode : MODES.includes(cfg.mode) ? cfg.mode : "ask", allowed: new Set() };

  let busy = false, controller = null, lastSigint = 0, pending = [], flushTimer = null, closed = false;

  const rl = readline.createInterface({
    input: process.stdin, output: out, terminal: tty, historySize: 200,
    completer: (line) => {
      if (!line.startsWith("/")) return [[], line];
      const m = line.match(/^\/(model|remove) (.*)$/);
      if (m) { const opts = savedModels(cfg).map((x) => `/${m[1]} ${x.name}`).filter((o) => o.startsWith(line)); return [opts, line]; }
      const hits = Object.keys(COMMANDS).filter((c) => c.startsWith(line));
      return [hits.length ? hits : Object.keys(COMMANDS), line];
    },
  });
  const promptStr = () => `${C.accent("›")} `;
  rl.setPrompt(promptStr());
  // While the model works, readline keeps reading keys (so you can type your next message) but draws them into this
  // silent stream instead of the screen, where they would mix with the model's output. What you type shows in the
  // status line; Enter queues it for the model.
  const sink = new Writable({ write(_c, _e, cb) { cb(); } });
  sink.isTTY = true;
  Object.defineProperty(sink, "columns", { get: () => out.columns || 80 });
  const echo = (on) => { if (tty) rl.output = on ? out : sink; };
  let questions = 0, cancelQuestion = null;
  // A question during a turn (approve this edit?) must not pick up the half-typed next message, and must be
  // answerable even though echo is off; esc / ctrl+c cancels it.
  const ask = (q) => new Promise((res) => {
    const draft = rl.line || "";
    rl.line = ""; rl.cursor = 0;
    questions++; echo(true);
    cancelQuestion = () => { rl.line = ""; rl.cursor = 0; rl.write("\n"); };
    rl.question(q, (a) => {
      questions--; cancelQuestion = null;
      if (busy && !questions) echo(false);
      rl.line = draft; rl.cursor = draft.length;
      res(a);
    });
  });
  // In piped mode a question takes the next input line, waiting for it if it has not arrived yet
  // (end of input = the default). Lines never leak past a question into the conversation.
  const waiters = [];
  const nextLine = (dflt) => (queue.length ? Promise.resolve(queue.shift()) : closed ? Promise.resolve(dflt) : new Promise((res) => waiters.push({ res, dflt })));
  const answer = async (q, dflt = "n") => { if (tty) return ask(q); const a = await nextLine(dflt); out.write(q + a + "\n"); return a; };
  // Hidden input for API keys: shows * per character and keeps the key out of the input history.
  const askSecret = async (q) => {
    if (!tty) { const a = await nextLine(""); out.write(q + (a ? "*".repeat(Math.min(a.length, 12)) : "") + "\n"); return a; }
    return new Promise((res) => {
      const orig = rl._writeToOutput;
      rl._writeToOutput = (s) => {
        if (s.includes(q)) out.write(q + "*".repeat(Math.min(rl.line.length, 40)));
        else if (/^[\r\n]+$/.test(s)) out.write(s);
        else out.write("*".repeat(s.length));
      };
      rl.question(q, (a) => {
        rl._writeToOutput = orig;
        if (Array.isArray(rl.history)) rl.history = rl.history.filter((h) => h !== a);
        res(a);
      });
    });
  };

  // ---------- banner ----------
  banner();
  if (session.messages.length) console.log(C.dim(`  Resumed "${session.title || session.id}" (${session.messages.length} messages)\n`));

  // shift+tab cycles the permission mode while idle; esc interrupts the model (like ctrl+c)
  if (tty) {
    readline.emitKeypressEvents(process.stdin, rl);
    process.stdin.on("keypress", (_s, key) => {
      if (key?.name === "escape") {
        // readline has just put the raw ESC character into the input line; take it out again
        if (rl.line.includes("\x1b")) { const before = rl.line.slice(0, rl.cursor).replace(/\x1b/g, ""); rl.line = rl.line.replace(/\x1b/g, ""); rl.cursor = before.length; }
        if (busy) interrupt(); else rl.prompt(true);
        return;
      }
      if (!busy && key?.name === "tab" && key.shift) {
        perm.mode = MODES[(MODES.indexOf(perm.mode) + 1) % MODES.length];
        readline.clearLine(out, 0); readline.cursorTo(out, 0);
        out.write(C.dim(`  mode: ${modeLabel(perm.mode)}\n`));
        rl.prompt(true);
      }
    });
  }

  // Stops the running turn. Also answers an open approval question with "no" so nothing waits for Enter.
  function interrupt() {
    if (!busy || !controller) return false;
    if (controller.signal.aborted) return true;
    controller.abort();
    status.print(C.yellow("  Interrupting…"));
    cancelQuestion?.();
    return true;
  }

  rl.on("SIGINT", () => {
    if (busy && controller) {
      // a second ctrl+c while still stopping quits, in case something refuses to stop
      if (controller.signal.aborted && Date.now() - lastSigint < 2000) { out.write(C.red("\n  Quitting.\n")); return quit(); }
      lastSigint = Date.now();
      interrupt();
      return;
    }
    if (rl.line) { rl.write(null, { ctrl: true, name: "u" }); return; }
    if (Date.now() - lastSigint < 1500) return quit();
    lastSigint = Date.now();
    out.write(C.dim("\n  (press ctrl+c again to quit)\n")); rl.prompt();
  });
  // Piped input (not a terminal): every line is one message, processed in order, then quit at end of input.
  const queue = [];
  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      try { await handle(queue.shift()); }
      catch (e) { status.stop(); console.log(C.red(`  Something went wrong: ${e?.message || e}\n`)); }
    }
    draining = false;
    if (closed) quit();
  }

  rl.on("close", () => {
    closed = true;
    while (waiters.length) { const w = waiters.shift(); w.res(w.dflt); } // unanswered questions get their default
    if (!busy && !draining) quit();
  });

  rl.on("line", (line) => {
    if (!tty) {
      if (waiters.length) { waiters.shift().res(line); return; } // a question is waiting for this line
      queue.push(line); drain(); return;
    }
    if (busy) { queueWhileBusy(line); return; }
    // Lines that arrive within a few ms are one pasted message; a trailing "\" continues on the next line.
    pending.push(line);
    clearTimeout(flushTimer);
    if (line.endsWith("\\")) { pending[pending.length - 1] = line.slice(0, -1); rl.setPrompt(C.dim("… ")); rl.prompt(); return; }
    flushTimer = setTimeout(() => { const text = pending.join("\n"); pending = []; rl.setPrompt(promptStr()); runInput(text); }, 25);
  });

  // Runs one message or command, never leaving you without a prompt, even if something throws.
  async function runInput(text) {
    try { await handle(text); }
    catch (e) { status.stop(); console.log(C.red(`  Something went wrong: ${e?.message || e}`) + C.dim("\n  Warden is still running; you can keep chatting.\n")); }
    if (closed) return quit();
    afterTurn();
  }

  // Back to the prompt. Messages typed during the turn that the model never got (it was interrupted, failed, or
  // finished in the same moment) go back on the prompt line to send, edit or clear.
  function afterTurn() {
    if (!tty) return;
    echo(true);
    rl.prevRows = 0; // readline measured the draft against the silent stream; draw on a fresh line
    const left = takeQueued();
    if (left) {
      const draft = left.replace(/\n/g, " ") + (rl.line ? " " + rl.line : "");
      rl.line = draft; rl.cursor = draft.length;
      console.log(C.dim("  Your message was not sent yet; it is on the prompt below. Press enter to send it, or ctrl+c to clear it."));
    }
    rl.prompt(true);
  }

  // Lines typed while the model works.
  const typed = [];
  function takeQueued() { if (!typed.length) return null; const t = typed.join("\n"); typed.length = 0; return t; }
  function queueWhileBusy(line) {
    const t = line.trim();
    if (!t || questions) return;
    if (t.startsWith("/") || t.startsWith("!")) {
      status.note(C.yellow(`  ${t.split(/\s+/)[0]} has to wait until Warden is idle. Press esc to interrupt, or type it again when it is done.`));
      return;
    }
    typed.push(t);
    status.note(`  ${C.accent("↳")} ${C.dim("queued; the model gets it at its next step:")} ${t.length > 120 ? t.slice(0, 120) + "…" : t}`);
  }

  // The status line during a turn: one spinner shared by thinking, writing and running tools. Notes printed while
  // the model is streaming text wait until the text ends, so they never land in the middle of a sentence.
  const status = {
    spin: new Spinner(out, C, { hint: "esc to interrupt", extra: () => (rl.line ? ` · ✎ ${rl.line}` : typed.length ? ` · ${typed.length} queued` : "") }),
    streaming: false, later: [],
    start(label) { this.spin.stop(); this.spin.start(label); },
    stop() { this.spin.stop(); },
    print(line) { if (this.streaming) this.later.push(line); else this.spin.print(line); },
    note(line) { this.print(line); },
    flush() { const l = this.later; this.later = []; for (const x of l) this.spin.print(x); },
  };

  // First run (no usable key for the current model): walk the person through getting one, then start.
  (async () => {
    if (needsSetup()) await firstRun();
    if (initialPrompt) { queue.push(initialPrompt); await drain(); }
    if (tty && !closed) rl.prompt();
  })();

  function needsSetup() {
    try { return /missing/.test(keyStatus(parseModelSpec(session.model).provider, cfg)); } catch { return false; }
  }

  async function firstRun() {
    console.log(`  ${C.bold("Welcome to Warden.")} It needs one AI model to work. The easiest free one is ${C.bold("Google Gemini")}:`);
    console.log(`    1. Open ${C.accent("https://aistudio.google.com/apikey")} and sign in with a Google account`);
    console.log(`    2. Click ${C.bold("Create API key")} and copy it`);
    console.log(`    3. Pick ${C.bold("1")} below and paste the key`);
    console.log(C.dim(`  Other free sources are listed too. Press enter to skip; /add starts this again any time. Stuck? Run: warden doctor`));
    await addWizard();
  }

  // ---------- handlers ----------
  async function handle(raw) {
    const text = raw.trim();
    if (!text) return;
    if (!tty) console.log(`${C.accent("›")} ${text}`);
    if (text.startsWith("/")) return command(text);
    if (text.startsWith("!")) return shellPassthrough(text.slice(1).trim());
    await turn(text);
  }

  async function turn(text) {
    busy = true; controller = new AbortController();
    echo(false);
    const md = new MarkdownStream(out, C);
    const t0 = Date.now(), before = { ...session.usage };
    const modelName = findModel(cfg, session.model)?.name || session.model;
    let reasoning = 0, writing = null, toolOut = "";
    console.log();
    // what the status line says while the model works
    const thinkingLabel = () => {
      if (writing) return `Writing ${writing.what} (${fmtChars(writing.chars)})`;
      if (reasoning) return `Thinking (${fmtChars(reasoning)} of reasoning)`;
      return status.spin.elapsed() > 20_000 ? `Waiting for ${modelName} (no reply yet)` : "Thinking";
    };
    const endText = () => { if (status.streaming) { status.streaming = false; if (md.end()) out.write("\n"); status.flush(); } };
    const ui = {
      onAssistantStart: () => { reasoning = 0; writing = null; status.start(thinkingLabel); },
      onReasoning: (d) => { reasoning += d.length; },
      onToolDelta: (name, args) => {
        if (status.streaming) { endText(); status.start(thinkingLabel); }
        const file = /"path"\s*:\s*"([^"]{1,120})"/.exec(args || "")?.[1];
        writing = { what: file ? file.replace(/\\\\/g, "\\") : name || "a tool call", chars: (args || "").length }; // JSON doubles backslashes in Windows paths
      },
      onText: (d) => { if (!status.streaming) { status.stop(); status.streaming = true; } md.write(d); },
      onAssistantEnd: () => { status.stop(); endText(); },
      onRetry: ({ status: st, waitMs, attempt }) => status.spin.setLabel(st === "no response" ? `${modelName} did not respond; trying again` : `Rate limited (${st}), retrying in ${Math.round(waitMs / 1000)}s, attempt ${attempt}`),
      onNotice: (m) => status.print(C.dim(`  ${m}\n`)),
      takeQueued: () => (tty ? takeQueued() : null),
      onQueuedDelivered: (t) => { endText(); status.stop(); console.log(`${C.accent("›")} ${t}  ${C.gray("(sent while Warden was working)")}\n`); },
      onToolStart: (call, tool) => {
        status.stop(); call._shown = false; toolOut = "";
        status.start(() => `${defaultTitle(tool, call.args).slice(0, 70)}${toolOut ? " · " + toolOut : ""}`);
      },
      onToolApproved: (call, tool) => { status.start(() => `Running ${defaultTitle(tool, call.args).slice(0, 60)}${toolOut ? " · " + toolOut : ""}`); },
      onToolOutput: (call, s) => { const last = stripAnsi(s).split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean).pop(); if (last) toolOut = last.slice(0, 80); },
      confirm: async (call, tool, desc) => {
        status.stop();
        showTool(call, tool, null, "run"); call._shown = true;
        const kind = tool.kind === "bash" ? "Run this command" : tool.kind === "edit" ? "Allow this change" : "Allow reading outside the project";
        if (tool.kind === "edit" && call.args?.old_string !== undefined) previewEdit(call.args);
        for (;;) {
          const a = (await answer(`  ${C.yellow("?")} ${kind}? ${C.dim(`[y] yes  [a] always allow ${tool.name} this session  [n] no, or type what to do instead`)}\n  ${C.accent("›")} `)).trim();
          if (controller.signal.aborted) return "no";
          if (/^(y|yes)$/i.test(a)) return "yes";
          if (/^(a|always)$/i.test(a)) return "always";
          if (/^(n|no)$/i.test(a)) return "no";
          if (a) return { reason: a };
        }
      },
      onToolEnd: (call, tool, res) => {
        status.stop();
        const state = res?.denied ? "deny" : res?.error ? "err" : res?.isError ? "err" : "ok";
        showTool(call, tool, res, state, call._shown);
        console.log();
      },
    };
    try {
      const r = await runTurn({ session, userText: text, cfg, ui, perm, signal: controller.signal, cwd });
      status.stop(); endText();
      if (r.interrupted) console.log(C.yellow("  Interrupted.") + C.dim(" The conversation is kept; say what to do next.\n"));
    } catch (e) {
      status.stop(); endText();
      console.log(C.red(`  Error: ${e.message}`));
      if (e.timeout) console.log(C.dim("  Nothing was lost: your message and everything so far are still in the conversation. Send it again or say \"continue\"."));
      else if (/API key|no API key/i.test(e.message)) console.log(C.dim(`  Set the key as an environment variable, or pick another model with /model. Providers: /model`));
      else if (/^4(01|03)/.test(e.message)) console.log(C.dim("  The provider rejected the key or the request. Check the key and the model name (/models <provider>)."));
      else if (/^404/.test(e.message)) console.log(C.dim("  Model not found. See what this provider offers with /models <provider>."));
      else if (/^429/.test(e.message)) console.log(C.dim("  This model's rate limit or free quota is used up. Switch with /model (another model usually has its own quota), or /add a free one."));
      else if (/^413|too large|context length|maximum context|too many tokens/i.test(e.message)) console.log(C.dim("  The conversation got too long for this model. Start a fresh one with /clear (your files are unchanged), or pick a model with a bigger context."));
      console.log();
    } finally {
      status.stop(); status.streaming = false; status.later = [];
      busy = false; controller = null;
      echo(true); rl.prevRows = 0; // whatever started this turn (typed, `warden "task"`, /init), typing is visible again
      const u = session.usage;
      const tin = u.input - before.input, tout = u.output - before.output;
      console.log(C.gray(`  ${session.model} · ${tin || tout ? `${fmtTokens(tin)} in / ${fmtTokens(tout)} out · ` : ""}${((Date.now() - t0) / 1000).toFixed(1)}s · ${modeLabel(perm.mode)}`));
      console.log();
    }
  }

  function showTool(call, tool, res, state, alreadyShownHeader = false) {
    const title = res?.display?.title || (tool ? defaultTitle(tool, call.args) : `Unknown tool ${call.name}`);
    if (!alreadyShownHeader || res) {
      if (alreadyShownHeader && res) { /* header printed at confirm time; print result only */ }
      else console.log(toolHeader(C, title, state));
    }
    if (res) for (const l of toolBody(C, res.display, res)) console.log(l);
  }

  function previewEdit(a) {
    const lines = [...String(a.old_string).split("\n").map((s) => C.bgRed(C.red(`  - ${s}`))), ...String(a.new_string ?? "").split("\n").map((s) => C.bgGreen(C.green(`  + ${s}`)))];
    for (const l of lines.slice(0, 40)) console.log("  " + l);
    if (lines.length > 40) console.log(C.gray(`    … ${lines.length - 40} more lines`));
  }

  async function shellPassthrough(cmd) {
    if (!cmd) return;
    const sh = detectShell();
    console.log(C.dim(`  $ ${cmd}`));
    const r = await new Promise((res) => {
      const p = spawn(sh.cmd, sh.args(cmd), { cwd, windowsHide: true });
      let o = ""; p.stdout.on("data", (d) => { o += d; out.write(C.gray(String(d))); }); p.stderr.on("data", (d) => { o += d; out.write(C.gray(String(d))); });
      p.on("close", (code) => res({ code, o })); p.on("error", (e) => res({ code: -1, o: e.message }));
    });
    console.log(C.dim(`  [exit ${r.code}]\n`));
    // the model sees what you ran, like a shared terminal
    session.push({ role: "user", content: `I ran this shell command myself:\n$ ${cmd}\n[exit ${r.code}]\n${r.o.slice(-8000)}\n(No reply needed unless I ask.)` });
    session.push({ role: "assistant", content: "Noted." });
  }

  async function command(text) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "/help": case "/?":
        console.log();
        for (const [k, v] of Object.entries(COMMANDS)) console.log(`  ${C.accent(k.padEnd(9))} ${C.dim(v)}`);
        console.log(`  ${C.accent("!cmd".padEnd(9))} ${C.dim("run a shell command yourself; the model sees the output")}`);
        console.log(C.dim(`\n  While the model works: keep typing and press enter to queue a message (it gets it at its next step) · esc or ctrl+c interrupts`));
        console.log(C.dim(`  Keys: ctrl+c twice at an empty prompt quits · shift+tab cycles the mode · end a line with \\ for multi-line\n  Settings: ${CONFIG_FILE}\n`));
        break;
      case "/jobs": {
        const jobs = listJobs();
        const [sub, id] = arg.split(/\s+/);
        if (sub === "stop") {
          const targets = id === "all" || !id ? jobs.filter(jobRunning) : jobs.filter((j) => String(j.id) === id);
          if (!targets.length) { console.log(C.dim(`  ${id && id !== "all" ? `No job ${id}.` : "Nothing running."}\n`)); break; }
          for (const j of targets) { stopJob(j); console.log(C.dim(`  Stopped job ${j.id}: ${j.command}`)); }
          console.log(); break;
        }
        if (!jobs.length) { console.log(C.dim("  No background jobs. The model starts one when it runs a server or watcher.\n")); break; }
        console.log();
        for (const j of jobs) console.log(`  ${jobRunning(j) ? C.mint("●") : C.gray("○")} ${describeJob(j)}`);
        console.log(C.dim("\n  /jobs stop <id> or /jobs stop all. Warden stops them all when it exits.\n"));
        break;
      }
      case "/exit": case "/quit": closed = true; break;
      case "/clear":
        session = new Session({ cwd, model: session.model }); perm.allowed.clear();
        console.log(C.dim("  New conversation.\n")); break;
      case "/usage": case "/cost": {
        const u = session.usage;
        console.log(C.dim(`  ${u.calls} model calls · ${fmtTokens(u.input)} input / ${fmtTokens(u.output)} output tokens (as reported by the provider; free tiers cost nothing)\n`)); break;
      }
      case "/mode":
        if (!arg) { console.log(C.dim(`  mode: ${modeLabel(perm.mode)}. Options: ${MODES.join(", ")}\n`)); break; }
        if (!MODES.includes(arg)) { console.log(C.red(`  unknown mode "${arg}". Options: ${MODES.join(", ")}\n`)); break; }
        perm.mode = arg; saveAgentConfig({ mode: arg });
        console.log(C.dim(`  mode: ${modeLabel(arg)}${arg === "yolo" ? C.yellow("  (edits and shell commands run without asking)") : ""}\n`)); break;
      case "/model": {
        if (!arg) {
          const list = savedModels(cfg);
          console.log(`\n  current: ${C.bold(session.model)}${findModel(cfg, session.model) ? C.gray(`  (${findModel(cfg, session.model).name})`) : ""}\n`);
          if (!list.length) { console.log(C.dim("  No saved models yet. /add connects a source and picks a model.\n")); break; }
          list.forEach((m, i) => console.log(`  ${C.accent(String(i + 1).padStart(2))}  ${(m.spec === session.model ? C.mint("● ") : "  ") + m.name.padEnd(32)} ${C.gray(m.spec)}${toolTag(m.tools)}`));
          const pick = (await answer(`\n  Number to switch to (enter to keep the current one) ${C.accent("›")} `, "")).trim();
          if (!pick) { console.log(); break; }
          const m = /^\d+$/.test(pick) ? list[Number(pick) - 1] : findModel(cfg, pick);
          if (!m) { console.log(C.red("  no such model\n")); break; }
          switchModel(m.spec);
          break;
        }
        try { switchModel(resolveModelInput(cfg, arg)); } catch (e) { console.log(C.red(`  ${e.message}\n`)); }
        break;
      }
      case "/models": {
        const words = arg.split(/\s+/).filter(Boolean);
        const onlyFree = words.includes("--free");
        const rest = words.filter((w) => w !== "--free");
        const name = rest[0] || parseModelSpec(session.model).provider;
        const query = rest.slice(1).join(" ");
        const spin = new Spinner(out, C); spin.start(`Asking ${name} for its models`);
        try {
          let list = await listModels(name, cfg); spin.stop();
          if (onlyFree) list = list.filter((m) => m.free);
          if (query) list = list.filter((m) => m.id.toLowerCase().includes(query.toLowerCase()));
          console.log(`\n  ${C.bold(name)}: ${list.length} model${list.length === 1 ? "" : "s"}${onlyFree ? " (free)" : ""}${query ? ` matching "${query}"` : ""}${list.length > 80 ? ", first 80 shown" : ""}`);
          for (const m of list.slice(0, 80)) console.log(`    ${name}/${m.id}${modelFlags(m)}`);
          console.log(C.dim(`\n  Use one: /model ${name}/<id>   ·   save it with a short name: /add\n`));
        } catch (e) { spin.stop(); console.log(C.red(`  ${e.message}\n`)); }
        break;
      }
      case "/add": await addWizard(); break;
      case "/providers": {
        console.log();
        for (const name of [...ADD_ORDER, ...Object.keys(cfg.providers || {}).filter((n) => !CATALOG[n])]) {
          let st; try { st = keyStatus(name, cfg); } catch (e) { st = e.message; }
          const ok = !/missing/.test(st);
          const n = savedModels(cfg).filter((m) => m.spec.startsWith(name + "/")).length;
          const p = CATALOG[name] || cfg.providers[name];
          console.log(`  ${ok ? C.mint("●") : C.gray("○")} ${(p?.label || name).padEnd(14)} ${C.dim(st.padEnd(28))}${n ? C.accent(` ${n} saved model${n > 1 ? "s" : ""}`) : ""}${p?.blurb ? C.gray("  · " + p.blurb) : ""}`);
        }
        console.log(C.dim("\n  /add connects one · /remove <source> forgets its saved key\n"));
        break;
      }
      case "/remove": {
        if (!arg) { console.log(C.dim("  usage: /remove <model name>   or   /remove <source> (e.g. /remove openrouter) to forget its saved key\n")); break; }
        if (removeModel(cfg, arg)) { console.log(C.dim(`  Removed model "${arg}".\n`)); break; }
        const prov = Object.keys({ ...CATALOG, ...(cfg.providers || {}) }).find((n) => n === arg.toLowerCase());
        if (!prov) { console.log(C.red(`  "${arg}" is neither a saved model nor a source. /model and /providers list them.\n`)); break; }
        const sure = (await answer(`  Forget the saved ${prov} key and remove its saved models? [y/N] `, "n")).trim();
        if (!/^y/i.test(sure)) { console.log(C.dim("  Kept.\n")); break; }
        const hadKey = removeKey(prov), n = removeModelsOf(cfg, prov);
        if (cfg.providers?.[prov]) { delete cfg.providers[prov]; saveAgentConfig({ providers: cfg.providers }); }
        console.log(C.dim(`  ${hadKey ? "Saved key deleted" : "No saved key (environment variables are not touched)"}; ${n} model${n === 1 ? "" : "s"} removed.\n`));
        break;
      }
      case "/resume": case "/sessions": {
        const list = Session.list(15);
        if (!list.length) { console.log(C.dim("  No saved conversations yet.\n")); break; }
        let pick = arg;
        if (!pick) {
          console.log();
          list.forEach((s, i) => console.log(`  ${C.accent(String(i + 1).padStart(2))}  ${(s.title || "").slice(0, 60).padEnd(60)} ${C.gray(new Date(s.mtime).toLocaleString())}${s.cwd !== cwd ? C.gray("  (other folder)") : ""}`));
          pick = (await answer(`\n  Number to resume (enter to cancel) ${C.accent("›")} `)).trim();
          if (!pick) break;
          if (/^\d+$/.test(pick)) pick = list[Number(pick) - 1]?.id;
        }
        try {
          session = Session.load(pick); perm.allowed.clear();
          console.log(C.dim(`  Resumed "${session.title}" (${session.messages.length} messages, model ${session.model}).\n`));
          replayTail();
        } catch (e) { console.log(C.red(`  ${e.message}\n`)); }
        break;
      }
      case "/init":
        await turn("Explore this project (structure, languages, how to build, test and run it, conventions you notice) and write a concise WARDEN.md at the project root with notes that would help a coding agent work here. Keep it under 80 lines. If WARDEN.md exists, improve it instead of replacing useful content.");
        break;
      default:
        console.log(C.red(`  unknown command ${cmd}. /help lists commands.\n`));
    }
  }

  function switchModel(spec) {
    const { provider } = parseModelSpec(spec);
    resolveProvider(provider, cfg);
    session.model = spec;
    const recent = [spec, ...(cfg.recentModels || []).filter((m) => m !== spec)].slice(0, 8);
    cfg.recentModels = recent; cfg.model = spec;
    saveAgentConfig({ model: spec, recentModels: recent });
    let st = ""; try { st = keyStatus(provider, cfg); } catch {}
    const m = findModel(cfg, spec);
    console.log(C.dim(`  model: ${m ? m.name + " = " : ""}${spec} (${st})${m?.tools === "none" ? C.yellow(" · chat only, it cannot read or edit files") : m?.tools === "text" ? " · text tool format" : ""}. Saved as your default.\n`));
  }

  // /add: pick a source, give it a key, pick a model, test it, save it under a short name.
  async function addWizard() {
    const names = [...ADD_ORDER];
    console.log(`\n  ${C.bold("Where do you want models from?")}\n`);
    names.forEach((n, i) => {
      const p = CATALOG[n];
      let st = ""; try { st = keyStatus(n, cfg); } catch {}
      const ok = !/missing/.test(st);
      console.log(`  ${C.accent(String(i + 1).padStart(2))}  ${(ok ? C.mint("● ") : C.gray("○ ")) + p.label.padEnd(14)} ${C.gray(p.blurb)}`);
    });
    console.log(`  ${C.accent(" c")}  ${C.gray("○ ")}${"Custom".padEnd(14)} ${C.gray("any OpenAI-compatible server (URL)")}`);
    const pick = (await answer(`\n  Number (enter to cancel) ${C.accent("›")} `, "")).trim().toLowerCase();
    if (!pick) return console.log();
    let name;
    if (pick === "c") {
      name = (await answer(`  Short name for this source (letters/numbers, e.g. together) ${C.accent("›")} `, "")).trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
      if (!name || CATALOG[name]) return console.log(C.red(`  ${name ? `"${name}" is a built-in source; pick it from the list` : "cancelled"}\n`));
      const url = (await answer(`  Base URL (the part before /chat/completions, e.g. https://api.together.xyz/v1) ${C.accent("›")} `, "")).trim().replace(/\/+$/, "");
      if (!/^https?:\/\//.test(url)) return console.log(C.red("  That does not look like a URL. Cancelled.\n"));
      cfg.providers = { ...(cfg.providers || {}), [name]: { label: name, api: "openai", baseUrl: url, keyEnv: [] } };
      saveAgentConfig({ providers: cfg.providers });
    } else {
      name = names[Number(pick) - 1];
      if (!name) return console.log(C.red("  No such number.\n"));
    }
    const p = resolveProvider(name, cfg);

    // key
    let st = ""; try { st = keyStatus(name, cfg); } catch {}
    const needsKey = !!p.keyEnv?.length || pick === "c";
    if (needsKey) {
      const has = /key from|saved/.test(st);
      if (p.keyUrl) console.log(C.dim(`  Get a key at ${p.keyUrl}`));
      const k = (await askSecret(`  ${has ? `Key found (${st}). Paste a new one or press enter to keep it` : `Paste your ${p.label || name} key${pick === "c" ? " (enter if it needs none)" : ""}`}: `)).trim();
      if (k) { saveKey(name, k); console.log(C.dim(`  Saved ${mask(k)} to ${CREDENTIALS_FILE}`)); }
      else if (!has && pick !== "c") return console.log(C.red("  No key, cancelled.\n"));
    } else console.log(C.dim(`  ${p.label} runs on your PC; make sure it is running and has a model downloaded.`));

    // model
    const spin = new Spinner(out, C); spin.start(`Asking ${p.label || name} for its models`);
    let list = [];
    try { list = await listModels(name, cfg); spin.stop(); } catch (e) { spin.stop(); console.log(C.yellow(`  Could not list models (${e.message}). You can still type a model id.`)); }
    let id;
    if (list.length) {
      const free = list.filter((m) => m.free);
      console.log(C.dim(`  ${list.length} models${free.length ? `, ${free.length} free` : ""}.`));
      const q = (await answer(`  Search (enter for ${free.length ? "free ones" : "all"}, "all" for everything) ${C.accent("›")} `, "")).trim().toLowerCase();
      let shown = q === "all" ? list : q ? list.filter((m) => m.id.toLowerCase().includes(q)) : free.length ? free : list;
      shown = [...shown].sort((a, b) => (b.free === true) - (a.free === true) || (b.tools === true) - (a.tools === true) || a.id.localeCompare(b.id));
      if (!shown.length) console.log(C.yellow("  Nothing matched."));
      shown.slice(0, 30).forEach((m, i) => console.log(`  ${C.accent(String(i + 1).padStart(2))}  ${m.id}${modelFlags(m)}`));
      if (shown.length > 30) console.log(C.gray(`      … ${shown.length - 30} more; search to narrow down`));
      const sel = (await answer(`  Number, or type a model id ${C.accent("›")} `, "")).trim();
      if (!sel) return console.log(C.dim("  Cancelled.\n"));
      id = /^\d+$/.test(sel) ? shown[Number(sel) - 1]?.id : sel;
      if (!id) return console.log(C.red("  No such number.\n"));
    } else {
      id = (await answer(`  Model id ${C.accent("›")} `, "")).trim();
      if (!id) return console.log(C.dim("  Cancelled.\n"));
    }
    const spec = `${name}/${id}`;
    const meta = list.find((m) => m.id === id) || {};

    // test it once: proves the key and model work, and finds out how it can use tools
    const spin2 = new Spinner(out, C); spin2.start(`Testing ${spec}`);
    let tools = null;
    try {
      const r = await probeToolSupport(spec, cfg, { onRetry: ({ status, waitMs }) => spin2.setLabel(`Rate limited (${status}), retrying in ${Math.round(waitMs / 1000)}s`) });
      spin2.stop(); tools = r.mode;
      console.log(`  ${r.mode === "none" ? C.yellow("!") : C.mint("✓")} Works. ${r.detail}.`);
    } catch (e) {
      spin2.stop();
      console.log(C.red(`  Test failed: ${e.message}`));
      const keep = (await answer(`  Save it anyway? [y/N] `, "n")).trim();
      if (!/^y/i.test(keep)) return console.log(C.dim("  Not saved.\n"));
    }
    let short = suggestName(id);
    const typed = (await answer(`  Name it (enter for "${short}") ${C.accent("›")} `, "")).trim();
    if (typed) short = typed.replace(/\s+/g, "-");
    addModel(cfg, { name: short, spec, ctx: meta.ctx || null, tools });
    console.log(C.mint(`  ✓ Added ${short}.`));
    switchModel(spec);
  }

  function replayTail() {
    const tail = session.messages.filter((m) => (m.role === "user" || (m.role === "assistant" && m.content))).slice(-4);
    for (const m of tail) console.log(m.role === "user" ? `${C.accent("›")} ${m.content.slice(0, 300)}` : C.dim(`  ${m.content.slice(0, 400)}`));
    console.log();
  }

  function banner() {
    let st = ""; try { st = keyStatus(parseModelSpec(session.model).provider, cfg); } catch (e) { st = e.message; }
    console.log();
    console.log(`  ${C.mint("◉")} ${C.bold("Warden")} ${C.gray("v" + VERSION)}`);
    console.log(`  ${C.gray("model")}  ${session.model} ${/missing/.test(st) ? C.red(`(${st})`) : C.gray(`(${st})`)}`);
    console.log(`  ${C.gray("mode ")}  ${modeLabel(perm.mode)} ${C.gray("(shift+tab or /mode)")}`);
    console.log(`  ${C.gray("dir  ")}  ${cwd}`);
    console.log(C.gray(`  /help for commands · /model to switch models · esc interrupts · type while it works to queue a message`));
    const upd = updateNotice(cfg);
    if (upd) console.log(C.yellow(`  Warden ${upd} is available (you have ${VERSION}). Run: warden update`));
    console.log();
  }

  function quit() {
    session.save();
    try { rl.close(); } catch {}
    out.write(C.dim(`\n  Saved conversation ${session.id}. Resume with: warden --resume ${session.id.slice(0, 12)}\n`));
    process.exit(0);
  }
}

function latestFor(cwd) {
  const s = Session.list(200).find((x) => x.cwd === cwd);
  if (!s) throw new Error("no earlier conversation in this folder");
  return Session.load(s.id);
}

const fmtChars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k chars` : `${n} chars`);
const toolTag = (t) => (t === "none" ? C.yellow("  chat only") : t === "text" ? C.gray("  text tools") : "");
const fmtCtx = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);
const modelFlags = (m) => {
  const f = [];
  if (m.free) f.push(C.mint("free"));
  if (m.tools === true) f.push(C.gray("tools"));
  if (m.tools === false) f.push(C.yellow("no tools"));
  if (m.ctx) f.push(C.gray(fmtCtx(m.ctx) + " ctx"));
  return f.length ? "   " + f.join(C.gray(" · ")) : "";
};
const modeLabel = (m) => (m === "yolo" ? C.red("yolo") : m === "auto-edit" ? C.yellow("auto-edit") : C.mint("ask"));
const TITLES = { read_file: "Read", write_file: "Write", edit_file: "Edit", list_dir: "List", glob: "Glob", grep: "Grep" };
const defaultTitle = (tool, a = {}) => tool.name === "bash" ? `Bash ${a.command}` : `${TITLES[tool.name] || tool.name} ${a.path || a.pattern || ""}`.trim();
