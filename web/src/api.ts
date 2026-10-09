export type RoomScope = { project: string; directories: string[]; branch: string };
export type Room = { id: string; org_id: string; name: string; topic: string; created_at: string } & RoomScope;
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
  handle: string | null;
  taskId: string | null;
  taskTitle: string | null;
  kind: string;
  body: string;
  createdAt: string;
};

export type Claim = { role: string; handle: string; agentId: string; ownerName: string };
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
  parentId?: string | null;
  lane?: number | null;
  direction?: string;
  deliverableRef?: string | null;
  deliverableSummary?: string | null;
  winnerTaskId?: string | null;
  bidUntil?: string | null;
  scope?: RoomScope;
  claims: Claim[];
  lanes?: Task[];
  updatedAt: string;
};

export type Snapshot = {
  room: { id: string; name: string; topic: string } & RoomScope;
  members: {
    users: Array<{ id: string; name: string; online: boolean }>;
    agents: Agent[];
  };
  messages: Message[];
  tasks: Task[];
  locks: Array<{ path: string; handle: string; taskId: string | null }>;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "请求失败");
  return data as T;
}

export const api = {
  me: () => request<Me>("/api/me"),
  enter: (name: string) => request<{ user: { id: string; name: string }; roomId: string | null }>("/api/session", { method: "POST", body: JSON.stringify({ name }) }),
  logout: () => request("/api/logout", { method: "POST", body: "{}" }),
  rooms: () => request<{ rooms: Room[] }>("/api/rooms"),
  createRoom: (input: { name: string; topic: string; project?: string; directories?: string[]; branch?: string }) =>
    request<{ id: string }>("/api/rooms", { method: "POST", body: JSON.stringify(input) }),
  setScope: (roomId: string, input: { project: string; directories: string[]; branch: string }) =>
    request<RoomScope>(`/api/rooms/${roomId}`, { method: "PATCH", body: JSON.stringify(input) }),
  snapshot: (roomId: string) => request<Snapshot>(`/api/rooms/${roomId}`),
  post: (
    roomId: string,
    input: {
      body: string;
      kind: string;
      taskId?: string | null;
      acceptance?: string;
      parallel?: boolean;
      tags?: string;
      complex?: boolean;
    },
  ) => request(`/api/rooms/${roomId}/messages`, { method: "POST", body: JSON.stringify(input) }),
  invite: (roomId: string, name: string) => request(`/api/rooms/${roomId}/members`, { method: "POST", body: JSON.stringify({ name }) }),
  joinCode: (roomId: string) => request<{ code: string; expiresAt: string }>(`/api/rooms/${roomId}/join-codes`, { method: "POST", body: "{}" }),
  pause: (agentId: string, paused: boolean) => request(`/api/agents/${agentId}`, { method: "PATCH", body: JSON.stringify({ paused }) }),
  setLevel: (agentId: string, level: number) =>
    request(`/api/agents/${agentId}/level`, { method: "PATCH", body: JSON.stringify({ level }) }),
  cancel: (taskId: string) => request(`/api/tasks/${taskId}/cancel`, { method: "POST", body: "{}" }),
  done: (taskId: string) => request(`/api/tasks/${taskId}/done`, { method: "POST", body: "{}" }),
};
