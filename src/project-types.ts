export type RepositoryItem = {
  kind: "issue" | "pull";
  number: number;
  title: string;
  url: string;
  updatedAt: string;
};

export type RepositorySnapshot = {
  fullName: string;
  url: string;
  visibility: "public";
  owner: string;
  fork: boolean;
  description?: string;
  openIssues: number;
  openPullRequests: number;
  latestRelease: { tag: string; url: string; publishedAt: string } | null;
  syncedAt: string;
  items: RepositoryItem[];
};

export type ZoomProject = { name: string; repositories: RepositorySnapshot[] };
export type ProjectIndex = { projects: ZoomProject[] };
