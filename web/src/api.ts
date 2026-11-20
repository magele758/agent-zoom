import type { CompanyIndex } from "../../src/company-types";
import type { HubDay, WorklogBinding, WorklogIndex, WorklogTarget } from "../../src/worklog-types";
import type { Opportunity, OpportunityProject, OpportunityIndex } from "../../src/autonomy-types";
import type { ZoomMessage } from "../../src/zoom-types";
import type { GrowthReport } from "../../src/growth-types";
import type { ProjectIndex, ZoomProject } from "../../src/project-types";
import type { WorkflowDetail, WorkflowSummary } from "../../src/workflow-types";
export type BoardMark = { id: string; seenThrough: number; archivedThrough: number | null };
export type BoardMarkAction = "read" | "archive" | "unarchive";
import type { CoordinationRun } from "../../src/coordinator-types";
export type { CoordinationRun } from "../../src/coordinator-types";
export type RoomScope = { project: string; directories: string[]; branch: string };
export type Room = {
  id: string;
  org_id: string;
  name: string;
  topic: string;
  currentTopic: string;
  general: boolean;
  archived: boolean;
  direct: boolean;
  created_at: string;
  unread?: number;
} & RoomScope;
export type LocalAgent = {
  id: string;
  label: string;
  handle: string;
  runtime: string;
  detail: string;
  writable: boolean;
  inRoom: boolean;
  configured: boolean;
  connected: boolean;
  credentialValid?: boolean;
  online?: boolean;
  stateNote?: string;
};

export type Agent = {
  id: string;
  handle: string;
  runtime: string;
  paused: number | boolean;
  demo: number | boolean;
  tags?: string;
  level?: number;
  machine?: string;
  cwd?: string;
  org_id?: string;
  last_seen_at?: string | null;
  ownerName?: string;
  online?: boolean;
};

export type Me = {
  user: { id: string; name: string };
  orgs: Array<{ id: string; name: string; role: string }>;
  rooms: Room[];
  agents: Agent[];
};

export type Message = {
  id: string;
  seq: number;
  authorType: string;
  authorName: string;
  demo?: boolean;
  runtime?: string | null;
  replyGroup?: string | null;
  replyGroupLabel?: string | null;
  handle: string | null;
  taskId: string | null;
  taskTitle: string | null;
  kind: string;
  body: string;
  createdAt: string;
};

export type Claim = { role: string; handle: string; agentId: string; ownerName: string; state?: string };
export type Task = {
  id: string;
  title: string;
  body: string;
  status: string;
  acceptance?: string;
  mode?: string;
  maxLanes?: number;
  tags?: string;
  complex?: boolean;
  designPending?: string[];
  designs?: Array<{ handle: string; group: string; body: string }>;
  parentId?: string | null;
  lane?: number | null;
  direction?: string;
  deliverableRef?: string | null;
  deliverableSummary?: string | null;
  deliverableBody?: string | null;
  evidence?: Array<{ id: string; handle: string; kind: string; body: string; createdAt: string }>;
  winnerTaskId?: string | null;
  bidUntil?: string | null;
  pipelineId?: string | null;
  stepIndex?: number | null;
  stepRole?: string | null;
  assigneeHandle?: string;
  handles?: string[];
  conclusions?: Array<{ handle: string; verdict: string }>;
  scope?: RoomScope;
  claims: Claim[];
  lanes?: Task[];
  updatedAt: string;
};

export type Snapshot = {
  room: {
    id: string;
    name: string;
    topic: string;
    currentTopic: string;
    general: boolean;
    archived: boolean;
    direct: boolean;
  } & RoomScope;
  members: {
    users: Array<{ id: string; name: string; online: boolean }>;
    agents: Agent[];
  };
  messages: Message[];
  tasks: Task[];
  locks: Array<{ path: string; handle: string; taskId: string | null }>;
};

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(data?.message || "请求失败"), { code: data?.error, status: response.status });
  if (data == null) throw Object.assign(new Error("服务返回了无法读取的数据"), {
    code: response.headers.get("content-type")?.includes("text/html") ? "html_response" : "invalid_response",
    status: response.status,
  });
  return data as T;
}

async function loadLocalUser(): Promise<Me> {
  try {
    return await fetchJson<Me>("/api/me");
  } catch (error) {
    if ((error as { status?: number }).status !== 401) throw error;
    const health = await fetchJson<{ ok: boolean; sharedLocal?: boolean }>("/api/health");
    if (!health.ok || health.sharedLocal) throw error;
    // Older local servers require a named session before they serve channels.
    await fetchJson("/api/session", { method: "POST", body: JSON.stringify({ name: "本机" }) });
    return fetchJson<Me>("/api/me");
  }
}

let opening: Promise<Me> | undefined;
function openLocalUser() {
  return opening ??= loadLocalUser().finally(() => { opening = undefined; });
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await fetchJson<T>(path, init);
  } catch (error) {
    if ((error as { status?: number }).status !== 401) throw error;
    await openLocalUser();
    return fetchJson<T>(path, init);
  }
}

export type OpportunityDraft = Pick<Opportunity, "project" | "kind" | "sourceId" | "title" | "rationale" | "evidence" | "impact" | "confidence" | "effort" | "capabilityRefs">;
export type { OpportunityIndex };

export const api = {
  companyIndex: (signal?: AbortSignal) => request<CompanyIndex>("/api/zoom/company", { signal }),
  createCompanyProject: (product: string, name: string) => request<{ product: string; name: string }>("/api/zoom/company/projects", {
    method: "POST", body: JSON.stringify({ product, name }),
  }),
  worklog: () => request<WorklogIndex>("/api/opc/worklog"),
  worklogDay: (date: string) => request<HubDay>("/api/opc/worklog/day?date=" + encodeURIComponent(date)),
  bindWorklog: (data: WorklogTarget & { date: string; key: string; previous: WorklogTarget | null }) =>
    request<WorklogBinding>("/api/opc/worklog/bind", { method: "POST", body: JSON.stringify(data) }),
  unbindWorklog: (data: { date: string; key: string; previous: WorklogTarget }) =>
    request<{ removed: boolean }>("/api/opc/worklog/bind", { method: "DELETE", body: JSON.stringify(data) }),
  opportunities: (signal?: AbortSignal) => request<OpportunityIndex>("/api/opc/opportunities", { signal }),
  addOpportunity: (input: OpportunityDraft) => request<Opportunity>("/api/opc/opportunities", {
    method: "POST", body: JSON.stringify(input),
  }),
  setOpportunityPolicy: (project: string, enabled: boolean) => request<OpportunityProject>("/api/opc/policy", {
    method: "POST", body: JSON.stringify({ project, enabled }),
  }),
  selectOpportunity: (project: string) => request<{ opportunity: Opportunity | null }>("/api/opc/select", {
    method: "POST", body: JSON.stringify({ project }),
  }),
  skipOpportunity: (id: string) => request<Opportunity>(`/api/opc/opportunities/${encodeURIComponent(id)}/skip`, {
    method: "POST", body: "{}",
  }),
  projects: (signal: AbortSignal) => request<ProjectIndex>("/api/zoom/projects", { signal }),
  createProject: (name: string) => request<{ project: ZoomProject; created: boolean }>("/api/zoom/projects", {
    method: "POST", body: JSON.stringify({ name }),
  }),
  growthReport: (product: string, signal: AbortSignal) =>
    request<GrowthReport>(product ? `/api/zoom/growth?product=${encodeURIComponent(product)}` : "/api/zoom/growth", { signal }),
  zoomMessages: async () => {
    const result = await request<{ messages: ZoomMessage[]; products?: string[]; projectFolders?: string[] }>("/api/zoom/messages");
    if (!Array.isArray(result.messages)) throw new Error("服务返回的消息列表格式不正确");
    return result;
  },
  zoomReply: (taskId: string, data: { questionId: string; body?: string; choice?: string }) =>
    request<{ state?: string }>(`/api/zoom/tasks/${encodeURIComponent(taskId)}/replies`, { method: "POST", body: JSON.stringify(data) }),
  workflowEnabled: () => request<{ enabled: boolean }>("/api/workflows/enabled"),
  workflows: () => request<{ runs: WorkflowSummary[] }>("/api/workflows"),
  workflowMarks: () => request<{ marks: BoardMark[] }>("/api/workflows/board/marks"),
  markWorkflow: (id: string, action: BoardMarkAction, through: number) =>
    request<BoardMark>(`/api/workflows/${encodeURIComponent(id)}/mark`, {
      method: "POST", body: JSON.stringify({ action, through }),
    }),
  workflow: (id: string) => request<WorkflowDetail>(`/api/workflows/${encodeURIComponent(id)}`),
  workflowAction: (id: string, action: "decisions" | "retry" | "recover" | "runners" | "cleanup", body: object) =>
    request<WorkflowDetail>(`/api/workflows/${encodeURIComponent(id)}/${action}`, {
      method: "POST", body: JSON.stringify(body),
    }),
  coordinatorInfo: () => request<{configured:boolean;sdk:string;model:string;source:string;error:string}>("/api/coordinator"),
  coordination: (roomId:string) => request<{runs:CoordinationRun[]}>(`/api/rooms/${roomId}/coordination`),
  coordinate: (roomId:string,prompt:string) => request<CoordinationRun>(`/api/rooms/${roomId}/coordination`,{method:"POST",body:JSON.stringify({prompt})}),
  coordinationRun: (id:string) => request<CoordinationRun>(`/api/coordination/${id}`),
  stopCoordination: (id:string) => request<CoordinationRun>(`/api/coordination/${id}/stop`,{method:"POST",body:"{}"}),
  applyCoordination: (id:string) => request<{run:CoordinationRun;task:Task}>(`/api/coordination/${id}/apply`,{method:"POST",body:"{}"}),
  me: openLocalUser,
  rooms: () => request<{ rooms: Room[] }>("/api/rooms"),
  createRoom: (input: {
    name: string;
    topic: string;
    currentTopic?: string;
    project?: string;
    directories?: string[];
    branch?: string;
  }) => request<{ id: string }>("/api/rooms", { method: "POST", body: JSON.stringify(input) }),
  setScope: (roomId: string, input: { project: string; directories: string[]; branch: string }) =>
    request<RoomScope>(`/api/rooms/${roomId}`, { method: "PATCH", body: JSON.stringify(input) }),
  setChannelText: (roomId: string, input: { topic: string; currentTopic: string }) =>
    request<{ topic: string; currentTopic: string }>(`/api/rooms/${roomId}`, { method: "PATCH", body: JSON.stringify(input) }),
  setArchived: (roomId: string, archived: boolean) =>
    request<{ archived: boolean }>(`/api/rooms/${roomId}`, { method: "PATCH", body: JSON.stringify({ archived }) }),
  snapshot: (roomId: string) => request<Snapshot>(`/api/rooms/${roomId}`),
  markRead: (roomId: string, through: number) => request(`/api/rooms/${roomId}/read`, { method: "POST", body: JSON.stringify({ through }) }),
  searchMessages: (roomId: string, query: string) => request<{ messages: Message[] }>(`/api/rooms/${roomId}/messages/search?q=${encodeURIComponent(query)}`),
  conversation: (roomId: string, handle: string) => request<{ roomId: string }>(`/api/rooms/${roomId}/conversations`, { method: "POST", body: JSON.stringify({ handle }) }),
  closeConversation: (roomId: string) => request(`/api/rooms/${roomId}/close`, { method: "POST" }),
  post: (
    roomId: string,
    input: {
      body: string;
      kind: string;
      taskId?: string | null;
      replyTo?: string;
      acceptance?: string;
      parallel?: boolean;
      tags?: string;
      complex?: boolean;
    },
  ) => request(`/api/rooms/${roomId}/messages`, { method: "POST", body: JSON.stringify(input) }),
  joinCode: (roomId: string) => request<{ code: string; expiresAt: string }>(`/api/rooms/${roomId}/join-codes`, { method: "POST", body: "{}" }),
  localAgents: (roomId: string) => request<{ agents: LocalAgent[] }>(`/api/rooms/${roomId}/local-agents`),
  connectLocalAgent: (roomId: string, id: string, level = 1, group = "build", replace = false) =>
    request<{ handle: string; already: boolean; path: string; note: string }>(`/api/rooms/${roomId}/local-agents/${id}`, {
      method: "POST",
      body: JSON.stringify({ level, group, replace }),
    }),
  pause: (agentId: string, paused: boolean) => request(`/api/agents/${agentId}`, { method: "PATCH", body: JSON.stringify({ paused }) }),
  stop: (agentId: string) => request<{ id: string; handle: string; paused: boolean; released: number }>(`/api/agents/${agentId}/stop`, { method: "POST", body: "{}" }),
  setLevel: (agentId: string, level: number) =>
    request(`/api/agents/${agentId}/level`, { method: "PATCH", body: JSON.stringify({ level }) }),
  setGroup: (agentId: string, group: string | string[]) =>
    request(`/api/agents/${agentId}/group`, { method: "PATCH", body: JSON.stringify({ group }) }),
  handoff: (taskId: string) => request(`/api/tasks/${taskId}/handoff`, { method: "POST", body: "{}" }),
  cancel: (taskId: string) => request(`/api/tasks/${taskId}/cancel`, { method: "POST", body: "{}" }),
  done: (taskId: string) => request(`/api/tasks/${taskId}/done`, { method: "POST", body: "{}" }),
};
