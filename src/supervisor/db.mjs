// SQLite store (built-in node:sqlite, zero dependencies).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DATA_DIR = process.env.WARDEN_HOME || path.join(os.homedir(), ".warden");
fs.mkdirSync(DATA_DIR, { recursive: true });

export function openDb(file = path.join(DATA_DIR, "warden.db")) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      transcript_path TEXT,
      started_at INTEGER,
      last_event_at INTEGER,
      status TEXT DEFAULT 'running',      -- running | stopped
      first_prompt TEXT,
      event_count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      tool_name TEXT,
      summary TEXT,
      duration_ms INTEGER,
      payload TEXT NOT NULL               -- full hook JSON
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
    CREATE TABLE IF NOT EXISTS snapshots (   -- repo state captured at Stop
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      git_status TEXT,
      git_diff TEXT,
      transcript_copy TEXT                   -- transcript JSONL at Stop time
    );
    CREATE INDEX IF NOT EXISTS idx_snap_session ON snapshots(session_id, id);
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      verdict TEXT,
      cost_usd REAL DEFAULT 0,
      report TEXT NOT NULL               -- merged report JSON
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_session ON reviews(session_id, id);
    CREATE TABLE IF NOT EXISTS arena_runs (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      task_id TEXT,
      prompt TEXT,
      repo TEXT,
      base TEXT,
      judges TEXT                          -- JSON: judges used + any independence warnings
    );
    CREATE TABLE IF NOT EXISTS arena_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      model TEXT,
      ok INTEGER,                          -- subject finished without error
      error TEXT,
      duration_ms INTEGER,
      cost_usd REAL,                       -- null = unknown
      tokens INTEGER,
      turns INTEGER,
      checks TEXT,                         -- JSON [{name, pass, ms}]
      checks_passed INTEGER,               -- 1 only if every check passed
      files_changed INTEGER,
      lines_added INTEGER,
      lines_removed INTEGER,
      diff TEXT,
      judge_avg REAL,                      -- 1-10, null if no valid judge
      judge_detail TEXT,
      human INTEGER                        -- +1 / -1 / null
    );
    CREATE INDEX IF NOT EXISTS idx_arena_results_run ON arena_results(run_id);
  `);
  return db;
}
