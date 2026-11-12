// Tool calling for models that do not support it natively: the model writes calls as tagged JSON in its reply,
//   <tool_call>{"name": "read_file", "arguments": {"path": "calc.py"}}</tool_call>
// Warden parses them, runs them with the usual approvals, and sends results back as <tool_result> blocks.

export function textToolsPrompt(tools) {
  const list = tools.map((t) => `- ${t.name}: ${t.description}\n  arguments (JSON schema): ${JSON.stringify(t.parameters)}`).join("\n");
  return `

# Tools
You can use tools by writing a tool call in your reply, exactly in this format, and then STOP and wait for the result:

<tool_call>
{"name": "TOOL_NAME", "arguments": { ... }}
</tool_call>

Rules: the content between the tags must be valid JSON. You may write a short sentence before a tool call. You may make several calls in one reply. After you stop, the results come back in <tool_result> blocks. When you need no more tools, answer normally without any <tool_call>.

Available tools:
${list}`;
}

// Converts the neutral conversation into plain user/assistant turns for a model without native tools.
export function toTextProtocol(messages) {
  const out = [];
  const push = (role, content) => {
    const last = out.at(-1);
    if (last && last.role === role) last.content += "\n\n" + content; // keep strict user/assistant alternation
    else out.push({ role, content });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", m.content);
    else if (m.role === "assistant") {
      const calls = (m.toolCalls || []).map((c) => `<tool_call>\n${JSON.stringify({ name: c.name, arguments: c.args ?? {} })}\n</tool_call>`).join("\n");
      push("assistant", [m.content, calls].filter(Boolean).join("\n") || "(no output)");
    } else if (m.role === "tool") push("user", `<tool_result name="${m.name}">\n${m.content}\n</tool_result>`);
  }
  return out;
}

// Pulls tool calls out of a reply. Returns { text (without the tags), toolCalls }.
export function parseTextToolCalls(reply, idPrefix = "tc") {
  const toolCalls = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m, n = 0;
  while ((m = re.exec(reply))) {
    let body = m[1].trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let obj = null;
    try { obj = JSON.parse(body); } catch {
      // be forgiving about trailing commas and single quotes, which small models produce
      try { obj = JSON.parse(body.replace(/,\s*([}\]])/g, "$1")); } catch { obj = null; }
    }
    const name = obj?.name || obj?.tool || obj?.function;
    const args = obj?.arguments ?? obj?.args ?? obj?.parameters ?? {};
    toolCalls.push(name ? { id: `${idPrefix}_${Date.now().toString(36)}_${n++}`, name: String(name), args: typeof args === "string" ? safeJson(args) : args }
      : { id: `${idPrefix}_${Date.now().toString(36)}_${n++}`, name: "__invalid__", args: { __invalid_json: body } });
  }
  // a <tool_call> that never closed was cut off (usually by the output limit): report it instead of dropping it silently
  const rest = reply.replace(re, "");
  const open = rest.indexOf("<tool_call>");
  if (open >= 0) toolCalls.push({ id: `${idPrefix}_${Date.now().toString(36)}_${n++}`, name: guessName(rest.slice(open)), args: { __invalid_json: rest.slice(open + 11, open + 211), __truncated: true } });
  const text = rest.replace(/<tool_call>[\s\S]*$/, "").replace(/\n{3,}/g, "\n\n").trim();
  return { text, toolCalls };
}

const guessName = (s) => s.match(/"name"\s*:\s*"([\w-]+)"/)?.[1] || "__invalid__";

function safeJson(s) { try { return JSON.parse(s); } catch { return { __invalid_json: s }; } }

// Streaming filter: hides <tool_call>…</tool_call> from what the user sees while the reply streams in.
export class ToolTagFilter {
  constructor(emit) { this.emit = emit; this.buf = ""; this.inside = false; }
  write(chunk) {
    this.buf += chunk;
    for (;;) {
      if (this.inside) {
        const end = this.buf.indexOf("</tool_call>");
        if (end < 0) { this.buf = this.buf.slice(-12); return; }
        this.buf = this.buf.slice(end + 12); this.inside = false;
      } else {
        const start = this.buf.indexOf("<tool_call>");
        if (start >= 0) { if (start) this.emit(this.buf.slice(0, start)); this.buf = this.buf.slice(start + 11); this.inside = true; continue; }
        // keep a possible partial "<tool_call" at the end
        const lt = this.buf.lastIndexOf("<");
        if (lt >= 0 && "<tool_call>".startsWith(this.buf.slice(lt))) { if (lt) this.emit(this.buf.slice(0, lt)); this.buf = this.buf.slice(lt); return; }
        if (this.buf) this.emit(this.buf);
        this.buf = ""; return;
      }
    }
  }
  end() { if (!this.inside && this.buf) this.emit(this.buf); this.buf = ""; }
}
