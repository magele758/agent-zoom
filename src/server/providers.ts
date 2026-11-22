import type { DatabaseSync } from "node:sqlite";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type {
  ProviderHealthEntry,
  ProvidersConfig,
  ProvidersHealthReport,
  SemanticVectorResult,
} from "../providers-types.ts";
import { ApiError } from "./logic.ts";
import { submitAuth } from "./workflow/http.ts";

export const SECRET_MASK = "********";
export const LOCAL_VECTOR_DIMENSIONS = 256;

export const DEFAULT_PROTECTED_PATHS = [
  "src/kernel/",
  "src/domains/factory/",
  "src/domains/strategy/",
  "src/server/workflow/",
  "src/server/dark-factory.ts",
  "src/server/providers.ts",
  "src/server/security-department.ts",
  "package.json",
];

export const DEFAULT_DISTRIBUTION_CHANNELS = [
  "wechat",
  "juejin",
  "x",
  "reddit",
  "newsletter",
  "telegram",
];

const patchSchema = z.object({
  system: z
    .object({
      maxConcurrentAgents: z.number().int().min(1).max(16).optional(),
      agentLogDir: z.string().trim().min(1).max(300).optional(),
      protectedPaths: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
      patrolStaleDays: z.number().int().min(1).max(90).optional(),
      lossKillSwitchMonths: z.number().int().min(1).max(12).optional(),
      pmAutoCreateThreshold: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
  models: z
    .object({
      llm: z
        .object({
          baseUrl: z.string().trim().max(500).optional(),
          apiKey: z.string().trim().max(500).optional(),
          modelName: z.string().trim().max(200).optional(),
          maxTokens: z.number().int().min(128).max(32768).optional(),
        })
        .optional(),
      embedding: z
        .object({
          baseUrl: z.string().trim().max(500).optional(),
          apiKey: z.string().trim().max(500).optional(),
          modelName: z.string().trim().max(200).optional(),
          dimensions: z.number().int().min(64).max(4096).optional(),
        })
        .optional(),
    })
    .optional(),
  services: z
    .object({
      ocr: z
        .object({
          enabled: z.boolean().optional(),
          endpoint: z.string().trim().max(500).optional(),
        })
        .optional(),
      workflow: z
        .object({
          enabled: z.boolean().optional(),
          endpoint: z.string().trim().max(500).optional(),
          apiKey: z.string().trim().max(500).optional(),
        })
        .optional(),
      payment: z
        .object({
          domestic: z
            .object({
              enabled: z.boolean().optional(),
              type: z.literal("hupijiao").optional(),
              endpoint: z.string().trim().max(500).optional(),
              appId: z.string().trim().max(200).optional(),
              appSecret: z.string().trim().max(500).optional(),
              notifyUrl: z.string().trim().max(500).optional(),
              returnUrl: z.string().trim().max(500).optional(),
            })
            .optional(),
          global: z
            .object({
              enabled: z.boolean().optional(),
              type: z.enum(["lemonsqueezy", "stripe"]).optional(),
              endpoint: z.string().trim().max(500).optional(),
              apiKey: z.string().trim().max(500).optional(),
              webhookSecret: z.string().trim().max(500).optional(),
              returnUrl: z.string().trim().max(500).optional(),
            })
            .optional(),
        })
        .optional(),
      distribution: z
        .object({
          enabled: z.boolean().optional(),
          endpoint: z.string().trim().max(500).optional(),
          apiKey: z.string().trim().max(500).optional(),
          channels: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
        })
        .optional(),
    })
    .optional(),
});

export function defaultProvidersConfig(): ProvidersConfig {
  return {
    system: {
      maxConcurrentAgents: Math.max(1, Number(process.env.OPC_MAX_CONCURRENT_AGENTS ?? 3) || 3),
      agentLogDir: process.env.OPC_AGENT_LOG_DIR || "data/agent-logs",
      protectedPaths: [...DEFAULT_PROTECTED_PATHS],
      patrolStaleDays: Math.max(1, Number(process.env.OPC_PATROL_STALE_DAYS ?? 7) || 7),
      lossKillSwitchMonths: 3,
      pmAutoCreateThreshold: 85,
    },
    models: {
      llm: {
        baseUrl: process.env.OPC_LLM_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1",
        apiKey: process.env.OPC_LLM_API_KEY || process.env.LLM_API_KEY || "",
        modelName: process.env.OPC_LLM_MODEL || "deepseek-chat",
        maxTokens: 2048,
      },
      embedding: {
        baseUrl: process.env.OPC_EMBEDDING_BASE_URL || "https://api.openai.com/v1",
        apiKey: process.env.OPC_EMBEDDING_API_KEY || process.env.EMBEDDING_API_KEY || "",
        modelName: process.env.OPC_EMBEDDING_MODEL || "text-embedding-3-small",
        dimensions: LOCAL_VECTOR_DIMENSIONS,
      },
    },
    services: {
      ocr: {
        enabled: Boolean(process.env.OPC_OCR_ENDPOINT),
        endpoint: process.env.OPC_OCR_ENDPOINT || "",
      },
      workflow: {
        enabled: Boolean(process.env.OPC_WORKFLOW_ENDPOINT),
        endpoint: process.env.OPC_WORKFLOW_ENDPOINT || "",
        apiKey: process.env.OPC_WORKFLOW_API_KEY || "",
      },
      payment: {
        domestic: {
          enabled: Boolean(process.env.HUPI_APP_ID && process.env.HUPI_APP_SECRET),
          type: "hupijiao",
          endpoint: process.env.HUPI_ENDPOINT || "https://api.xunhupay.com",
          appId: process.env.HUPI_APP_ID || "",
          appSecret: process.env.HUPI_APP_SECRET || "",
          notifyUrl: process.env.HUPI_NOTIFY_URL || "",
          returnUrl: process.env.HUPI_RETURN_URL || "",
        },
        global: {
          enabled: Boolean(process.env.LEMON_API_KEY || process.env.STRIPE_SECRET_KEY),
          type: process.env.STRIPE_SECRET_KEY ? "stripe" : "lemonsqueezy",
          endpoint: process.env.STRIPE_SECRET_KEY ? "https://api.stripe.com/v1" : "https://api.lemonsqueezy.com/v1",
          apiKey: process.env.STRIPE_SECRET_KEY || process.env.LEMON_API_KEY || "",
          webhookSecret: process.env.LEMON_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET || "",
          returnUrl: process.env.OPC_PAYMENT_RETURN_URL || "",
        },
      },
      distribution: {
        enabled: Boolean(process.env.OPC_DISTRIBUTION_ENDPOINT || process.env.OPC_WORKFLOW_ENDPOINT),
        endpoint: process.env.OPC_DISTRIBUTION_ENDPOINT || process.env.OPC_WORKFLOW_ENDPOINT || "",
        apiKey: process.env.OPC_DISTRIBUTION_API_KEY || process.env.OPC_WORKFLOW_API_KEY || "",
        channels: [...DEFAULT_DISTRIBUTION_CHANNELS],
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

function mergeSecret(incoming: string | undefined, current: string): string {
  if (incoming === undefined || incoming === SECRET_MASK) return current;
  return incoming;
}

export function redactProvidersConfig(config: ProvidersConfig): ProvidersConfig {
  const mask = (v: string) => (v ? SECRET_MASK : "");
  return {
    ...config,
    models: {
      llm: { ...config.models.llm, apiKey: mask(config.models.llm.apiKey) },
      embedding: { ...config.models.embedding, apiKey: mask(config.models.embedding.apiKey) },
    },
    services: {
      ocr: { ...config.services.ocr },
      workflow: { ...config.services.workflow, apiKey: mask(config.services.workflow.apiKey) },
      payment: {
        domestic: { ...config.services.payment.domestic, appSecret: mask(config.services.payment.domestic.appSecret) },
        global: {
          ...config.services.payment.global,
          apiKey: mask(config.services.payment.global.apiKey),
          webhookSecret: mask(config.services.payment.global.webhookSecret),
        },
      },
      distribution: { ...config.services.distribution, apiKey: mask(config.services.distribution.apiKey) },
    },
  };
}

// ---- Deterministic Local Semantic Embedding Engine (CJK + Latin + Code) ----

function fnv1a32(str: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function extractSemanticFeatures(text: string): Array<{ token: string; weight: number }> {
  const normalized = text.toLowerCase().replace(/[\r\n\t]+/g, " ").trim();
  if (!normalized) return [];

  const features: Array<{ token: string; weight: number }> = [];

  // 1. Latin/numeric words and bigrams
  const words = normalized.match(/[a-z0-9][a-z0-9_-]{1,31}/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    features.push({ token: "w:" + w, weight: 2.2 });
    if (w.length >= 4) {
      for (let j = 0; j <= w.length - 3; j++) {
        features.push({ token: "g3:" + w.slice(j, j + 3), weight: 0.45 });
      }
    }
    if (i + 1 < words.length) {
      features.push({ token: "wb:" + w + "_" + words[i + 1], weight: 1.6 });
    }
  }

  // 2. CJK sequences: unigrams (lower weight), bigrams (high weight), trigrams (highest weight)
  const cjkRuns = normalized.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length; i++) {
      features.push({ token: "c1:" + run[i], weight: 0.85 });
      if (i + 1 < run.length) {
        features.push({ token: "c2:" + run.slice(i, i + 2), weight: 2.5 });
      }
      if (i + 2 < run.length) {
        features.push({ token: "c3:" + run.slice(i, i + 3), weight: 2.0 });
      }
    }
  }

  return features;
}

export function localSemanticVector(text: string, dimensions = LOCAL_VECTOR_DIMENSIONS): number[] {
  const dim = Math.max(32, Math.min(4096, Math.floor(dimensions)));
  const vec = new Float64Array(dim);
  const features = extractSemanticFeatures(text);
  if (features.length === 0) return Array.from(vec);

  // Sublinear term frequency weighting
  const counts = new Map<string, { count: number; weight: number }>();
  for (const f of features) {
    const cur = counts.get(f.token);
    if (cur) cur.count += 1;
    else counts.set(f.token, { count: 1, weight: f.weight });
  }

  for (const [token, { count, weight }] of counts) {
    const tf = (1 + Math.log(count)) * weight;
    const h1 = fnv1a32(token, 2166136261);
    const h2 = fnv1a32(token, 0x9e3779b1);
    const idx1 = h1 % dim;
    const sign1 = (h1 & 1) === 0 ? 1 : -1;
    vec[idx1] += sign1 * tf;
    const idx2 = h2 % dim;
    const sign2 = (h2 & 1) === 0 ? 1 : -1;
    vec[idx2] += sign2 * tf * 0.5;
  }

  let normSq = 0;
  for (let i = 0; i < dim; i++) normSq += vec[i] * vec[i];
  const norm = Math.sqrt(normSq);
  if (norm === 0) return Array.from(vec);

  const result = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    result[i] = Math.round((vec[i] / norm) * 1e6) / 1e6;
  }
  return result;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return Math.max(-1, Math.min(1, dot / denom));
}

export async function computeSemanticVector(
  text: string,
  config?: ProvidersConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<SemanticVectorResult> {
  const trimmed = text.trim();
  const emb = config?.models.embedding;
  if (trimmed && emb?.baseUrl && emb?.apiKey && emb.apiKey !== SECRET_MASK) {
    try {
      const url = emb.baseUrl.replace(/\/+$/, "") + "/embeddings";
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${emb.apiKey}`,
        },
        body: JSON.stringify({
          model: emb.modelName || "text-embedding-3-small",
          input: trimmed.slice(0, 8192),
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
        const embedding = data.data?.[0]?.embedding;
        if (Array.isArray(embedding) && embedding.length >= 32) {
          return { vector: embedding, source: "remote", dimensions: embedding.length };
        }
      }
    } catch {
      // Fall through cleanly to local semantic engine.
    }
  }
  const vector = localSemanticVector(trimmed, LOCAL_VECTOR_DIMENSIONS);
  return { vector, source: "local", dimensions: vector.length };
}

export async function callConfiguredLLM(
  prompt: string,
  options: {
    system?: string;
    maxTokens?: number;
    config?: ProvidersConfig;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ ok: true; text: string; model: string; tokensUsed?: number } | { ok: false; reason: string }> {
  const llm = options.config?.models.llm;
  if (!llm?.baseUrl || !llm?.apiKey || llm.apiKey === SECRET_MASK) {
    return { ok: false, reason: "LLM API Key 未配置，使用内置结构化引擎" };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const url = llm.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const messages: Array<{ role: string; content: string }> = [];
    if (options.system) messages.push({ role: "system", content: options.system });
    messages.push({ role: "user", content: prompt });

    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.modelName || "deepseek-chat",
        messages,
        max_tokens: options.maxTokens ?? llm.maxTokens ?? 2048,
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      return { ok: false, reason: `LLM HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
      usage?: { total_tokens?: number };
    };
    const msg = body.choices?.[0]?.message;
    const text = (msg?.content ?? msg?.reasoning_content ?? "").trim();
    if (!text) return { ok: false, reason: "LLM 返回为空" };
    return {
      ok: true,
      text,
      model: llm.modelName || "deepseek-chat",
      tokensUsed: body.usage?.total_tokens,
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export class ProvidersStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS opc_providers_config (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      config TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  }

  get(): ProvidersConfig {
    const defaults = defaultProvidersConfig();
    const row = this.db.prepare("SELECT config, updated_at FROM opc_providers_config WHERE singleton=1").get() as
      | { config?: string; updated_at?: string }
      | undefined;
    if (!row?.config) return defaults;
    try {
      const saved = JSON.parse(row.config) as Partial<ProvidersConfig>;
      return {
        system: {
          ...defaults.system,
          ...(saved.system ?? {}),
          protectedPaths: Array.isArray(saved.system?.protectedPaths)
            ? saved.system.protectedPaths
            : defaults.system.protectedPaths,
        },
        models: {
          llm: { ...defaults.models.llm, ...(saved.models?.llm ?? {}) },
          embedding: { ...defaults.models.embedding, ...(saved.models?.embedding ?? {}) },
        },
        services: {
          ocr: { ...defaults.services.ocr, ...(saved.services?.ocr ?? {}) },
          workflow: { ...defaults.services.workflow, ...(saved.services?.workflow ?? {}) },
          payment: {
            domestic: { ...defaults.services.payment.domestic, ...(saved.services?.payment?.domestic ?? {}) },
            global: { ...defaults.services.payment.global, ...(saved.services?.payment?.global ?? {}) },
          },
          distribution: {
            ...defaults.services.distribution,
            ...(saved.services?.distribution ?? {}),
            channels: Array.isArray(saved.services?.distribution?.channels)
              ? saved.services.distribution.channels
              : defaults.services.distribution.channels,
          },
        },
        updatedAt: row.updated_at || defaults.updatedAt,
      };
    } catch {
      return defaults;
    }
  }

  getRedacted(): ProvidersConfig {
    return redactProvidersConfig(this.get());
  }

  update(raw: unknown): ProvidersConfig {
    const parsed = patchSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        400,
        "providers_input",
        parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" / "),
      );
    }
    const patch = parsed.data;
    const cur = this.get();
    const next: ProvidersConfig = {
      system: {
        ...cur.system,
        ...(patch.system ?? {}),
      },
      models: {
        llm: {
          ...cur.models.llm,
          ...(patch.models?.llm ?? {}),
          apiKey: mergeSecret(patch.models?.llm?.apiKey, cur.models.llm.apiKey),
        },
        embedding: {
          ...cur.models.embedding,
          ...(patch.models?.embedding ?? {}),
          apiKey: mergeSecret(patch.models?.embedding?.apiKey, cur.models.embedding.apiKey),
        },
      },
      services: {
        ocr: { ...cur.services.ocr, ...(patch.services?.ocr ?? {}) },
        workflow: {
          ...cur.services.workflow,
          ...(patch.services?.workflow ?? {}),
          apiKey: mergeSecret(patch.services?.workflow?.apiKey, cur.services.workflow.apiKey),
        },
        payment: {
          domestic: {
            ...cur.services.payment.domestic,
            ...(patch.services?.payment?.domestic ?? {}),
            appSecret: mergeSecret(
              patch.services?.payment?.domestic?.appSecret,
              cur.services.payment.domestic.appSecret,
            ),
          },
          global: {
            ...cur.services.payment.global,
            ...(patch.services?.payment?.global ?? {}),
            apiKey: mergeSecret(patch.services?.payment?.global?.apiKey, cur.services.payment.global.apiKey),
            webhookSecret: mergeSecret(
              patch.services?.payment?.global?.webhookSecret,
              cur.services.payment.global.webhookSecret,
            ),
          },
        },
        distribution: {
          ...cur.services.distribution,
          ...(patch.services?.distribution ?? {}),
          apiKey: mergeSecret(patch.services?.distribution?.apiKey, cur.services.distribution.apiKey),
        },
      },
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO opc_providers_config(singleton, config, updated_at) VALUES(1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET config=excluded.config, updated_at=excluded.updated_at`,
      )
      .run(JSON.stringify(next), next.updatedAt);
    return redactProvidersConfig(next);
  }

  async checkHealth(fetchImpl: typeof fetch = fetch): Promise<ProvidersHealthReport> {
    const cfg = this.get();
    const entries: ProviderHealthEntry[] = [];

    // 1. Database check
    const dbStart = Date.now();
    try {
      this.db.prepare("SELECT 1 AS ok").get();
      entries.push({
        id: "sqlite",
        name: "本地 SQLite 底座",
        category: "system",
        status: "ok",
        detail: `并发上限 ${cfg.system.maxConcurrentAgents} Agent · 独占保护路径 ${cfg.system.protectedPaths.length} 条`,
        latencyMs: Date.now() - dbStart,
      });
    } catch (err) {
      entries.push({
        id: "sqlite",
        name: "本地 SQLite 底座",
        category: "system",
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - dbStart,
      });
    }

    // 2. LLM check
    if (cfg.models.llm.baseUrl && cfg.models.llm.apiKey) {
      const t0 = Date.now();
      try {
        const res = await fetchImpl(cfg.models.llm.baseUrl.replace(/\/+$/, "") + "/models", {
          headers: { authorization: `Bearer ${cfg.models.llm.apiKey}` },
          signal: AbortSignal.timeout(4000),
        });
        entries.push({
          id: "llm",
          name: `LLM (${cfg.models.llm.modelName})`,
          category: "model",
          status: res.ok ? "ok" : "error",
          detail: res.ok ? `${cfg.models.llm.baseUrl} 连通` : `HTTP ${res.status}`,
          latencyMs: Date.now() - t0,
        });
      } catch (err) {
        entries.push({
          id: "llm",
          name: `LLM (${cfg.models.llm.modelName})`,
          category: "model",
          status: "fallback",
          detail: `远端不可达（${err instanceof Error ? err.message : "timeout"}），将自动回退内置引擎`,
          latencyMs: Date.now() - t0,
        });
      }
    } else {
      entries.push({
        id: "llm",
        name: `LLM (${cfg.models.llm.modelName})`,
        category: "model",
        status: "fallback",
        detail: "未配置 API Key，使用内置结构化分析/提炼引擎（配置后自动切换大模型）",
        latencyMs: null,
      });
    }

    // 3. Embedding check
    if (cfg.models.embedding.baseUrl && cfg.models.embedding.apiKey) {
      entries.push({
        id: "embedding",
        name: `Embedding (${cfg.models.embedding.modelName})`,
        category: "model",
        status: "ok",
        detail: `远端向量已配置（dim=${cfg.models.embedding.dimensions}），离线自动回退本地向量`,
        latencyMs: null,
      });
    } else {
      entries.push({
        id: "embedding",
        name: "语义向量引擎",
        category: "model",
        status: "fallback",
        detail: `内置本地中英文语义向量引擎就绪（dim=${LOCAL_VECTOR_DIMENSIONS}，无需外部 Key）`,
        latencyMs: null,
      });
    }

    // 4. OCR check
    if (cfg.services.ocr.enabled && cfg.services.ocr.endpoint) {
      const t0 = Date.now();
      try {
        const res = await fetchImpl(cfg.services.ocr.endpoint, {
          method: "HEAD",
          signal: AbortSignal.timeout(3000),
        });
        entries.push({
          id: "ocr",
          name: "OCR 手写识别服务",
          category: "service",
          status: res.status < 500 ? "ok" : "error",
          detail: `${cfg.services.ocr.endpoint} (HTTP ${res.status})`,
          latencyMs: Date.now() - t0,
        });
      } catch {
        entries.push({
          id: "ocr",
          name: "OCR 手写识别服务",
          category: "service",
          status: "fallback",
          detail: "远端 OCR 不可达，已启用本地笔迹几何识别降级",
          latencyMs: Date.now() - t0,
        });
      }
    } else {
      entries.push({
        id: "ocr",
        name: "OCR 手写识别服务",
        category: "service",
        status: "fallback",
        detail: "未配置远端 OCR 端点，使用本地手写笔迹分析模式",
        latencyMs: null,
      });
    }

    // 5. Workflow Provider
    entries.push({
      id: "workflow",
      name: "外部采集/自动化 Workflow Provider",
      category: "service",
      status: cfg.services.workflow.enabled && cfg.services.workflow.endpoint ? "ok" : "unconfigured",
      detail:
        cfg.services.workflow.enabled && cfg.services.workflow.endpoint
          ? cfg.services.workflow.endpoint
          : "未配置外部 Webhook（可直接导入本机 daily-review-learning 或手动入库）",
      latencyMs: null,
    });

    // 6. Payments
    const domesticOn = cfg.services.payment.domestic.enabled && Boolean(cfg.services.payment.domestic.appId);
    const globalOn = cfg.services.payment.global.enabled && Boolean(cfg.services.payment.global.apiKey);
    entries.push({
      id: "payment",
      name: "支付通道（国内虎皮椒 / 全球 MoR）",
      category: "service",
      status: domesticOn || globalOn ? "ok" : "fallback",
      detail: [
        domesticOn ? "虎皮椒已就绪" : "虎皮椒沙盒模式",
        globalOn ? `${cfg.services.payment.global.type} 已就绪` : `${cfg.services.payment.global.type} 沙盒模式`,
      ].join(" · "),
      latencyMs: null,
    });

    // 7. Distribution
    entries.push({
      id: "distribution",
      name: "全渠道内容分发",
      category: "service",
      status: cfg.services.distribution.enabled && cfg.services.distribution.endpoint ? "ok" : "fallback",
      detail:
        cfg.services.distribution.enabled && cfg.services.distribution.endpoint
          ? `Webhook 已连接 · ${cfg.services.distribution.channels.length} 个渠道`
          : `本地多渠道适配草稿就绪（${cfg.services.distribution.channels.join("/")}）`,
      latencyMs: null,
    });

    const overall = entries.some((e) => e.status === "error") ? "degraded" : "ok";
    return { checkedAt: new Date().toISOString(), overall, entries };
  }
}

export function registerProvidersRoutes(
  app: Hono,
  db: DatabaseSync,
  user: (c: Context) => unknown,
  submitToken?: string,
) {
  const store = new ProvidersStore(db);
  const { permits } = submitAuth(submitToken);
  const base = "/api/opc/providers";

  app.use(base + "/*", async (c, next) => {
    if (!permits(c)) user(c);
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(base, async (c, next) => {
    if (!permits(c)) user(c);
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get(base, (c) => c.json(store.getRedacted()));
  app.put(base, async (c) => c.json(store.update(await c.req.json())));
  app.post(base + "/health", async (c) => c.json(await store.checkHealth()));

  return store;
}
