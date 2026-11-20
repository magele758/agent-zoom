import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { LearnClipReceipt, LearnConnection, LearnDocument } from "../learn-agent-types.ts";
import { journalRoot, readJournalDay } from "./company-journal.ts";
import { ApiError } from "./logic.ts";

const base = "/api/zoom/company/learn";
const sourcePath = "/ideas-source";
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sourceFields = z.strictObject({ day: date, articleId: z.uuid() });
const clipInput = sourceFields.extend({ question: z.string().trim().max(4000).optional() });
const slug = z.string().regex(/^[\w-]{1,128}$/);
const title = z.string().trim().min(1).max(2048);
const clipId = z.string().regex(/^clip-[a-f0-9]{24}$/);
const clipsSchema = z.object({ clips: z.array(z.object({ id: clipId, title })) });
const docsSchema = z.object({
  documents: z.array(z.object({ id: slug, title, kind: z.enum(["web", "pdf"]).default("pdf") })),
});
const sessionsSchema = z.array(z.object({ id: slug, title, updatedAt: z.string(), completed: z.boolean() }));
const pairing = z.object({ endpoint: z.string(), token: z.string().regex(/^[\x21-\x7e]{32,256}$/) });

function loopback(url: URL) {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}
function pairedEndpoint(value: string) {
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.search || url.hash || url.pathname !== "/api/learn/clips")
    return;
  const tailnet = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && (loopback(url) || tailnet))) return url;
}
async function readPairing(file: string) {
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  if (!fd) return null;
  try {
    const stat = await fd.stat();
    if (
      !stat.isFile() ||
      stat.size > 8192 ||
      (process.getuid && (stat.mode & 0o077 || stat.uid !== process.getuid()))
    ) {
      throw Error("invalid pairing file");
    }
    const endpoint = pairedEndpoint(pairing.parse(JSON.parse(await fd.readFile("utf8"))).endpoint);
    if (!endpoint) throw Error("invalid destination");
    return endpoint;
  } finally {
    await fd.close();
  }
}

function readPage(value: unknown, origin: string, tab: string) {
  if (typeof value !== "string") return;
  const url = URL.parse(value, origin);
  if (
    url?.origin === origin &&
    url.pathname === "/learn" &&
    !url.username &&
    !url.password &&
    url.searchParams.get("tab") === tab
  )
    return url;
}

type WriteClip = (
  clip: { url: string; title: string; content: string; note: string },
  options: {
    configPath: string;
    request: typeof fetch;
  },
) => Promise<{ ok: boolean; error?: string; readerUrl?: string; reviewUrl?: string; duplicate?: boolean }>;
type Options = { configPath?: string; writerPath?: string; localOrigin?: string; fetch?: typeof fetch };
function learnPaths(options: Options) {
  return {
    configPath:
      options.configPath ??
      process.env.OPC_LEARN_CLIP_CONFIG ??
      join(homedir(), ".pagelens", "learn-agent-clip.json"),
    writerPath:
      options.writerPath ??
      process.env.OPC_PAGELENS_CLIP_HELPER ??
      join(homedir(), "developer/self-test-grounding/chrome-plugin-gemini/native/learn-clip.mjs"),
    localOrigin: options.localOrigin ?? process.env.OPC_LEARN_LOCAL_ORIGIN ?? "http://127.0.0.1:4317",
  };
}

function documentUrl(origin: string, doc: { id: string; kind: "web" | "pdf" | "clip" }) {
  return doc.kind === "clip"
    ? origin + "/learn?" + new URLSearchParams({ tab: "library", clip: doc.id })
    : origin + "/?" + new URLSearchParams({ doc: doc.id });
}
function studyUrl(origin: string, id: string) {
  return origin + "/learn?" + new URLSearchParams({ session: id });
}

async function material(day: string, articleId: string) {
  const { markdown, article, excerpts } = await readJournalDay(journalRoot(), day);
  if (article.id === articleId) return { title: article.title, content: markdown };
  const entry = excerpts.find((item) => item.id === articleId);
  if (!entry) throw new ApiError(404, "learn_source", "原文已更新，请重新选择要学习的文章或段落。");
  const lines = markdown.split(/\r?\n/);
  const start = entry.line - 1;
  const depth = /^\s*(#{1,6})\s/.exec(lines[start])?.[1].length;
  if (!depth) return { title: entry.title, content: lines[start] };
  const next = excerpts.find((item) => {
    if (item.line <= entry.line) return false;
    const section = /^\s*(#{1,6})\s/.exec(lines[item.line - 1])?.[1].length;
    return section !== undefined && section <= depth;
  });
  return { title: entry.title, content: lines.slice(start, next ? next.line - 1 : undefined).join("\n") };
}

export function addCompanyLearnRoutes(app: Hono, user: (c: Context) => unknown, options: Options = {}) {
  const paths = learnPaths(options);
  const request = options.fetch ?? fetch;
  async function writer(): Promise<WriteClip | null> {
    const module: { writeLearningClip?: WriteClip } = await import(pathToFileURL(resolve(paths.writerPath)).href);
    return typeof module.writeLearningClip === "function" ? module.writeLearningClip : null;
  }
  async function read<T>(origin: string, path: string, schema: z.ZodType<T>) {
    const res = await request(origin + path, {
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3500),
    });
    if (!res.ok) throw Error("Learn Agent " + res.status);
    return schema.parse(await res.json());
  }
  const empty = { available: false, canClip: false, documents: [], sessions: [] };
  app.get(base, async (c) => {
    user(c);
    c.header("Cache-Control", "no-store");
    if (process.env.KUNLUN_PREVIEW === "1") return c.json({ ...empty, reason: "预览可阅读日记。" });
    let endpoint: URL | null;
    try {
      endpoint = await readPairing(paths.configPath);
    } catch {
      return c.json({ ...empty, reason: "Learn Agent 的 PageLens 配对不可读，请检查现有连接。" });
    }
    const local = URL.parse(paths.localOrigin);
    const origin =
      endpoint?.origin ??
      (local && loopback(local) && ["http:", "https:"].includes(local.protocol) ? local.origin : "");
    if (!origin) return c.json({ ...empty, reason: "没有有效的 Learn Agent 地址。" });
    const [docs, clips, study, writeClip] = await Promise.allSettled([
      read(origin, "/api/learn/library", docsSchema),
      read(origin, "/api/learn/clips", clipsSchema),
      read(origin, "/api/learn/sessions", sessionsSchema),
      endpoint ? writer() : Promise.resolve(null),
    ]);
    const available = [docs, clips, study].some((result) => result.status === "fulfilled");
    const canClip = available && writeClip.status === "fulfilled" && Boolean(writeClip.value);
    const documents: LearnDocument[] = [
      ...(clips.status === "fulfilled"
        ? clips.value.clips.map((item) => ({ ...item, kind: "clip" as const }))
        : []),
      ...(docs.status === "fulfilled" ? docs.value.documents : []),
    ]
      .slice(0, 40)
      .map((doc) => ({ ...doc, url: documentUrl(origin, doc) }));
    const data: LearnConnection = {
      available,
      canClip,
      ...(available && { homeUrl: origin + "/learn" }),
      documents,
      sessions:
        study.status === "fulfilled"
          ? study.value.slice(0, 30).map((s) => ({ ...s, url: studyUrl(origin, s.id) }))
          : [],
      ...(!available
        ? { reason: "暂时无法连接 Learn Agent。可以继续阅读日记与派研发任务。" }
        : !canClip
          ? { reason: "可以打开学习资料。发送文章需要现有 PageLens 的 Learn Agent 剪藏连接。" }
          : {}),
    };
    return c.json(data);
  });
  app.post(base + "/clip", async (c) => {
    user(c);
    c.header("Cache-Control", "no-store");
    if (process.env.KUNLUN_PREVIEW === "1") throw new ApiError(503, "learn_pairing", "请从正式本机服务发送文章。");
    const inbound = new URL(process.env.KUNLUN_URL || c.req.url);
    if (!loopback(inbound) || !["http:", "https:"].includes(inbound.protocol))
      throw new ApiError(400, "learn_source", "请从本机 OPC OS 打开待发送原文。");
    const caller = c.req.header("origin");
    if (caller && caller !== new URL(c.req.url).origin)
      throw new ApiError(403, "learn_source", "请在当前 OPC OS 页面发送文章。");
    const input = clipInput.safeParse(await c.req.json());
    if (!input.success)
      throw new ApiError(400, "learn_source", "请选择要学习的原文，想验证的问题请控制在 4000 字以内。");
    const endpoint = await readPairing(paths.configPath).catch(() => null);
    const send = endpoint && (await writer().catch(() => null));
    if (!endpoint || !send) throw new ApiError(503, "learn_pairing", "还未连接 Learn Agent 的原生剪藏入口。");
    const { day, articleId, question } = input.data;
    const selected = await material(day, articleId);
    if (!selected.content.trim() || Buffer.byteLength(selected.content) > 256 * 1024)
      throw new ApiError(
        422,
        "learn_source_size",
        "该原文为空或超过 Learn Agent 单次可接收的大小，请选择一个小节。",
      );
    const source = new URL(sourcePath, inbound.origin);
    source.search = new URLSearchParams({ day, articleId }).toString();
    const result = await send(
      { url: source.href, title: selected.title, content: selected.content, note: question ?? "" },
      {
        configPath: paths.configPath,
        request: ((url, settings) => {
          // The reused helper re-reads the pairing before POST. Keep this operation bound to the destination checked above.
          if (String(url) !== endpoint.href) throw Error("Learn Agent pairing changed");
          return request(url, settings);
        }) as typeof fetch,
      },
    );
    if (!result.ok)
      throw new ApiError(
        502,
        "learn_clip",
        result.error || "暂未收到 Learn Agent 的保存回执。可以重试同一篇文章。",
      );
    const reader = readPage(result.readerUrl, endpoint.origin, "library");
    const id = clipId.safeParse(reader?.searchParams.get("clip"));
    if (!reader || !id.success) throw new ApiError(502, "learn_receipt", "Learn Agent 未返回可用的剪藏阅读地址。");
    const review = readPage(result.reviewUrl, endpoint.origin, "knowledge");
    const receipt: LearnClipReceipt = {
      id: id.data,
      url: reader.href,
      duplicate: result.duplicate === true,
      ...(review?.searchParams.get("clip") === id.data && { reviewUrl: review.href }),
    };
    return c.json(receipt);
  });
  app.get(sourcePath, (c) => {
    const input = sourceFields.safeParse(c.req.query());
    if (!input.success) throw new ApiError(400, "learn_source", "找不到该日记链接。");
    const { day, articleId } = input.data;
    return c.redirect("/#ideas?" + new URLSearchParams({ day, section: articleId }), 303);
  });
}
