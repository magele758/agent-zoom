import type { ExecutiveMailItem, ExecutiveReceiptTrace } from "./executive-bots-types.ts";
import type { DecisionPacket } from "./kernel/types.ts";
import type { ZoomMessage } from "./zoom-types.ts";

type RecordFields = { id: string; at: string; pending: boolean; unread: boolean };

export type MailboxRecord = RecordFields & (
  | { kind: "decision"; item: DecisionPacket }
  | { kind: "executive"; item: ExecutiveMailItem }
  | { kind: "system"; item: ZoomMessage }
);

export type MailboxIssue = MailboxRecord & {
  primaryId: string;
  records: MailboxRecord[];
  aliases: string[];
  decisions: DecisionPacket[];
  receipts: ExecutiveMailItem[];
  messages: ZoomMessage[];
  pendingDecisionIds: string[];
  state: "pending" | "working" | "archived";
};

export type MailboxIssueInput = {
  decisions: DecisionPacket[];
  items: ExecutiveMailItem[];
  messages: ZoomMessage[];
  sourceTraces?: Record<string, ExecutiveReceiptTrace>;
};

const decisionKey = (id: string) => `dec:${id}`;
const executiveKey = (id: string) => `exec:${id}`;
const messageKey = (id: string) => `sys:${id}`;

function patrolScope(ids: unknown): string | undefined {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== "string" || !id)) return;
  if (new Set(ids).size !== ids.length) return;
  return `issue:patrol:${JSON.stringify([...ids].sort())}`;
}

function packetPatrolScope(packet: DecisionPacket) {
  if (packet.kind !== "patrol_alert" || packet.domain !== "product" || !packet.options.length) return;
  if (!packet.options.every(option =>
    ["requeue", "snooze", "archive"].includes(option.id) && option.handlerKey === `product.patrol_${option.id}`)) return;
  const scopes = packet.options.map(option => patrolScope(option.payload?.taskIds));
  const patrolRunId = packet.options[0].payload?.patrolRunId;
  if (!packet.options.every(option => option.payload?.patrolRunId === patrolRunId)) return;
  if (scopes[0] && scopes.every(scope => scope === scopes[0])) return scopes[0];
}

function tracePatrolScope(trace?: ExecutiveReceiptTrace) {
  if (trace?.origin?.patrolRunId) return patrolScope(trace.affectedTasks.map(task => task.id));
}

function isPatrolNotice(message: ZoomMessage) {
  return message.source === "OPC OS · 后台巡检卫士" && message.folder === "公司/巡检告警";
}

function matchingKillPacket(message: ZoomMessage, decisions: DecisionPacket[]) {
  if (message.source !== "OPC OS · 商业熔断卫士" || message.kind !== "question") return;
  const project = message.folder.split("/")[0];
  if (!project) return;
  const matches = decisions.filter(packet => packet.domain === "commercial" && packet.kind === "kill_switch" &&
    packet.dedupeKey === `commercial:kill_switch:${project}` && packet.backgroundSummary === message.body &&
    packet.options.length > 0 && packet.options.every(option => option.payload?.project === project));
  if (matches.length === 1) return matches[0];
}

function taskGroup(origin: ZoomMessage["origin"], taskId: string) {
  return `issue:task:${origin}:${taskId}`;
}

function isActionableMessage(message: ZoomMessage) {
  return message.pending && !message.readOnly && !message.failureNotice && !isPatrolNotice(message) &&
    message.delegation?.status !== "queued" && message.delegation?.status !== "working" &&
    (Boolean(message.action) || (message.id.startsWith("delegation:") && message.delegation?.status === "approval" &&
      message.delegation.requiresApproval && message.delegation.sourceId.startsWith("opportunity:")));
}

function isExplicitQuestion(mail: ExecutiveMailItem) {
  return mail.direction === "inbound" && !mail.read && mail.status === "completed" && mail.needsDecision &&
    !mail.trace?.decision && !mail.trace?.decisionId && !mail.trace?.origin;
}

function workState(record: MailboxRecord): { key: string; working: boolean } | undefined {
  if (record.kind === "executive" && record.item.source === "department_task") {
    const workId = record.item.trace?.origin?.workId;
    return { key: workId ? `work:${workId}` : `remote:${record.item.taskId ?? record.item.id}`, working: record.item.status === "working" };
  }
  if (record.kind === "system" && record.item.delegation) {
    const delegation = record.item.delegation;
    return { key: `work:${delegation.workId}`, working: delegation.status === "queued" || delegation.status === "working" };
  }
}

function newestFirst(a: MailboxRecord, b: MailboxRecord) {
  return b.at.localeCompare(a.at) || a.id.localeCompare(b.id);
}

function primaryFirst(a: MailboxRecord, b: MailboxRecord) {
  const priority = (record: MailboxRecord) => record.kind === "decision" ? 2 : record.kind === "system" ? 1 : 0;
  return Number(b.pending) - Number(a.pending) || priority(b) - priority(a) || newestFirst(a, b);
}

/** Merge records using persisted associations/IDs, never report titles or dates alone. */
export function buildMailboxIssues({ decisions, items, messages, sourceTraces = {} }: MailboxIssueInput): MailboxIssue[] {
  const packets = new Map(decisions.map(packet => [packet.id, packet]));
  const byMessage = new Map(messages.map(message => [message.id, message]));
  const sourceScopes = new Map<string, Set<string>>();
  const patrolScopesByTask = new Map<string, Set<string>>();
  const traces = [...Object.values(sourceTraces), ...items.flatMap(mail => mail.trace ? [mail.trace] : [])];
  for (const trace of traces) {
    const scope = tracePatrolScope(trace);
    if (!scope) continue;
    const addScope = (map: Map<string, Set<string>>, id?: string) => {
      if (!id) return;
      const scopes = map.get(id) ?? new Set<string>();
      scopes.add(scope);
      map.set(id, scopes);
    };
    addScope(sourceScopes, trace.origin?.messageId);
    addScope(patrolScopesByTask, trace.origin?.taskId);
  }

  // Disjoint-set groups make a source, its separate remote receipt and exact
  // formal packet converge even when one arrives in a later refresh.
  const parents = new Map<string, string>();
  const groupedScopes = new Map<string, string>();
  const find = (id: string): string => {
    const parent = parents.get(id);
    if (!parent) {
      parents.set(id, id);
      if (id.startsWith("issue:patrol:")) groupedScopes.set(id, id);
      return id;
    }
    if (parent === id) return id;
    const root = find(parent);
    parents.set(id, root);
    return root;
  };
  const connect = (id: string, key: string | undefined) => {
    if (!key) return;
    const a = find(id);
    const b = find(key);
    if (a === b) return;
    const aScope = groupedScopes.get(a);
    const bScope = groupedScopes.get(b);
    if (aScope && bScope && aScope !== bScope) return;
    parents.set(a, b);
    if (aScope) groupedScopes.set(b, aScope);
  };
  const records = new Map<string, MailboxRecord>();
  const add = (record: MailboxRecord) => { records.set(record.id, record); find(record.id); };

  const connectTrace = (id: string, trace?: ExecutiveReceiptTrace) => {
    if (!trace) return;
    const scope = tracePatrolScope(trace);
    connect(id, scope);
    const sourceId = trace.origin?.messageId;
    if (sourceId && (sourceScopes.get(sourceId)?.size ?? 0) <= 1) {
      connect(id, messageKey(sourceId));
    }
    // When a source message is outside the list, a verified workflow run ID
    // still provides the same identity as its visible workflow records.
    if (trace.origin?.kind === "workflow" && trace.origin.taskId) {
      connect(id, taskGroup("workflow", trace.origin.taskId));
    }
    const packetId = trace.decisionId ?? (trace.decision?.kind === "kernel" ? trace.decision.id : undefined);
    if (packetId) {
      const packet = packets.get(packetId);
      const packetScope = packet && packetPatrolScope(packet);
      if (!scope || !packetScope || scope === packetScope) connect(id, decisionKey(packetId));
    }
  };

  for (const packet of decisions) {
    const pending = packet.status === "pending" && !packet.actionBlockReason && packet.options.length > 0;
    const id = decisionKey(packet.id);
    add({ kind: "decision", id, at: packet.updatedAt, pending, unread: pending && !packet.viewedAt, item: packet });
    connect(id, packetPatrolScope(packet));
  }
  for (const message of messages) {
    if (message.id.startsWith("home-room:")) continue;
    const id = messageKey(message.id);
    const killPacket = matchingKillPacket(message, decisions);
    const pending = !killPacket && isActionableMessage(message);
    add({ kind: "system", id, at: message.at, pending, unread: pending, item: message });
    if (killPacket) connect(id, decisionKey(killPacket.id));
    const scopes = sourceScopes.get(message.id);
    if ((scopes?.size ?? 0) <= 1) connectTrace(id, sourceTraces[message.id]);
    if (isPatrolNotice(message)) {
      if (scopes?.size === 1) connect(id, scopes.values().next().value);
      // A task registration supplies context, not an extra alert. Daily patrol
      // tasks can contain different scopes, so attach it only if unambiguous.
      const taskScopes = patrolScopesByTask.get(message.taskId);
      if (message.kind === "task" && taskScopes?.size === 1) connect(id, taskScopes.values().next().value);
    } else {
      connect(id, taskGroup(message.origin, message.taskId));
    }
    if (message.replyTo) {
      const original = byMessage.get(message.replyTo);
      if (original && original.taskId === message.taskId && original.origin === message.origin) {
        connect(id, messageKey(original.id));
      }
    }
    const delegation = message.delegation;
    if (delegation && (message.id.startsWith("delegation:") || message.taskId === delegation.workId)) {
      connect(id, messageKey(delegation.sourceId));
    }
  }
  for (const mail of items) {
    // Keep prior visibility semantics for the redundant kernel notification.
    if (mail.body.startsWith("[待审批 ·") && !mail.trace?.origin && !mail.trace?.decisionId) continue;
    const id = executiveKey(mail.id);
    // The live decision or source question, if present, is authoritative.
    // Remote receipts do not independently reopen a previously resolved action.
    const pending = isExplicitQuestion(mail);
    add({ kind: "executive", id, at: mail.createdAt, pending, unread: mail.direction === "inbound" && !mail.read, item: mail });
    connectTrace(id, mail.trace);
  }

  const grouped = new Map<string, MailboxRecord[]>();
  for (const record of records.values()) {
    const root = find(record.id);
    const group = grouped.get(root) ?? [];
    group.push(record);
    grouped.set(root, group);
  }
  const groupKeys = new Map<string, string[]>();
  for (const key of parents.keys()) {
    const root = find(key);
    const keys = groupKeys.get(root) ?? [];
    keys.push(key);
    groupKeys.set(root, keys);
  }

  return [...grouped.entries()].map(([root, group]): MailboxIssue => {
    group.sort(newestFirst);
    const keys = (groupKeys.get(root) ?? []).sort();
    const primary = [...group].sort(primaryFirst)[0];
    const linkedPatrol = keys.filter(key => key.startsWith("issue:patrol:"));
    // Preserve the canonical scope for recurring patrols and task/run ID for
    // other histories. Standalone mail retains its original record ID.
    const id = linkedPatrol.length === 1 ? linkedPatrol[0] :
      keys.find(key => key.startsWith("issue:task:workflow:")) ??
      keys.find(key => key.startsWith("issue:task:")) ??
      keys.find(key => key.startsWith("dec:")) ??
      keys.find(key => key.startsWith("sys:")) ?? primary.id;
    const pending = group.some(record => record.pending);
    // The newest status of each work unit wins over historical delivery
    // records or the same delegation decorated onto older source messages.
    const latestWork = new Map<string, boolean>();
    for (const record of group) {
      const state = workState(record);
      if (state && !latestWork.has(state.key)) latestWork.set(state.key, state.working);
    }
    const working = [...latestWork.values()].some(Boolean);
    return {
      ...primary, primaryId: primary.id, id, at: group[0].at, pending,
      unread: group.some(record => record.unread), state: pending ? "pending" : working ? "working" : "archived",
      aliases: [...new Set([id, ...group.map(record => record.id)])], records: group,
      decisions: group.flatMap(record => record.kind === "decision" ? [record.item] : []),
      receipts: group.flatMap(record => record.kind === "executive" ? [record.item] : []),
      messages: group.flatMap(record => record.kind === "system" ? [record.item] : []),
      pendingDecisionIds: group.flatMap(record => record.kind === "decision" && record.pending ? [record.item.id] : []),
    };
  }).sort((a, b) => Number(b.pending) - Number(a.pending) || newestFirst(a, b));
}
