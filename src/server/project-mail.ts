import type { DatabaseSync } from "node:sqlite";
import type { RepositorySnapshot } from "../project-types.ts";
import type { ZoomMessage } from "../zoom-types.ts";

export function initProjectMail(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS zoom_project_mail (
    seq INTEGER PRIMARY KEY,
    project TEXT NOT NULL,
    snapshot TEXT NOT NULL
  )`);
}

// The caller writes this alongside a changed repository snapshot inside its transaction.
export function recordProjectMail(db: DatabaseSync, project: string, repository: RepositorySnapshot) {
  db.prepare("INSERT INTO zoom_project_mail (project,snapshot) VALUES (?,?)").run(project, JSON.stringify(repository));
}

export function projectMessages(db: DatabaseSync): ZoomMessage[] {
  return db.prepare("SELECT seq,project,snapshot FROM zoom_project_mail").all().map(row => {
    const repo = JSON.parse(String(row.snapshot)) as RepositorySnapshot;
    return {
      id: "github-sync-" + row.seq,
      taskId: repo.fullName.toLowerCase(),
      origin: "repository",
      kind: "progress",
      source: "GitHub",
      taskTitle: repo.fullName.split("/")[1] + " · 仓库维护",
      folder: String(row.project) + "/仓库维护",
      stage: "operations",
      at: repo.syncedAt,
      body: `未关闭的 Issue 有 ${repo.openIssues} 个，PR 有 ${repo.openPullRequests} 个。` +
        (repo.latestRelease ? `最近发布 ${repo.latestRelease.tag}。` : "当前没有 Release。"),
      pending: false,
      repository: repo,
    };
  });
}
