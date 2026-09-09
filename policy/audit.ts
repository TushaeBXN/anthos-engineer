import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { PolicyDecisionRecord } from "./schema.js";

const AUDIT_DB = path.join(process.cwd(), ".forge", "audit.db");

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(AUDIT_DB), { recursive: true });
  _db = new Database(AUDIT_DB);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id      TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      resource      TEXT NOT NULL,
      operation     TEXT NOT NULL,
      target        TEXT NOT NULL,
      decision      TEXT NOT NULL,
      matched_rule  TEXT,
      reason        TEXT NOT NULL,
      timestamp     TEXT NOT NULL
    )
  `);
  return _db;
}

export function recordDecision(record: PolicyDecisionRecord): void {
  db()
    .prepare(
      `INSERT INTO audit_log
        (agent_id, session_id, resource, operation, target, decision, matched_rule, reason, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.request.agentId,
      record.request.sessionId,
      record.request.resource,
      record.request.operation,
      record.request.target,
      record.decision,
      record.matchedRuleId ?? null,
      record.reason,
      record.timestamp,
    );
}

export interface AuditEntry {
  id: number;
  agentId: string;
  sessionId: string;
  resource: string;
  operation: string;
  target: string;
  decision: string;
  matchedRule: string | null;
  reason: string;
  timestamp: string;
}

export function getAuditLog(limit = 100): AuditEntry[] {
  return (
    db()
      .prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(limit) as Array<{
        id: number;
        agent_id: string;
        session_id: string;
        resource: string;
        operation: string;
        target: string;
        decision: string;
        matched_rule: string | null;
        reason: string;
        timestamp: string;
      }>
  ).map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    sessionId: r.session_id,
    resource: r.resource,
    operation: r.operation,
    target: r.target,
    decision: r.decision,
    matchedRule: r.matched_rule,
    reason: r.reason,
    timestamp: r.timestamp,
  }));
}

export function closeAuditDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
