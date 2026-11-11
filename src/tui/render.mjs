// Terminal rendering: colors, a streaming Markdown printer, tool-call blocks, a spinner.
const useColor = (stream) => !!stream?.isTTY && !process.env.NO_COLOR;

export function makeColors(on) {
  const w = (a, b) => (s) => (on ? `\x1b[${a}m${s}\x1b[${b}m` : String(s));
  return {
    on, bold: w(1, 22), dim: w(2, 22), italic: w(3, 23), red: w(31, 39), green: w(32, 39), yellow: w(33, 39),
    blue: w(34, 39), magenta: w(35, 39), cyan: w(36, 39), gray: w(90, 39),
    bgRed: (s) => (on ? `\x1b[48;5;52m${s}\x1b[49m` : String(s)), bgGreen: (s) => (on ? `\x1b[48;5;22m${s}\x1b[49m` : String(s)),
    accent: (s) => (on ? `\x1b[38;5;87m${s}\x1b[39m` : String(s)), mint: (s) => (on ? `\x1b[38;5;85m${s}\x1b[39m` : String(s)),
    violet: (s) => (on ? `\x1b[38;5;141m${s}\x1b[39m` : String(s)),
  };
}

export const C = makeColors(useColor(process.stdout));

// Streams Markdown to the terminal as it arrives. A line's kind (code fence, heading, bullet) is decided from its first
// characters; after that the rest of the line streams straight through with inline `code` and **bold** styling.
export class MarkdownStream {
  constructor(out = process.stdout, c = C) { this.out = out; this.c = c; this.reset(); }
  reset() { this.line = ""; this.kind = null; this.inFence = false; this.inCode = false; this.inBold = false; this.hold = ""; this.wroteAny = false; this.indent = "  "; }

  write(text) {
    for (const ch of text) {
      if (ch === "\n") { this._endLine(); continue; }
      if (this.kind === null) {
        this.line += ch;
        const t = this.line.trimStart();
        // decide once we have enough characters to tell what this line is
        if (t.length >= 3 || (t.length >= 1 && !/^[#`\-*>0-9 ]/.test(t[0]))) this._startLine();
      } else this._inline(ch);
    }
  }

  _startLine() {
    const t = this.line.trimStart();
    const raw = this.line; this.line = "";
    if (t.startsWith("```")) { this.kind = "fence"; this.inFence = !this.inFence; this._emit(this.indent + this.c.dim(raw.trim())); return; }
    if (this.inFence) { this.kind = "code"; this._emit(this.indent + this.c.cyan(raw)); return; }
    const h = t.match(/^(#{1,6})\s/);
    if (h) { this.kind = "heading"; this._emit(this.indent + this.c.bold(t.slice(h[0].length))); this.headingLine = true; return; }
    const b = raw.match(/^(\s*)[-*]\s/);
    if (b) { this.kind = "text"; this._emit(this.indent + b[1] + this.c.dim("• ")); for (const ch of raw.slice(b[0].length)) this._inline(ch); return; }
    this.kind = "text"; this._emit(this.indent);
    for (const ch of raw) this._inline(ch);
  }

  _inline(ch) {
    if (this.kind === "code" || this.kind === "fence") { this._emit(this.kind === "code" ? this.c.cyan(ch) : this.c.dim(ch)); return; }
    if (this.kind === "heading") { this._emit(this.c.bold(ch)); return; }
    if (ch === "`") { this.inCode = !this.inCode; return; }
    if (this.inCode) { this._emit(this.c.accent(ch)); return; }
    if (ch === "*") { if (this.hold === "*") { this.hold = ""; this.inBold = !this.inBold; return; } this.hold = "*"; return; }
    if (this.hold) { this._emit(this.inBold ? this.c.bold(this.hold) : this.hold); this.hold = ""; }
    this._emit(this.inBold ? this.c.bold(ch) : ch);
  }

  _endLine() {
    if (this.kind === null) { if (this.line.length || this.wroteAny) this._startLine(); }
    if (this.hold) { this._emit(this.hold); this.hold = ""; }
    if (this.kind === "fence") { /* fence line already printed */ }
    this._emit("\n");
    this.kind = null; this.inCode = false; this.inBold = false; this.line = "";
  }

  end() { if (this.kind !== null || this.line) this._endLine(); const wrote = this.wroteAny; this.reset(); return wrote; }
  _emit(s) { this.wroteAny = true; this.out.write(s); }
}

// ---- tool blocks -------------------------------------------------------------

export function toolHeader(c, title, state = "run") {
  const dot = state === "ok" ? c.mint("●") : state === "err" ? c.red("●") : state === "deny" ? c.yellow("●") : c.accent("●");
  return `${dot} ${c.bold(title)}`;
}

export function toolBody(c, display, { error, denied } = {}) {
  const out = [];
  if (denied) return [`  ${c.gray("⎿")} ${c.yellow("denied")}`];
  if (error) return [`  ${c.gray("⎿")} ${c.red(String(error).split("\n")[0].slice(0, 300))}`];
  if (!display) return out;
  if (display.diff?.length) {
    const w = String(Math.max(...display.diff.map((d) => d.n))).length;
    display.diff.forEach((d, i) => {
      const prefix = i === 0 ? `  ${c.gray("⎿")} ` : "    ";
      const body = `${String(d.n).padStart(w)} ${d.t} ${d.s}`;
      out.push(prefix + (d.t === "+" ? c.bgGreen(c.green(body)) : c.bgRed(c.red(body))));
    });
  }
  (display.lines || []).forEach((l, i) => out.push((i === 0 && !display.diff?.length ? `  ${c.gray("⎿")} ` : "    ") + c.gray(String(l).slice(0, 400))));
  return out;
}

// ---- spinner -----------------------------------------------------------------

export class Spinner {
  constructor(out = process.stdout, c = C) { this.out = out; this.c = c; this.timer = null; this.frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]; }
  start(label = "Thinking") {
    if (!this.out.isTTY || this.timer) return;
    this.t0 = Date.now(); this.label = label; let i = 0;
    const draw = () => { const s = Math.floor((Date.now() - this.t0) / 1000); this.out.write(`\r\x1b[2K  ${this.c.accent(this.frames[i++ % this.frames.length])} ${this.c.dim(`${this.label}… ${s}s · ctrl+c to interrupt`)}`); };
    draw(); this.timer = setInterval(draw, 90);
  }
  setLabel(l) { this.label = l; }
  stop() { if (!this.timer) return; clearInterval(this.timer); this.timer = null; this.out.write("\r\x1b[2K"); }
}

export const fmtTokens = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
