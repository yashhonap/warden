// wardend: records Claude Code hook events, snapshots repo state on Stop,
// serves a small local HTTP API + SSE stream.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAsset } from "node:sea";
import { leaderboard } from "./arena/arena.mjs";
import { openDb } from "./db.mjs";
import { loadConfig } from "./config.mjs";
import { captureSnapshot } from "./capture.mjs";

export const PORT = Number(process.env.WARDEN_PORT || 7777);
// In the standalone build the page is embedded as an asset; otherwise it sits next to this file.
const DASHBOARD = typeof __WARDEN_SEA__ !== "undefined" ? null : path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard", "index.html");
function readDashboard(cb) {
  if (DASHBOARD) return fs.readFile(DASHBOARD, cb);
  try { cb(null, getAsset("dashboard.html", "utf8")); } catch (e) { cb(e); }
}
const HOST = "127.0.0.1";

export function summarize(e) {
  const t = e.tool_input || {};
  switch (e.hook_event_name) {
    case "UserPromptSubmit": return String(e.prompt || "").slice(0, 200);
    case "PreToolUse":
    case "PostToolUse":
      return `${t.file_path || t.command || t.pattern || t.url || t.description || ""}`.slice(0, 200);
    case "Stop": return String(e.last_assistant_message || "").slice(0, 200);
    default: return "";
  }
}

export function startDaemon({ dbFile, port = PORT, quiet = false } = {}) {
  const db = openDb(dbFile);
  const q = {
    upsertSession: db.prepare(`
      INSERT INTO sessions (id, cwd, transcript_path, started_at, last_event_at, first_prompt, event_count)
      VALUES (@id, @cwd, @tp, @ts, @ts, @prompt, 1)
      ON CONFLICT(id) DO UPDATE SET last_event_at=@ts, event_count=event_count+1,
        status=CASE WHEN @type='Stop' THEN 'stopped' ELSE 'running' END,
        first_prompt=COALESCE(first_prompt, @prompt)`),
    insertEvent: db.prepare(`INSERT INTO events (session_id, ts, type, tool_name, summary, duration_ms, payload)
      VALUES (?,?,?,?,?,?,?)`),
    insertSnap: db.prepare(`INSERT INTO snapshots (session_id, ts, git_status, git_diff, transcript_copy)
      VALUES (?,?,?,?,?)`),
  };
  const clients = new Set(); // SSE subscribers
  const broadcast = (obj) => { const line = `data: ${JSON.stringify(obj)}\n\n`; for (const r of clients) r.write(line); };

  function ingest(e) {
    const ts = Date.now();
    const type = e.hook_event_name || "Unknown";
    const sid = e.session_id || "unknown";
    q.upsertSession.run({
      id: sid, cwd: e.cwd ?? null, tp: e.transcript_path ?? null, ts, type,
      prompt: type === "UserPromptSubmit" ? String(e.prompt || "").slice(0, 300) : null,
    });
    delete e._sentAt;
    const summary = summarize(e);
    q.insertEvent.run(sid, ts, type, e.tool_name ?? null, summary, e.duration_ms ?? null, JSON.stringify(e));
    broadcast({ session_id: sid, ts, type, tool_name: e.tool_name ?? null, summary, duration_ms: e.duration_ms ?? null });
    if (type === "Stop" || type === "SubagentStop") {
      // snapshot off the hot path; never blocks the hook response
      captureSnapshot(e.cwd, e.transcript_path).then((s) => {
        q.insertSnap.run(sid, Date.now(), s.git_status, s.git_diff, s.transcript_copy);
        broadcast({ session_id: sid, ts: Date.now(), type: "Snapshot", summary: `diff ${s.git_diff?.length ?? 0}B` });
        // Approval-gated: only PROPOSE a review. Nothing runs, nothing is spent, until the user approves.
        if (type === "Stop" && loadConfig().mode === "ask" && s.git_diff) {
          broadcast({ session_id: sid, ts: Date.now(), type: "ReviewProposal", summary: `review available: warden review ${sid.slice(0, 8)}` });
        }
      }).catch((err) => console.error("snapshot failed:", err.message));
    }
  }

  const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

  const server = http.createServer((req, res) => {
    // Browser safety. The daemon holds your code and transcripts, so:
    //  - Host must be loopback (blocks DNS-rebinding: a web page can't make the daemon look like evil.com)
    //  - a browser-sent Origin must be the daemon itself (blocks other websites from reading or POSTing)
    // curl/hooks/CLI send no Origin and are unaffected.
    const hostHdr = req.headers.host || "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(hostHdr)) return res.writeHead(403).end("forbidden host");
    if (req.headers.origin && req.headers.origin !== `http://${hostHdr}`) return res.writeHead(403).end("forbidden origin");

    const url = new URL(req.url, `http://${HOST}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return readDashboard((err, html) => {
        if (err) return res.writeHead(500).end("dashboard missing");
        // per-request nonce: only our own script/style run, so even if escaping ever failed, injected markup can't execute
        const nonce = crypto.randomBytes(16).toString("base64");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
        res.end(String(html).replaceAll("__NONCE__", nonce));
      });
    }
    if (req.method === "POST" && url.pathname === "/arena/rate") {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        try {
          const { run_id, subject, value } = JSON.parse(body);
          if (![1, -1, 0].includes(value)) throw new Error("value must be 1, -1 or 0");
          const r = db.prepare("UPDATE arena_results SET human=? WHERE run_id=? AND subject=?").run(value === 0 ? null : value, run_id, subject);
          json(res, r.changes ? 200 : 404, { ok: !!r.changes });
        } catch (err) { json(res, 400, { error: err.message }); }
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/event") {
      let body = "";
      req.on("data", (d) => { body += d; if (body.length > 10_000_000) req.destroy(); });
      req.on("end", () => {
        res.writeHead(204).end(); // answer first so the hook never waits
        try { ingest(JSON.parse(body)); } catch (err) { if (!quiet) console.error("bad event:", err.message); }
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/reviews") {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        try {
          const r = JSON.parse(body);
          db.prepare("INSERT INTO reviews (session_id, ts, verdict, cost_usd, report) VALUES (?,?,?,?,?)")
            .run(r.session_id, Date.now(), r.verdict ?? null, r.cost_usd ?? 0, JSON.stringify(r));
          broadcast({ session_id: r.session_id, ts: Date.now(), type: "ReviewDone", summary: `${r.verdict} ($${(r.cost_usd ?? 0).toFixed(3)})` });
          json(res, 201, { ok: true });
        } catch (err) { json(res, 400, { error: err.message }); }
      });
      return;
    }
    if (req.method !== "GET") return res.writeHead(404).end();
    if (url.pathname === "/spend/today") {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      return json(res, 200, db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS usd FROM reviews WHERE ts>=?").get(start.getTime()));
    }
    {
      const rm = url.pathname.match(/^\/sessions\/([^/]+)\/reviews$/);
      if (rm) return json(res, 200, db.prepare("SELECT id,ts,verdict,cost_usd,report FROM reviews WHERE session_id=? ORDER BY id DESC").all(decodeURIComponent(rm[1])));
    }
    if (url.pathname === "/health") return res.writeHead(200).end("ok");
    if (url.pathname === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res); req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/sessions") {
      return json(res, 200, db.prepare(`SELECT s.*, (SELECT verdict FROM reviews r WHERE r.session_id=s.id ORDER BY r.id DESC LIMIT 1) AS review_verdict
        FROM sessions s ORDER BY last_event_at DESC LIMIT 100`).all());
    }
    if (url.pathname === "/arena/runs") {
      return json(res, 200, db.prepare(`SELECT r.id, r.ts, r.task_id, r.prompt, r.judges,
        (SELECT COUNT(*) FROM arena_results x WHERE x.run_id=r.id) AS subjects FROM arena_runs r ORDER BY r.ts DESC LIMIT 100`).all());
    }
    if (url.pathname === "/arena/board") return json(res, 200, leaderboard(db, url.searchParams.get("task") || undefined));
    {
      const am = url.pathname.match(/^\/arena\/runs\/([^/]+)$/);
      if (am) {
        const run = db.prepare("SELECT * FROM arena_runs WHERE id=?").get(decodeURIComponent(am[1]));
        if (!run) return json(res, 404, { error: "no such run" });
        const results = db.prepare("SELECT * FROM arena_results WHERE run_id=?").all(run.id)
          .map((r) => ({ ...r, ok: !!r.ok, checks_passed: !!r.checks_passed, checks: JSON.parse(r.checks || "[]"), judge_detail: JSON.parse(r.judge_detail || "[]"), judges: undefined }));
        return json(res, 200, { run: { ...run, judges: JSON.parse(run.judges || "{}") }, results });
      }
    }
    const m = url.pathname.match(/^\/sessions\/([^/]+)\/(events|snapshot)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (m[2] === "events") return json(res, 200, db.prepare("SELECT id,ts,type,tool_name,summary,duration_ms FROM events WHERE session_id=? ORDER BY id").all(id));
      const snap = db.prepare("SELECT * FROM snapshots WHERE session_id=? ORDER BY id DESC LIMIT 1").get(id);
      if (!snap) return json(res, 404, { error: "no snapshot" });
      // the transcript copy can be hundreds of KB; only send it when asked
      const { transcript_copy, ...lite } = snap;
      return json(res, 200, url.searchParams.get("full") ? snap : { ...lite, transcript_bytes: transcript_copy?.length ?? 0 });
    }
    res.writeHead(404).end();
  });

  return new Promise((resolve) => server.listen(port, HOST, () => {
    if (!quiet) console.log(`warden daemon on http://${HOST}:${port}`);
    resolve({ server, db, close: () => { for (const r of clients) r.end(); server.close(); db.close(); } });
  }));
}
