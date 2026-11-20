export type IndexSource = {
  name: string;
  status: "ok" | "partial" | "unavailable" | "refreshing";
  asOf: string | null;
  detail: string;
};

export type IndexedAgent = {
  id: string;
  provider: string;
  state: "working" | "waiting" | "idle" | "recent" | "unknown";
  sources: string[];
  workspace: string | null;
  repository: string | null;
  updatedAt: string | null;
  label: string;
};

export type IndexedRepo = {
  fullName: string;
  url: string;
  description: string;
  visibility: "public" | "private" | "internal" | "unknown";
  relations: string[];
  paths: string[];
  language: string | null;
  pushedAt: string | null;
  defaultBranch: string | null;
  managed: { product: string; project: string }[];
};

export type AgentIndex = { agents: IndexedAgent[]; sources: IndexSource[] };
export type RepoIndex = { repositories: IndexedRepo[]; sources: IndexSource[] };
export type ActivityIndex = {
  agents: IndexedAgent[];
  repositories: IndexedRepo[];
  sources: IndexSource[];
};

export type RepoContent = {
  fullName: string;
  ref: string | null;
  source: string;
  files: { name: string; url: string; directory: boolean }[];
  readme: { url: string; text: string; truncated: boolean } | null;
  issuesUrl: string;
  pullsUrl: string;
  note: string;
};
