import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const metadata = `query($owner:String!,$name:String!) {
  repository(owner:$owner,name:$name) { nameWithOwner owner { login } url visibility isFork description }
}`;
function activity(includeSignals) {
  return `query($owner:String!,$name:String!) {
  repository(owner:$owner,name:$name) {
    nameWithOwner owner { login } url visibility isFork description
    latestRelease { tagName url publishedAt ${includeSignals ? "description" : ""} }
    issues(first:10,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}) {
      totalCount nodes { number title url updatedAt ${includeSignals ? "labels(first:20) { nodes { name } }" : ""} }
    }
    pullRequests(first:10,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}) {
      totalCount nodes { number title url updatedAt }
    }
  }
}`;
}

async function githubRepository(query, owner, name) {
  let stdout;
  try {
    ({ stdout } = await execute("gh", ["api", "--hostname", "github.com", "graphql",
      "-f", "query=" + query, "-f", "owner=" + owner, "-f", "name=" + name], { timeout: 30000 }));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("同步 GitHub 仓库需要本机 gh 命令和可用的 GitHub 连接");
    throw new Error("读取 GitHub 仓库失败。" + (error.stderr?.trim() || "请检查 gh auth status 和网络连接"));
  }
  const data = JSON.parse(stdout);
  if (data.errors?.length) throw new Error("读取 GitHub 仓库失败。" + data.errors.map(error => error.message).join(" / "));
  return data.data?.repository;
}

function verifyRepository(repository, fullName, owner) {
  if (!repository || repository.visibility !== "PUBLIC") throw new Error("请选择可读取的公开 GitHub 仓库");
  if (repository.nameWithOwner?.toLowerCase() !== fullName.toLowerCase() ||
      repository.owner?.login?.toLowerCase() !== owner.toLowerCase() ||
      repository.url !== "https://github.com/" + repository.nameWithOwner || typeof repository.isFork !== "boolean") {
    throw new Error("GitHub 返回的仓库归属或地址与所选仓库不一致，请使用当前 owner/repo");
  }
}

export async function readGithubRepository(fullName, read = githubRepository, includeSignals = false) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(fullName) || [".", ".."].includes(fullName.split("/")[1])) {
    throw new Error("请明确指定 GitHub 的 owner/repo");
  }
  const [owner, name] = fullName.split("/");
  verifyRepository(await read(metadata, owner, name), fullName, owner);
  const repository = await read(activity(includeSignals), owner, name);
  verifyRepository(repository, fullName, owner);
  const recent = (connection, kind) => {
    if (!Number.isSafeInteger(connection?.totalCount) || !Array.isArray(connection.nodes) ||
        connection.totalCount < connection.nodes.length || connection.nodes.some(node => !node)) {
      throw new Error("GitHub 未返回完整的 " + kind + " 统计，本次同步没有保存");
    }
    return connection.nodes.map(node => ({
      kind, number: node.number, title: node.title, url: node.url, updatedAt: node.updatedAt,
      ...(includeSignals && kind === "issue" ? { labels: (node.labels?.nodes ?? []).map(label => label.name) } : {}),
    }));
  };
  const items = [...recent(repository.issues, "issue"), ...recent(repository.pullRequests, "pull")];
  const release = repository.latestRelease;
  return {
    fullName: repository.nameWithOwner, owner: repository.owner.login, url: repository.url, visibility: "public", fork: repository.isFork,
    ...(repository.description ? { description: repository.description } : {}),
    latestRelease: release ? {
      tag: release.tagName, url: release.url, publishedAt: release.publishedAt,
      ...(includeSignals ? { notes: release.description || "" } : {}),
    } : null,
    openIssues: repository.issues.totalCount, openPullRequests: repository.pullRequests.totalCount,
    syncedAt: new Date().toISOString(), items: items.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.number - left.number),
  };
}
