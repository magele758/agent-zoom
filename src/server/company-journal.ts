import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JournalExcerpt } from "../company-types.ts";
import { ApiError } from "./logic.ts";

const dayFile = /^\d{4}-\d{2}-\d{2}\.md$/;
export const journalRoot = () => process.env.OPC_DAILY_REVIEW_DIR || join(homedir(), "developer/self-learning-ground/daily-review-learning");

export async function listJournalDays(root: string) {
  try {
    const files = await readdir(root, { withFileTypes: true });
    return { available: true, days: files.filter(file => file.isFile() && dayFile.test(file.name)).map(file => file.name.slice(0, 10)).sort().reverse() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { available: false, days: [] };
    throw new ApiError(422, "journal_directory", "无法读取本机 daily-review-learning 目录。");
  }
}

function journalId(identity: string) {
  const hex = createHash("sha256").update(identity).digest("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), "8" + hex.slice(13, 16), "a" + hex.slice(17, 20), hex.slice(20, 32)].join("-");
}

export function journalExcerpts(filename: string, markdown: string): JournalExcerpt[] {
  const result: JournalExcerpt[] = [];
  const headings: string[] = [];
  const counts = new Map<string, number>();
  let fence = "";
  for (const [index, raw] of markdown.split(/\r?\n/).entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    if (marker && !fence) { fence = marker; continue; }
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && raw.trim() === marker) fence = "";
      continue;
    }
    const text = raw.trim();
    if (!text || /^(?:-{3,}|\*{3,}|_{3,})$/.test(text) || text.startsWith("<!--")) continue;
    const section = /^(#{1,6})\s+(.+?)\s*#*$/.exec(text);
    if (section) { headings.length = section[1].length - 1; headings.push(section[2]); }
    const path = headings.filter(Boolean).join(" › ");
    const original = section ? section[2] : text;
    const identity = JSON.stringify([filename, path, original]);
    const ordinal = (counts.get(identity) || 0) + 1;
    counts.set(identity, ordinal);
    const id = journalId(identity + "/" + ordinal);
    const title = original.replace(/^[-*+]\s+|(?:\*\*|__|`)/g,"").replace(/\[([^\]]+)\]\([^)]+\)/g,"$1").slice(0,160).trim() || original.slice(0,160);
    result.push({id, line:index + 1, title, body:original.slice(0,4800), reference:("daily-review-learning/" + filename + (path ? " › " + path : "")).slice(0,1450)});
  }
  return result;
}

export async function readJournalDay(root: string, day: string) {
  const name = day + ".md";
  if (!dayFile.test(name)) throw new ApiError(400, "journal_date", "请选择日期。");
  const file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(() => { throw new ApiError(404, "journal_day", "找不到这一天的日记原文件。"); });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new ApiError(422, "journal_size", "本次无法预览这份日记。");
    const buffer = Buffer.alloc(stat.size);
    let pos = 0;
    while (pos < buffer.length) {
      const {bytesRead} = await file.read(buffer, pos, buffer.length - pos, pos);
      if (!bytesRead) break;
      pos += bytesRead;
    }
    const markdown = buffer.subarray(0, pos).toString("utf8");
    const excerpts = journalExcerpts(name, markdown);
    const article = {
      id: journalId("daily-review-learning/article/" + day),
      title: day + " 日读",
      body: "",
      reference: "daily-review-learning/" + name,
    };
    return { day, markdown, excerpts, article };
  } finally { await file.close(); }
}
