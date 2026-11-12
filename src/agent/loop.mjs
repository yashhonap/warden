// The agent loop: send the conversation to the model, run the tools it asks for (with approvals), repeat until it answers.
import { chat, toolsUnsupported } from "./providers.mjs";
import { TOOLS, toolByName, needsApproval, describeCall } from "./tools.mjs";
import { systemPrompt } from "./prompt.mjs";
import { findModel, toolModeFor, setToolMode } from "./models.mjs";

const isAbort = (e) => e?.name === "AbortError" || /aborted/i.test(e?.message || "");

// Keep the conversation under a rough token budget by blanking the oldest tool outputs first.
export function trimContext(messages, budgetTokens) {
  const size = () => messages.reduce((n, m) => n + (m.content?.length || 0) + JSON.stringify(m.toolCalls || "").length, 0) / 4;
  if (size() <= budgetTokens) return 0;
  let trimmed = 0;
  for (let i = 0; i < messages.length - 6 && size() > budgetTokens; i++) {
    const m = messages[i];
    if (m.role === "tool" && m.content.length > 200 && !m.trimmed) { m.content = "[old tool output removed to save context]"; m.trimmed = true; trimmed++; }
  }
  return trimmed;
}

// File contents the model already wrote are on disk; keeping every full copy in the conversation makes each later
// request bigger and slower (and burns free-tier token limits). Older write_file / edit_file arguments are replaced
// by a short note; the model reads the file again when it needs it. The latest assistant message is left alone.
const BIG = 1500;
export function compactWrites(messages) {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") { lastAssistant = i; break; }
  let n = 0;
  for (let i = 0; i < lastAssistant; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    for (const c of m.toolCalls) {
      const a = c.args;
      if (!a || c.compacted || typeof a !== "object") continue;
      if (c.name === "write_file" && String(a.content ?? "").length > BIG) {
        const lines = String(a.content).split("\n").length;
        c.args = { ...a, content: `[${lines} lines ${a.append ? "appended" : "written"} earlier; removed from the conversation to save space. Read ${a.path} to see the current contents.]` };
        c.compacted = true; n++;
      } else if (c.name === "edit_file" && String(a.old_string ?? "").length + String(a.new_string ?? "").length > BIG * 2) {
        c.args = { ...a, old_string: `[${String(a.old_string).split("\n").length} lines, removed to save space]`, new_string: `[${String(a.new_string).split("\n").length} lines, removed to save space; read ${a.path} for the current contents]` };
        c.compacted = true; n++;
      }
    }
  }
  return n;
}

const TRUNCATED_ARGS = (name, limit) =>
  `Your reply hit the output limit (${limit} tokens) while you were still writing the arguments for ${name}, so the call was cut off and nothing was done.` +
  (name === "write_file" ? " Write big files in parts: call write_file with the first part (under about 300 lines), then write_file with append=true for each further part." : " Send a shorter call, splitting the work into several smaller calls.");

/**
 * Runs one user message to completion.
 * ui: { onAssistantStart, onText, onReasoning, onAssistantEnd, onToolStart, onToolOutput, onToolEnd, confirm, onRetry, onNotice,
 *       takeQueued, onQueuedDelivered }
 *   takeQueued(): text the user typed while the model was working (or null). It is handed to the model between steps,
 *   so the user can steer without waiting for the whole task to finish.
 * perm: { mode, allowed: Set<toolName> }
 */
export async function runTurn({ session, userText, cfg, ui, perm, signal, cwd = session.cwd }) {
  session.push({ role: "user", content: userText });
  const tools = TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const limit = cfg.maxOutputTokens || 8192;

  for (let step = 1; ; step++) {
    if (step > cfg.maxSteps) {
      ui.onNotice?.(`Stopped after ${cfg.maxSteps} model calls for one message. Say "continue" to keep going.`);
      return { stopped: "max_steps" };
    }
    compactWrites(session.messages);
    // a saved model may have a smaller context window than the global budget
    const saved = findModel(cfg, session.model);
    const budget = saved?.ctx ? Math.min(cfg.contextTokens, Math.floor(saved.ctx * 0.7)) : cfg.contextTokens;
    const cut = trimContext(session.messages, budget);
    if (cut) ui.onNotice?.(`Trimmed ${cut} old tool output(s) to stay within the context budget.`);

    let res, partial = "";
    session.toolModes ||= {};
    const toolMode = session.toolModes[session.model] || toolModeFor(cfg, session.model);
    ui.onAssistantStart?.();
    try {
      res = await chat({
        spec: session.model, system: systemPrompt({ cwd, mode: perm.mode }), messages: session.messages, tools,
        cfg, signal, maxOutputTokens: limit, toolMode, timeouts: cfg,
        onText: (d) => { partial += d; ui.onText?.(d); }, onReasoning: (d) => ui.onReasoning?.(d), onToolDelta: (n, a) => ui.onToolDelta?.(n, a), onRetry: ui.onRetry,
      });
    } catch (e) {
      ui.onAssistantEnd?.(partial);
      if (signal?.aborted || (isAbort(e) && !e.timeout)) {
        session.push({ role: "assistant", content: (partial ? partial + "\n" : "") + "[interrupted by the user]" });
        return { interrupted: true };
      }
      // This model rejects native tool calling: switch it to the text format and try the same step again.
      if (toolMode === "native" && !partial && toolsUnsupported(e)) {
        setToolMode(cfg, session.model, "text");      // remembered if it is a saved model
        session.toolModes[session.model] = "text";     // and for the rest of this conversation either way
        ui.onNotice?.(`${session.model} does not accept native tool calls; switching it to Warden's text tool format.`);
        step--;
        continue;
      }
      // keep the conversation valid for the next message: the user turn stays; what streamed so far is kept as context
      if (partial) session.push({ role: "assistant", content: partial + "\n[reply cut off: " + String(e.message).slice(0, 120) + "]" });
      throw e;
    }
    ui.onAssistantEnd?.(res.text);
    session.usage.calls++;
    if (res.usage) { session.usage.input += res.usage.input; session.usage.output += res.usage.output; }
    const cutOff = /^(length|max_tokens|MAX_TOKENS)$/.test(res.stopReason || "");
    session.push({ role: "assistant", content: res.text, ...(res.toolCalls.length ? { toolCalls: res.toolCalls } : {}) });

    if (!res.toolCalls.length) {
      const queued = ui.takeQueued?.();
      if (queued) { // the user said something while this step ran: keep going with it instead of ending the turn
        session.push({ role: "user", content: queued });
        ui.onQueuedDelivered?.(queued);
        continue;
      }
      if (!res.text.trim()) {
        ui.onNotice?.(cutOff
          ? `The model used its whole output limit (${limit} tokens) without writing a reply, often by thinking too long. Ask again, ask for something smaller, or raise "maxOutputTokens" in settings.`
          : `The model sent an empty reply${res.stopReason ? ` (finish reason: ${res.stopReason})` : ""}. Ask again or rephrase; if it keeps happening, try another model with /model.`);
        return { done: true, text: "", empty: true, stopReason: res.stopReason };
      }
      if (cutOff) ui.onNotice?.(`The reply hit the output limit (${limit} tokens) and was cut off. Say "continue" for the rest.`);
      return { done: true, text: res.text, stopReason: res.stopReason };
    }

    // Every tool call must get a result, even when interrupted, or the next request is invalid.
    for (const call of res.toolCalls) {
      const tool = toolByName(call.name);
      const result = (content, isError = true) => session.push({ role: "tool", toolCallId: call.id, name: call.name, content, ...(isError ? { isError: true } : {}) });
      if (signal?.aborted) { result("Interrupted by the user before this ran."); continue; }
      if (call.args?.__invalid_json !== undefined) {
        const truncated = cutOff || call.args.__truncated;
        result(truncated ? TRUNCATED_ARGS(tool?.name || "the tool call", limit) : "Your tool arguments were not valid JSON. Send them again as a JSON object.");
        ui.onToolEnd?.(call, tool, { error: truncated ? "cut off at the output limit; the model will retry in smaller parts" : "invalid arguments" });
        continue;
      }
      if (!tool) { result(`Unknown tool "${call.name}". Available: ${TOOLS.map((t) => t.name).join(", ")}`); ui.onToolEnd?.(call, null, { error: "unknown tool" }); continue; }

      ui.onToolStart?.(call, tool);
      if (needsApproval(tool, call.args, { cwd, mode: perm.mode, allowed: perm.allowed })) {
        const answer = await ui.confirm(call, tool, describeCall(tool, call.args, cwd));
        if (answer === "always") perm.allowed.add(tool.name);
        else if (answer !== "yes") {
          const why = typeof answer === "object" && answer.reason ? ` Reason: ${answer.reason}` : "";
          result(`User denied this ${tool.name} call.${why}`);
          ui.onToolEnd?.(call, tool, { denied: true });
          continue;
        }
        ui.onToolApproved?.(call, tool);
      }
      try {
        const out = await tool.run(call.args || {}, { cwd, signal, onOutput: (s) => ui.onToolOutput?.(call, s) });
        result(out.content, !!out.isError);
        ui.onToolEnd?.(call, tool, out);
      } catch (e) {
        result(`Error: ${e.message}`);
        ui.onToolEnd?.(call, tool, { error: e.message });
      }
    }
    if (signal?.aborted) return { interrupted: true };
    // anything the user typed meanwhile goes to the model now, before its next step
    const queued = ui.takeQueued?.();
    if (queued) { session.push({ role: "user", content: queued }); ui.onQueuedDelivered?.(queued); }
  }
}
