import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { IndexedRepo, RepoContent } from "../activity-index-types.ts";
import { ApiError } from "./logic.ts";

const exec = promisify(execFile);
const readmeLimit = 32_768;
const sha = /^[a-f0-9]{40,64}$/i;
type Entry = { name: string; type: string; oid: string; size: number };
const readmeName = /^readme(?:\.(?:md|markdown|rst|txt|adoc))?$/i;
const query = `query($owner:String!, $name:String!) {
  repository(owner:$owner,name:$name) {defaultBranchRef {target {... on Commit {oid tree {entries {name type oid}}}}}}
}`;
const git = async (dir: string, args: string[]) =>
  (await exec("git", ["-C", dir, ...args], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const gh = async (args: string[]) =>
  (await exec("gh", args, { timeout: 17000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const github = (r: IndexedRepo) =>
  /^[\w.-]+\/[\w.-]+$/.test(r.fullName) &&
  r.url.toLowerCase() === "https://github.com/" + r.fullName.toLowerCase();
const url = (r: IndexedRepo, ref: string, path: string, type: string) =>
  github(r)
    ? r.url +
      "/" +
      (type === "tree" ? "tree" : "blob") +
      "/" +
      ref +
      "/" +
      path.split("/").map(encodeURIComponent).join("/")
    : "";
const unavailable = () =>
  new ApiError(503, "repo_content_unavailable", "暂时无法读取这座仓库的内容，请检查本地检出或 GitHub 连接。");

function originName(raw: string): string | null {
  if (raw.startsWith("git@github.com:"))
    return raw
      .slice("git@github.com:".length)
      .replace(/\/$/, "")
      .replace(/\.git$/, "")
      .toLowerCase();
  try {
    const value = new URL(raw);
    return ["https:", "http:", "ssh:", "git:"].includes(value.protocol) && value.hostname === "github.com"
      ? value.pathname
          .replace(/^\/|\/$/g, "")
          .replace(/\.git$/, "")
          .toLowerCase()
      : null;
  } catch {
    return null;
  }
}

async function localTree(repo: IndexedRepo) {
  for (const dir of repo.paths) {
    try {
      // An indexed checkout may have moved or become an ordinary subdirectory since the last scan.
      const top = (await git(dir, ["rev-parse", "--show-toplevel"])).trimEnd();
      if ((await realpath(top)) !== (await realpath(dir))) continue;
      if (github(repo)) {
        const remote = (await git(dir, ["config", "--local", "--get", "remote.origin.url"])).trim();
        if (originName(remote) !== repo.fullName.toLowerCase()) continue;
      }
      const ref = (await git(dir, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
      if (!sha.test(ref)) continue;
      const tree = await git(dir, ["ls-tree", "-l", "-z", ref]);
      const entries: Entry[] = [];
      for (const item of tree.split("\0")) {
        const match = /^\d+ (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(item);
        if (match) entries.push({ name: match[4], type: match[1], oid: match[2], size: Number(match[3]) });
      }
      return { ref, entries, dir };
    } catch {
      /* A moved checkout may have another registered working tree. */
    }
  }
  return null;
}

export async function repoContent(repo: IndexedRepo): Promise<RepoContent> {
  let ref: string | null = null,
    entries: Entry[] = [],
    source = "GitHub 默认分支",
    note = "",
    dir = "";
  if (github(repo) && repo.visibility !== "unknown") {
    const [owner, name] = repo.fullName.split("/");
    try {
      const data = JSON.parse(
        await gh([
          "api",
          "--hostname",
          "github.com",
          "graphql",
          "-f",
          "query=" + query,
          "-f",
          "owner=" + owner,
          "-f",
          "name=" + name,
        ]),
      );
      if (data.errors || !data.data?.repository) throw unavailable();
      const head = data.data.repository.defaultBranchRef?.target;
      if (head && (!sha.test(head.oid) || !Array.isArray(head.tree?.entries))) throw unavailable();
      if (head) {
        ref = head.oid;
        entries = head.tree.entries;
      } else note = "仓库尚无默认分支提交。";
    } catch {
      note = "GitHub 内容暂不可用。";
    }
  }
  if (!ref && !note.includes("尚无")) {
    const local = await localTree(repo);
    if (!local) throw unavailable();
    ({ ref, entries, dir } = local);
    source = "本地已提交版本";
    note += "展示本地 HEAD。未推送文件在 GitHub 可能无法打开。";
  }
  let readme: RepoContent["readme"] = null;
  const entry = entries.find((e) => e.type === "blob" && readmeName.test(e.name));
  if (ref && entry && sha.test(entry.oid)) {
    try {
      let text: string;
      if (dir) {
        if (entry.size > 512 * 1024) throw Error();
        text = await git(dir, ["cat-file", "blob", entry.oid]);
      } else {
        const obj = JSON.parse(
          await gh(["api", "--hostname", "github.com", "repos/" + repo.fullName + "/git/blobs/" + entry.oid]),
        );
        if (obj.encoding !== "base64" || typeof obj.content !== "string") throw Error();
        text = Buffer.from(obj.content, "base64").toString("utf8");
      }
      readme = {
        url: url(repo, ref, entry.name, entry.type),
        text: text.slice(0, readmeLimit),
        truncated: text.length > readmeLimit,
      };
    } catch {
      note += " README 正文暂不可预览，可从文件清单打开。";
    }
  }
  return {
    fullName: repo.fullName,
    ref,
    source,
    readme,
    note,
    files: entries.map((e) => ({
      name: e.name,
      directory: e.type === "tree",
      url: ref ? url(repo, ref, e.name, e.type) : "",
    })),
    issuesUrl: github(repo) ? repo.url + "/issues" : "",
    pullsUrl: github(repo) ? repo.url + "/pulls" : "",
  };
}

export async function searchRepo(repo: IndexedRepo, term: string) {
  if (!term.trim() || term.length > 160 || /[\x00-\x1F]/.test(term))
    throw new ApiError(400, "repo_search", "请输入 1 到 160 个字符的搜索词。");
  const local = await localTree(repo);
  if (local) {
    let matches = "";
    try {
      matches = await git(local.dir, ["grep", "-I", "-l", "-z", "-i", "-F", "-e", term, local.ref, "--"]);
    } catch (e) {
      if ((e as { code?: number }).code !== 1) throw unavailable();
    }
    const paths = matches.split("\0").filter(Boolean);
    return {
      source: "本地已提交版本",
      note: "在本地 HEAD 的已跟踪文本中查找，最多显示 50 个文件。",
      items: paths.slice(0, 50).map((record) => {
        const path = record.slice(local.ref.length + 1);
        return { path, url: url(repo, local.ref, path, "blob") };
      }),
    };
  }
  if (!github(repo) || repo.visibility === "unknown") throw unavailable();
  try {
    const rows = JSON.parse(
      await gh([
        "search",
        "code",
        "--repo",
        repo.fullName,
        "--match",
        "file",
        "--limit",
        "50",
        "--json",
        "path,url,repository",
        "--",
        term,
      ]),
    );
    return {
      source: "GitHub 代码搜索",
      note: "搜索 GitHub 已索引的默认分支，最多显示 50 个文件。",
      items: rows
        .filter((row: { url: string }) => row.url?.toLowerCase().startsWith(repo.url.toLowerCase() + "/blob/"))
        .map((row: { path: string; url: string }) => ({ path: row.path, url: row.url })),
    };
  } catch {
    throw new ApiError(503, "repo_search", "GitHub 代码搜索暂不可用，请稍后重试。");
  }
}
