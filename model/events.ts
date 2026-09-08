import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import type { ForgeEventType, ForgeEventPayload, StoredEvent } from "./schema.js";

const DB_PATH = path.join(process.cwd(), ".forge", "events.db");

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      type      TEXT NOT NULL,
      payload   TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      commit_sha TEXT
    )
  `);
  return _db;
}

export function appendEvent(
  type: ForgeEventType,
  payload: ForgeEventPayload,
  commitSha?: string,
): StoredEvent {
  const timestamp = new Date().toISOString();
  const stmt = db().prepare(
    "INSERT INTO events (type, payload, timestamp, commit_sha) VALUES (?, ?, ?, ?)",
  );
  const result = stmt.run(type, JSON.stringify(payload), timestamp, commitSha ?? null);
  return {
    id: result.lastInsertRowid as number,
    type,
    payload,
    timestamp,
    commitSha: commitSha ?? null,
  };
}

export function getAllEvents(): StoredEvent[] {
  return (
    db()
      .prepare("SELECT * FROM events ORDER BY id ASC")
      .all() as Array<{
        id: number;
        type: string;
        payload: string;
        timestamp: string;
        commit_sha: string | null;
      }>
  ).map((row) => ({
    id: row.id,
    type: row.type as ForgeEventType,
    payload: JSON.parse(row.payload) as ForgeEventPayload,
    timestamp: row.timestamp,
    commitSha: row.commit_sha,
  }));
}

export function getEventsSince(afterId: number): StoredEvent[] {
  return (
    db()
      .prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC")
      .all(afterId) as Array<{
        id: number;
        type: string;
        payload: string;
        timestamp: string;
        commit_sha: string | null;
      }>
  ).map((row) => ({
    id: row.id,
    type: row.type as ForgeEventType,
    payload: JSON.parse(row.payload) as ForgeEventPayload,
    timestamp: row.timestamp,
    commitSha: row.commit_sha,
  }));
}

export function getLatestEventId(): number {
  const row = db().prepare("SELECT MAX(id) as maxId FROM events").get() as {
    maxId: number | null;
  };
  return row.maxId ?? 0;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function resetDb(): void {
  closeDb();
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
}
