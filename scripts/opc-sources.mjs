#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readGithubRepository } from "./zoom-github.mjs";

export const sourcesHelp = `opc-os sources github [--repo <已登记的 owner/repo>] [--project <工作区绑定名>] [--upstream <参考的公开 owner/repo>] [--watch <秒>] [--dry-run]
opc-os sources daily <YYYY-MM-DD.md> --project <工作区绑定名> (--heading <准确小节标题> | --line <行号>) [--dry-run]
github 每次查看各仓库最近更新的十条未关闭 Issue 和最新 Release。指定 --upstream 时仅检查参考仓库的最新 Release。
未指定项目键时，提交到以目标仓库 owner/repo 命名的 OPC 项目。--watch 前台定期检查，Ctrl-C 结束。`;

function bounded(text, length) {
  return text.trim().slice(0, length).replace(/[\uD800-\uDBFF]$/, "");
}

function digest(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function projectKey(raw) {
  if (!raw?.trim() || raw.trim().length > 256) throw new Error("请提供 1 到 256 字符的 OPC 项目名称。");
  return raw.trim();
}

function publicRepo(raw) {
  if (!/^[\w-]+\/[\w.-]+$/.test(raw) || /^\.\.?$/.test(raw.split("/")[1])) throw new Error("仓库格式应为 owner/repo。");
  return raw.toLowerCase();
}

function cleanTitle(content) {
  return content.replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(?:\*\*|__|`)/g, "").trim();
}

function headingAt(line) {
  const match = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
  return match && { depth: match[1].length, text: match[2].replace(/\s+#+$/, "").trim() };
}

// Only the explicitly selected line/heading leaves the daily journal.
export function dailyOpportunity({ file, markdown, project, heading, line }) {
  const filename = basename(file);
  if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(filename)) throw new Error("请选择日记原文件 YYYY-MM-DD.md。");
  if (Boolean(heading) === Boolean(line)) throw new Error("请选择一个准确的小节 --heading，或一条 --line。");
  const lines = markdown.split(/\r?\n/);
  const lineNumber = line === undefined ? null : Number(line);
  if (lineNumber !== null && (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || lineNumber > lines.length)) {
    throw new Error("选中的日记行号超出范围。");
  }

  const matches = [];
  const parents = [];
  const occurrences = new Map();
  let fence = "";
  for (const [index, raw] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    if (marker && !fence) { fence = marker; continue; }
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && raw.trim() === marker) fence = "";
      continue;
    }
    const section = headingAt(raw);
    if (section) {
      parents.length = section.depth - 1;
      parents.push(section.text);
    }
    const quote = section?.text || raw.trim();
    const context = parents.filter(Boolean);
    const identity = JSON.stringify([filename, context, section ? null : quote]);
    const ordinal = (occurrences.get(identity) || 0) + 1;
    occurrences.set(identity, ordinal);
    if (heading ? section?.text !== heading.trim() : index + 1 !== lineNumber) continue;
    if (!quote) throw new Error("选中行是空行，请选一条有内容的工作线索。");
    matches.push({ quote, context, identity, ordinal, lineNumber: index + 1 });
  }
  if (matches.length !== 1) throw new Error(matches.length ? "小节标题重复，请用 --line 选定具体条目。" : "日记中没有找到指定条目。");
  const selected = matches[0];
  const { quote, context } = selected;
  const selection = cleanTitle(quote);
  if (!selection) throw new Error("请选有标题或摘录的日记条目。");
  const reference = "daily-review-learning/" + filename + "#L" + selected.lineNumber;
  const relative = [reference, ...context].join(" › ");
  // A journal can have later batches appended. An unchanged selection keeps its key when line numbers shift.
  const id = digest(selected.identity + "/" + selected.ordinal);
  const evidence = [relative.length > 350 ? reference : relative];
  let excerpt = quote;
  if (heading) {
    // The heading is explicitly selected; include at most its first text line, stopping before a different section.
    const nextText = lines.slice(selected.lineNumber).find(value => value.trim());
    if (nextText && !headingAt(nextText) && !/^\s*(?:`{3,}|~{3,}|<!--|\|)/.test(nextText)) {
      excerpt = nextText.trim();
    }
  }
  for (const match of excerpt.matchAll(/https?:\/\/[^\s<>)\]]+/g)) {
    if (match[0].length <= 360 && !evidence.includes(match[0])) evidence.push(match[0]);
    if (evidence.length >= 8) break;
  }
  return {
    project: projectKey(project), kind: "feature", sourceId: "daily/" + filename.slice(0, 10) + "/" + id,
    title: bounded(selection, 170), rationale: "根据选中的日记条目，先核实项目已有能力、适用范围和最小验证方式。摘录：" + bounded(cleanTitle(excerpt), 240),
    evidence, impact: 3, confidence: 2, effort: 3,
  };
}

export function githubOpportunities(snapshot, project, upstream = false) {
  const repo = publicRepo(snapshot.fullName);
  const key = projectKey(project);
  const result = [];
  if (!upstream) {
    for (const item of snapshot.items.filter(item => item.kind === "issue")) {
      const labels = item.labels || [];
      const high = /\b(?:regression|crash|data loss|p[01])\b|回归|崩溃|数据丢失/i.test([item.title, ...labels].join(" "));
      const enhancement = labels.some(label => /^(?:enhancement|feature(?: request)?|需求|特性)$/i.test(label));
      const reason = high ? "原 Issue 标题或标签含回归、崩溃或高优先级线索，请核实影响范围和复现条件。"
        : enhancement ? "仓库维护者已把此项标作特性需求。核对使用场景、已有实现与最小验收。"
        : "原仓库仍有此项未关闭反馈，请确认需求或复现条件，并检查是否已有相关实现。";
      result.push({
        project: key, kind: "issue", sourceId: "github/" + repo + "/issues/" + item.number,
        title: bounded(item.title, 170), evidence: [item.url],
        rationale: labels.length ? reason + " 原始标签：" + bounded(labels.join("、"), 220) : reason,
        impact: high ? 4 : 3, confidence: 3, effort: 3,
      });
    }
  }
  const release = snapshot.latestRelease;
  if (release) {
    const label = upstream ? "评估吸收" : "复查发布";
    const evidence = release.url.length <= 360 ? [release.url]
      : ["https://github.com/" + snapshot.fullName + "/releases", "Tag: " + bounded(release.tag, 340)];
    const notes = (release.notes || "").split(/\r?\n/).filter(line => /^\s*[-*+]\s+/.test(line)).slice(0, 3).map(cleanTitle);
    const excerpt = bounded(notes.length ? notes.join(" / ") : (release.notes || "").replace(/\s+/g, " "), 320);
    const rationale = upstream ? "比较参考仓库的变更说明与本项目能力，验证确有收益的适配，保留无需升级的结论。"
      : "核对此次已发布版本的兼容性、用户反馈和后续维护事项，再决定是否需要改动。";
    result.push({
      project: key, kind: "upgrade", sourceId: "github/" + repo + "/releases/" + digest(release.tag),
      title: bounded(label + " " + snapshot.fullName + " " + release.tag, 170), evidence,
      rationale: excerpt ? rationale + " 原发布说明摘录：" + excerpt : rationale,
      impact: 3, confidence: 2, effort: 3,
    });
  }
  return result;
}

async function collectGithub(flags, request, github) {
  const registry = await request("/api/zoom/projects");
  let repos = registry.projects.flatMap(product => product.repositories.map(repo => repo.fullName));
  if (flags.repo) {
    const target = publicRepo(flags.repo);
    repos = repos.filter(repo => publicRepo(repo) === target);
    if (!repos.length) throw new Error("未登记的目标仓库。先用 opc-os project sync <owner/repo> 登记。");
  }
  const items = [];
  const failures = [];
  for (const repo of [...new Set(repos)].sort()) {
    const source = flags.upstream || repo;
    try {
      const snapshot = await github(source);
      if (publicRepo(snapshot.fullName) !== publicRepo(source)) throw new Error("返回的仓库与指定来源不一致。");
      items.push(...githubOpportunities(snapshot, flags.project || repo, Boolean(flags.upstream)));
    } catch (error) {
      failures.push({ repo: source, message: error.message });
    }
  }
  return { items, failures };
}

export async function runSources(args, { request, github = repo => readGithubRepository(repo, undefined, true), log = console.log }) {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help") { log(sourcesHelp); return; }
  if (!["daily","github"].includes(command)) throw new Error(sourcesHelp);
  const string = { type: "string" };
  const { values: flags, positionals } = parseArgs({
    args: rest, allowPositionals: true, options: {
      project: string, "dry-run": { type: "boolean" },
      ...(command === "github" ? { repo: string, upstream: string, watch: string } : { heading: string, line: string }),
    },
  });
  if (positionals.length !== (command === "github" ? 0 : 1)) throw new Error(sourcesHelp);
  const interval = flags.watch === undefined ? null : Number(flags.watch);
  if (interval !== null && (!Number.isSafeInteger(interval) || interval < 1 || interval * 1000 > 2147483647)) {
    throw new Error("--watch 需要有效的正整数秒数。");
  }
  if (command === "github" && (flags.project || flags.upstream) && !flags.repo) throw new Error("--project 和 --upstream 需要 --repo 指定目标仓库。");
  if (flags.project) projectKey(flags.project);
  if (flags.repo) publicRepo(flags.repo);
  if (flags.upstream) publicRepo(flags.upstream);

  async function scan() {
    let items, failures = [];
    if (command === "daily") {
      const file = resolve(positionals[0]);
      items = [dailyOpportunity({ file, markdown: await readFile(file, "utf8"), ...flags })];
    } else {
      ({ items, failures } = await collectGithub(flags, request, github));
    }
    if (flags["dry-run"]) return { preview: true, opportunities: items, failures };
    let submitted = 0;
    for (let offset = 0; offset < items.length; offset += 200) {
      const batch = items.slice(offset, offset + 200);
      await request("/api/opc/opportunities/import", { items: batch });
      submitted += batch.length;
    }
    return { candidatesRead: items.length, candidatesSubmitted: submitted, failures, projects: [...new Set(items.map(item => item.project))] };
  }
  if (interval === null) {
    const result = await scan();
    if (result.failures.length) {
      log(JSON.stringify(result, null, 2));
      throw new Error("部分 GitHub 来源读取失败。已完成的来源可安全重复检查。");
    }
    return result;
  }
  for (;;) {
    try { log(JSON.stringify({ at: new Date().toISOString(), ...await scan() })); }
    catch (error) { log(JSON.stringify({ at: new Date().toISOString(), error: error.message })); }
    await delay(interval * 1000);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const cli = fileURLToPath(new URL("./zoom.mjs", import.meta.url));
  const child = spawn(process.execPath, [cli, "sources", ...process.argv.slice(2)], { stdio: "inherit" });
  process.once("SIGINT", () => child.kill("SIGINT"));
  process.once("SIGTERM", () => child.kill("SIGTERM"));
  child.once("error", error => { console.error(error.message); process.exitCode = 1; });
  child.once("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143); });
}
