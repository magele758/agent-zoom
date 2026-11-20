import type { DatabaseSync } from "node:sqlite";

export const LEASE_MS = 10 * 60 * 1000;

// Channel and workflow claims have different foreign keys and release policies.
// Both acquire, renew and close the same lease contract.
type ClaimTable = "task_claims" | "workflow_claims" | "stage_claims";

export function acquireClaim(db: DatabaseSync, table: ClaimTable, id: string, taskId: string, role: string, agentId: string) {
  const stamp = new Date();
  const until = new Date(stamp.getTime() + LEASE_MS).toISOString();
  db.prepare(`INSERT INTO ${table} (id, task_id, role, agent_id, state, lease_until, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`).run(id, taskId, role, agentId, until, stamp.toISOString(), stamp.toISOString());
  return until;
}

export function renewClaim(db: DatabaseSync, table: ClaimTable, taskId: string, agentId: string) {
  const stamp = new Date();
  const until = new Date(stamp.getTime() + LEASE_MS).toISOString();
  const update = db.prepare(`UPDATE ${table} SET lease_until=?, updated_at=?
    WHERE task_id=? AND agent_id=? AND state='active'`).run(until, stamp.toISOString(), taskId, agentId);
  return update.changes ? until : undefined;
}

export function finishClaim(db: DatabaseSync, table: ClaimTable, taskId: string, role: string, agentId: string, state: string) {
  db.prepare(`UPDATE ${table} SET state=?, updated_at=?
    WHERE task_id=? AND role=? AND agent_id=? AND state='active'`).run(state, new Date().toISOString(), taskId, role, agentId);
}
