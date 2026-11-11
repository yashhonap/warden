// The agent loop: send the conversation to the model, run the tools it asks for (with permission), repeat until
// it answers without tool calls. The UI is injected so the same loop runs in the terminal app and in headless mode.
import { chat, toolsUnsupported } from "./providers.mjs";
import { findModel, toolModeFor, setToolMode } from "./models.mjs";
import { TOOLS, toolByName, needsApproval, describeCall } from "./tools.mjs";
import { systemPrompt } from "./prompt.mjs";

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

/**
 * Runs one user message to completion.
 * ui: { onAssistantStart, onText, onAssistantEnd, onToolStart, onToolEnd, confirm, onRetry, onNotice }
 * perm: { mode, allowed: Set<toolName> }
 */
export async function runTurn({ session, userText, cfg, ui, perm, signal, cwd = session.cwd }) {
  session.push({ role: "user", content: userText });
  const tools = TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters }));

  for (let step = 1; ; step++) {
    if (step > cfg.maxSteps) {
      ui.onNotice?.(`Stopped after ${cfg.maxSteps} model calls for one message. Say "continue" to keep going.`);
      return { stopped: "max_steps" };
    }
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
        cfg, signal, maxOutputTokens: cfg.maxOutputTokens, toolMode,
        onText: (d) => { partial += d; ui.onText?.(d); }, onRetry: ui.onRetry,
      });
    } catch (e) {
      ui.onAssistantEnd?.(partial);
      if (isAbort(e) || signal?.aborted) {
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
      // keep the conversation valid for the next message: the user turn stays, no half assistant message
      throw e;
    }
    ui.onAssistantEnd?.(res.text);
    session.usage.calls++;
    if (res.usage) { session.usage.input += res.usage.input; session.usage.output += res.usage.output; }
    session.push({ role: "assistant", content: res.text, ...(res.toolCalls.length ? { toolCalls: res.toolCalls } : {}) });
    if (!res.toolCalls.length) return { done: true, text: res.text, stopReason: res.stopReason };

    // Every tool call must get a result, even when interrupted, or the next request is invalid.
    for (const call of res.toolCalls) {
      const tool = toolByName(call.name);
      const result = (content, isError = true) => session.push({ role: "tool", toolCallId: call.id, name: call.name, content, ...(isError ? { isError: true } : {}) });
      if (signal?.aborted) { result("Interrupted by the user before this ran."); continue; }
      if (!tool) { result(`Unknown tool "${call.name}". Available: ${TOOLS.map((t) => t.name).join(", ")}`); ui.onToolEnd?.(call, null, { error: "unknown tool" }); continue; }
      if (call.args?.__invalid_json !== undefined) { result("Your tool arguments were not valid JSON. Send them again as a JSON object."); ui.onToolEnd?.(call, tool, { error: "invalid arguments" }); continue; }

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
      }
      try {
        const out = await tool.run(call.args || {}, { cwd, signal });
        result(out.content, !!out.isError);
        ui.onToolEnd?.(call, tool, out);
      } catch (e) {
        result(`Error: ${e.message}`);
        ui.onToolEnd?.(call, tool, { error: e.message });
      }
    }
    if (signal?.aborted) return { interrupted: true };
  }
}
