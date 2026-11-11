// `warden -p "task"`: one message, no interface. The answer goes to stdout, tool activity to stderr.
// Tool calls that would need approval are denied unless --mode auto-edit or --mode yolo allows them.
import { runTurn } from "./loop.mjs";
import { Session } from "./session.mjs";
import { loadAgentConfig, pickDefaultModel } from "./config.mjs";
import { MODES } from "./tools.mjs";
import { resolveModelInput } from "./models.mjs";

export async function runHeadless({ prompt, cwd = process.cwd(), model, mode, json = false }) {
  const cfg = loadAgentConfig();
  if (model) model = resolveModelInput(cfg, model); // accepts a saved name too
  const session = new Session({ cwd, model: model || cfg.model || pickDefaultModel() });
  const perm = { mode: MODES.includes(mode) ? mode : "ask", allowed: new Set() };
  const err = (s) => process.stderr.write(s + "\n");
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  let text = "";
  const ui = {
    onText: (d) => { text += d; if (!json) process.stdout.write(d); },
    onAssistantEnd: (t) => { if (!json && t && !t.endsWith("\n")) process.stdout.write("\n"); },
    onRetry: ({ status, waitMs }) => err(`[warden] rate limited (${status}), retrying in ${Math.round(waitMs / 1000)}s`),
    onNotice: (m) => err(`[warden] ${m}`),
    confirm: async (call, tool, desc) => { err(`[warden] denied (mode ${perm.mode}): ${desc}`); return "no"; },
    onToolEnd: (call, tool, res) => err(`[warden] ${res?.denied ? "denied" : res?.error ? "error" : "ok"} ${res?.display?.title || call.name}${res?.error ? ": " + res.error : ""}`),
  };
  try {
    const r = await runTurn({ session, userText: prompt, cfg, ui, perm, signal: controller.signal, cwd });
    if (json) process.stdout.write(JSON.stringify({ ok: !r.interrupted, text, model: session.model, usage: session.usage, session: session.id }) + "\n");
    return r.interrupted ? 130 : 0;
  } catch (e) {
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: e.message, model: session.model }) + "\n");
    else err(`[warden] error: ${e.message}`);
    return 1;
  }
}
