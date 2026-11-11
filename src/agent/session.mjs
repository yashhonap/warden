// Sessions: one JSONL file per conversation in ~/.warden/sessions. Line 1 is metadata, then one message per line.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR } from "./config.mjs";

export class Session {
  constructor({ cwd, model, id, messages = [], title = null, created = Date.now() }) {
    this.id = id || new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + crypto.randomBytes(3).toString("hex");
    this.cwd = cwd; this.model = model; this.messages = messages; this.title = title; this.created = created;
    this.usage = { input: 0, output: 0, calls: 0 };
    this.file = path.join(SESSIONS_DIR, this.id + ".jsonl");
    this.persisted = messages.length;
  }

  push(msg) { this.messages.push(msg); if (!this.title && msg.role === "user") this.title = msg.content.slice(0, 80); this.save(); }

  save() {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      if (!fs.existsSync(this.file) || this.persisted === 0) {
        fs.writeFileSync(this.file, JSON.stringify({ meta: { id: this.id, cwd: this.cwd, model: this.model, created: this.created, title: this.title } }) + "\n");
        this.persisted = 0;
      }
      const fresh = this.messages.slice(this.persisted);
      if (fresh.length) fs.appendFileSync(this.file, fresh.map((m) => JSON.stringify(m)).join("\n") + "\n");
      this.persisted = this.messages.length;
    } catch { /* saving is best effort; never break the conversation */ }
  }

  static list(limit = 20) {
    let files = [];
    try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
    return files.map((f) => {
      const p = path.join(SESSIONS_DIR, f);
      try {
        const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
        const meta = JSON.parse(lines[0]).meta || {};
        const firstUser = lines.slice(1).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m?.role === "user");
        return { ...meta, title: meta.title || firstUser?.content?.slice(0, 80) || "(empty)", messages: lines.length - 1, mtime: fs.statSync(p).mtimeMs, file: p };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  }

  static load(idOrPrefix) {
    const hit = Session.list(1000).filter((s) => s.id.startsWith(idOrPrefix));
    if (hit.length !== 1) throw new Error(hit.length ? `"${idOrPrefix}" matches ${hit.length} sessions` : `no session "${idOrPrefix}"`);
    const lines = fs.readFileSync(hit[0].file, "utf8").split("\n").filter(Boolean);
    const meta = JSON.parse(lines[0]).meta;
    const messages = lines.slice(1).map((l) => JSON.parse(l));
    return new Session({ ...meta, messages });
  }
}
