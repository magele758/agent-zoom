import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { DecisionPacket } from "../../kernel/types.ts";

const snapshot = z.array(z.object({
  taskId: z.string().min(1),
  title: z.string().optional(),
  project: z.string().min(1),
  status: z.string().min(1),
  updatedAt: z.string().min(1),
})).min(1);

const patrolOptions = z.array(z.object({
  id: z.enum(["requeue", "snooze", "archive"]),
  handlerKey: z.string(),
  payload: z.object({
    patrolRunId: z.string().min(1).optional(),
    taskIds: z.array(z.string().min(1)).min(1),
    taskId: z.string().optional(),
  }),
})).min(1);

const unverified = "无法核实这项审批对应的巡检记录和任务范围，请重新运行巡检。";

export function patrolActionBlockReason(db: DatabaseSync, packet: DecisionPacket): string | undefined {
  const day = /^product:patrol:(\d{4}-\d{2}-\d{2})$/.exec(packet.dedupeKey)?.[1];
  const options = patrolOptions.safeParse(packet.options).data;
  if (!day || !options) return unverified;
  const runId = options[0].payload.patrolRunId;
  if (!options.every(o => o.payload.patrolRunId === runId && o.handlerKey === "product.patrol_" + o.id)) return unverified;

  let audit;
  if (runId) {
    audit = db.prepare("SELECT alerts_json, created_at FROM opc_patrol_runs WHERE id=?").get(runId);
  } else {
    // Older packets carried a UTC day. A second report or packet that day makes this link ambiguous.
    const audits = db.prepare(`SELECT alerts_json, created_at FROM opc_patrol_runs
      WHERE created_at >= ? AND created_at < date(?, '+1 day') LIMIT 2`).all(day, day);
    const packets = db.prepare(`SELECT id FROM opc_decision_packets
      WHERE domain='product' AND kind='patrol_alert' AND dedupe_key=? LIMIT 2`).all(packet.dedupeKey);
    if (audits.length !== 1 || packets.length !== 1 || packets[0].id !== packet.id) return unverified;
    audit = audits[0];
  }
  if (!audit || String(audit.created_at).slice(0, 10) !== day) return unverified;

  let alerts;
  try {
    alerts = snapshot.safeParse(JSON.parse(String(audit.alerts_json))).data;
  } catch {
    return unverified;
  }
  if (!alerts) return unverified;
  const ids = new Set(alerts.map(a => a.taskId));
  if (ids.size !== alerts.length) return unverified;
  for (const { payload } of options) {
    const scope = new Set(payload.taskIds);
    if (scope.size !== ids.size || scope.size !== payload.taskIds.length || !payload.taskIds.every(id => ids.has(id))
      || (payload.taskId !== undefined && !ids.has(payload.taskId))) return unverified;
  }

  const readTask = db.prepare("SELECT project, title, status, updated_at FROM opc_planning_tasks WHERE id=?");
  for (const alert of alerts) {
    const current = readTask.get(alert.taskId);
    if (!current || current.project !== alert.project || current.status !== alert.status || current.updated_at !== alert.updatedAt) {
      const title = String(current?.title || alert.title || alert.taskId);
      return `「${alert.project}」的任务「${title}」已在巡检后发生变化，请重新运行巡检后处理。`;
    }
  }
}
