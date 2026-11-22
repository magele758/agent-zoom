import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ApiError } from "../server/logic.ts";
import type { DomainEventBus } from "./events.ts";
import type {
  AdmissionCheckResult,
  AssetKind,
  AssetRecord,
  CanonicalResolution,
  MainlineRecord,
  MainlineStatus,
  MilestoneItem,
  PortfolioTree,
  ProductRecord,
  ProductRole,
} from "./types.ts";

function slugify(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || `item-${randomUUID().slice(0, 8)}`;
}

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class AssetRegistry {
  private db: DatabaseSync;
  private events: DomainEventBus;

  constructor(db: DatabaseSync, events: DomainEventBus) {
    this.db = db;
    this.events = events;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS opc_kernel_mainlines (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        thesis TEXT NOT NULL DEFAULT '',
        goal TEXT NOT NULL DEFAULT '',
        priority_weight INTEGER NOT NULL DEFAULT 50,
        quota_share_pct INTEGER NOT NULL DEFAULT 50,
        freeze_non_mainline INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        milestones_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS opc_kernel_products (
        id TEXT PRIMARY KEY,
        mainline_id TEXT NOT NULL REFERENCES opc_kernel_mainlines(id),
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'flagship_paid',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kernel_products_mainline ON opc_kernel_products(mainline_id);

      CREATE TABLE IF NOT EXISTS opc_kernel_assets (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES opc_kernel_products(id),
        mainline_id TEXT NOT NULL REFERENCES opc_kernel_mainlines(id),
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'repo',
        repo_full_name TEXT NOT NULL DEFAULT '',
        local_repo_path TEXT NOT NULL DEFAULT '',
        verify_command TEXT NOT NULL DEFAULT '',
        build_command TEXT NOT NULL DEFAULT '',
        deploy_command TEXT NOT NULL DEFAULT '',
        rollback_command TEXT NOT NULL DEFAULT '',
        health_url TEXT NOT NULL DEFAULT '',
        paused INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kernel_assets_product ON opc_kernel_assets(product_id);
      CREATE INDEX IF NOT EXISTS idx_kernel_assets_mainline ON opc_kernel_assets(mainline_id);
    `);
    this.ensureDefaultsAndSyncLegacy();
  }

  ensureDefaultsAndSyncLegacy() {
    const countRow = this.db.prepare("SELECT COUNT(*) AS n FROM opc_kernel_mainlines").get() as { n?: number };
    const now = new Date().toISOString();

    if (Number(countRow?.n ?? 0) === 0) {
      // Seed canonical core mainlines aligned with founder's company structure
      const factoryMainline = this.upsertMainline({
        id: "ml_dark_factory",
        slug: "agent-dark-factory",
        name: "Agent 暗工厂与一人公司中枢",
        thesis: "构建以 Agent 暗工厂为唯一交付内核、六大职能部门自治协同、创始人仅做关键审批的 OPC 操作系统。",
        goal: "跑通从信号评估、配额感知派工、外部确定性跑测到自动合入真上线与自愈运维的完整闭环。",
        priorityWeight: 95,
        quotaSharePct: 55,
        freezeNonMainline: false,
        status: "active",
        milestones: [
          { id: "m1", title: "微内核 + 六大职能部门架构落地", done: true },
          { id: "m2", title: "总裁审批网关 + 暗工厂真上线闭环", done: false },
          { id: "m3", title: "习惯记忆评估 + 配额感知临期榨取", done: false },
        ],
      });

      const flagshipMainline = this.upsertMainline({
        id: "ml_flagship_monetization",
        slug: "flagship-monetization",
        name: "旗舰产品商业变现主线",
        thesis: "围绕痛点明确的本地优先工具（PageLens / Audiobook），通过外部商业三件套跑通获客、激活与离线授权变现。",
        goal: "聚焦旗舰商业试点，跑通真实门面、离线授权与净毛利核算。",
        priorityWeight: 85,
        quotaSharePct: 45,
        freezeNonMainline: false,
        status: "active",
        milestones: [
          { id: "m1", title: "外部商业三件套标准端口就绪", done: true },
          { id: "m2", title: "1 号试点 PageLens 首发上架与首单验证", done: false },
        ],
      });

      const opcProduct = this.upsertProduct({
        id: "prod_opc_os",
        mainlineId: factoryMainline.id,
        slug: "opc-os",
        name: "OPC OS",
        role: "open_core",
      });
      this.upsertAsset({
        id: "asset_opc_os_repo",
        productId: opcProduct.id,
        slug: "opc-os",
        name: "agent-chatroom (OPC OS)",
        kind: "repo",
        repoFullName: "magele758/agent-zoom",
        localRepoPath: process.cwd(),
        verifyCommand: "npm run typecheck",
        buildCommand: "npm run build",
        healthUrl: "",
      });

      const pageLens = this.upsertProduct({
        id: "prod_pagelens",
        mainlineId: flagshipMainline.id,
        slug: "pagelens",
        name: "PageLens",
        role: "flagship_paid",
      });
      this.upsertAsset({
        id: "asset_pagelens_interpret",
        productId: pageLens.id,
        slug: "pagelens-interpret",
        name: "pagelens-interpret",
        kind: "extension",
        repoFullName: "magele758/pagelens-interpret",
      });
    }

    // Bridge any existing legacy tables if present in SQLite
    this.syncLegacyTables(now);
  }

  syncLegacyTables(_now = new Date().toISOString()) {
    const hasTable = (name: string) =>
      Boolean(
        this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(name),
      );

    // Sync pilot_focus freeze flag if present
    if (hasTable("opc_governance_kv")) {
      const pilotRow = this.db
        .prepare("SELECT value FROM opc_governance_kv WHERE key='pilot_focus'")
        .get() as { value?: string } | undefined;
      if (pilotRow?.value) {
        const parsed = safeJson<{ product?: string; project?: string; freezeNewInfraRepos?: boolean }>(
          pilotRow.value,
          {},
        );
        if (parsed.product) {
          const flagship =
            this.getMainlineBySlug("flagship-monetization") ?? this.listMainlines()[0];
          if (flagship) {
            const existingProd = this.resolveCanonicalRef(parsed.product).product;
            const prod =
              existingProd ??
              this.upsertProduct({
                mainlineId: flagship.id,
                name: parsed.product,
                role: "flagship_paid",
              });
            if (parsed.project) {
              const existingAsset = this.db
                .prepare("SELECT 1 FROM opc_kernel_assets WHERE product_id = ? AND lower(name) = lower(?) LIMIT 1")
                .get(prod.id, parsed.project);
              if (!existingAsset) {
                this.upsertAsset({
                  productId: prod.id,
                  name: parsed.project,
                  kind: "extension",
                });
              }
            }
          }
        }
      }
    }

    // Sync company_projects if present (insert-if-missing ONLY; never overwrite existing roles/kinds)
    if (hasTable("company_projects")) {
      const defaultMainline =
        this.getMainlineBySlug("flagship-monetization") ?? this.listMainlines()[0];
      if (defaultMainline) {
        const rows = this.db
          .prepare("SELECT product, name FROM company_projects")
          .all() as Array<{ product: string; name: string }>;
        for (const r of rows) {
          const existingProdRow = this.db
            .prepare("SELECT * FROM opc_kernel_products WHERE lower(name) = lower(?) LIMIT 1")
            .get(r.product) as Record<string, unknown> | undefined;
          const prod = existingProdRow
            ? this.mapProduct(existingProdRow)
            : this.upsertProduct({
                mainlineId: defaultMainline.id,
                name: r.product,
                role:
                  r.product.includes("商业套件") || r.product.includes("分析与内核")
                    ? "internal_infra"
                    : "open_core",
              });
          const existingAssetRow = this.db
            .prepare("SELECT 1 FROM opc_kernel_assets WHERE product_id = ? AND lower(name) = lower(?) LIMIT 1")
            .get(prod.id, r.name);
          if (!existingAssetRow) {
            this.upsertAsset({
              productId: prod.id,
              name: r.name,
              kind: "repo",
            });
          }
        }
      }
    }
  }

  listMainlines(): MainlineRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM opc_kernel_mainlines ORDER BY priority_weight DESC, created_at ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapMainline(r));
  }

  getMainline(id: string): MainlineRecord | null {
    const row = this.db
      .prepare("SELECT * FROM opc_kernel_mainlines WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapMainline(row) : null;
  }

  getMainlineBySlug(slug: string): MainlineRecord | null {
    const row = this.db
      .prepare("SELECT * FROM opc_kernel_mainlines WHERE slug = ?")
      .get(slug) as Record<string, unknown> | undefined;
    return row ? this.mapMainline(row) : null;
  }

  upsertMainline(input: {
    id?: string;
    slug?: string;
    name?: string;
    thesis?: string;
    goal?: string;
    priorityWeight?: number;
    quotaSharePct?: number;
    freezeNonMainline?: boolean;
    status?: MainlineStatus;
    milestones?: MilestoneItem[];
  }): MainlineRecord {
    const existingById = input.id ? this.getMainline(input.id) : null;
    const rawName = typeof input.name === "string" ? input.name.trim() : existingById?.name ?? "";
    if (!rawName) throw new ApiError(400, "bad_mainline", "长期主线名称不能为空");
    const slug = slugify(input.slug || existingById?.slug || rawName);
    const existing = existingById ?? this.getMainlineBySlug(slug);
    const now = new Date().toISOString();
    const id = existing?.id ?? input.id ?? `ml_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const thesis = typeof input.thesis === "string" ? input.thesis : existing?.thesis ?? "";
    const goal = typeof input.goal === "string" ? input.goal : existing?.goal ?? "";
    const rawWeight = input.priorityWeight !== undefined ? Number(input.priorityWeight) : (existing?.priorityWeight ?? 50);
    if (!Number.isFinite(rawWeight)) throw new ApiError(400, "bad_mainline", "priorityWeight 必须是有效数字");
    const priorityWeight = Math.max(1, Math.min(100, Math.round(rawWeight)));
    const rawQuota = input.quotaSharePct !== undefined ? Number(input.quotaSharePct) : (existing?.quotaSharePct ?? 50);
    if (!Number.isFinite(rawQuota)) throw new ApiError(400, "bad_mainline", "quotaSharePct 必须是有效数字");
    const quotaSharePct = Math.max(0, Math.min(100, Math.round(rawQuota)));
    const freezeNonMainline = input.freezeNonMainline !== undefined ? Boolean(input.freezeNonMainline) : (existing?.freezeNonMainline ?? false);
    const status: MainlineStatus = input.status ?? existing?.status ?? "active";
    const milestones = Array.isArray(input.milestones) ? input.milestones : existing?.milestones ?? [];

    this.db
      .prepare(
        `INSERT INTO opc_kernel_mainlines
         (id, slug, name, thesis, goal, priority_weight, quota_share_pct, freeze_non_mainline, status, milestones_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           thesis = excluded.thesis,
           goal = excluded.goal,
           priority_weight = excluded.priority_weight,
           quota_share_pct = excluded.quota_share_pct,
           freeze_non_mainline = excluded.freeze_non_mainline,
           status = excluded.status,
           milestones_json = excluded.milestones_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        existing?.slug ?? slug,
        rawName,
        thesis,
        goal,
        priorityWeight,
        quotaSharePct,
        freezeNonMainline ? 1 : 0,
        status,
        JSON.stringify(milestones),
        existing?.createdAt ?? now,
        now,
      );

    const updated = this.getMainline(id)!;
    this.events.emit({
      topic: "strategy.mainline_updated",
      sourceDomain: "strategy",
      mainlineId: updated.id,
      payload: {
        mainlineId: updated.id,
        name: updated.name,
        freezeNonMainline: updated.freezeNonMainline,
        priorityWeight: updated.priorityWeight,
        status: updated.status,
      },
    });
    return updated;
  }

  listProducts(mainlineId?: string): ProductRecord[] {
    const rows = mainlineId
      ? (this.db
          .prepare("SELECT * FROM opc_kernel_products WHERE mainline_id = ? ORDER BY created_at ASC")
          .all(mainlineId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare("SELECT * FROM opc_kernel_products ORDER BY created_at ASC")
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapProduct(r));
  }

  getProduct(id: string): ProductRecord | null {
    const row = this.db
      .prepare("SELECT * FROM opc_kernel_products WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapProduct(row) : null;
  }

  upsertProduct(input: {
    id?: string;
    mainlineId?: string;
    slug?: string;
    name?: string;
    role?: ProductRole;
    status?: "active" | "paused" | "archived";
  }): ProductRecord {
    const existingById = input.id ? this.getProduct(input.id) : null;
    const rawName = typeof input.name === "string" ? input.name.trim() : existingById?.name ?? "";
    if (!rawName) throw new ApiError(400, "bad_product", "产品名称不能为空");
    const slug = slugify(input.slug || existingById?.slug || rawName);
    const existingRow =
      existingById
        ? null
        : (this.db
            .prepare(
              `SELECT * FROM opc_kernel_products
               WHERE slug = ? OR lower(name) = lower(?)
               ORDER BY CASE WHEN slug = ? THEN 0 ELSE 1 END ASC LIMIT 1`,
            )
            .get(slug, rawName, slug) as Record<string, unknown> | undefined);
    const existing = existingById ?? (existingRow ? this.mapProduct(existingRow) : null);
    const targetMainlineId = input.mainlineId ?? existing?.mainlineId ?? "";
    const mainline = this.getMainline(targetMainlineId);
    if (!mainline) throw new ApiError(404, "mainline_not_found", "归属的长期主线不存在");
    const id = existing?.id ?? input.id ?? `prod_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO opc_kernel_products (id, mainline_id, slug, name, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           mainline_id = excluded.mainline_id,
           name = excluded.name,
           role = excluded.role,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        mainline.id,
        existing?.slug ?? slug,
        rawName,
        input.role ?? existing?.role ?? "flagship_paid",
        input.status ?? existing?.status ?? "active",
        existing?.createdAt ?? now,
        now,
      );

    if (existing && existing.mainlineId !== mainline.id) {
      this.db
        .prepare("UPDATE opc_kernel_assets SET mainline_id = ?, updated_at = ? WHERE product_id = ?")
        .run(mainline.id, now, id);
    }

    return this.getProduct(id)!;
  }

  listAssets(productId?: string): AssetRecord[] {
    const rows = productId
      ? (this.db
          .prepare("SELECT * FROM opc_kernel_assets WHERE product_id = ? ORDER BY created_at ASC")
          .all(productId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare("SELECT * FROM opc_kernel_assets ORDER BY created_at ASC")
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapAsset(r));
  }

  getAsset(id: string): AssetRecord | null {
    const row = this.db
      .prepare("SELECT * FROM opc_kernel_assets WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapAsset(row) : null;
  }

  upsertAsset(input: {
    id?: string;
    productId?: string;
    slug?: string;
    name?: string;
    kind?: AssetKind;
    repoFullName?: string;
    localRepoPath?: string;
    verifyCommand?: string;
    buildCommand?: string;
    deployCommand?: string;
    rollbackCommand?: string;
    healthUrl?: string;
    paused?: boolean;
  }): AssetRecord {
    const existingById = input.id ? this.getAsset(input.id) : null;
    const targetProductId = input.productId ?? existingById?.productId ?? "";
    const product = this.getProduct(targetProductId);
    if (!product) throw new ApiError(404, "product_not_found", "归属的产品不存在");
    const rawName = typeof input.name === "string" ? input.name.trim() : existingById?.name ?? "";
    if (!rawName) throw new ApiError(400, "bad_asset", "资产/仓库名称不能为空");
    const slug = slugify(input.slug || existingById?.slug || `${product.slug}-${rawName}`);
    const existingRow =
      existingById
        ? null
        : (this.db
            .prepare(
              `SELECT * FROM opc_kernel_assets
               WHERE slug = ? OR (product_id = ? AND lower(name) = lower(?))
               ORDER BY CASE WHEN slug = ? THEN 0 ELSE 1 END ASC LIMIT 1`,
            )
            .get(slug, product.id, rawName, slug) as Record<string, unknown> | undefined);
    const existing = existingById ?? (existingRow ? this.mapAsset(existingRow) : null);
    const id = existing?.id ?? input.id ?? `asset_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO opc_kernel_assets
         (id, product_id, mainline_id, slug, name, kind, repo_full_name, local_repo_path, verify_command, build_command, deploy_command, rollback_command, health_url, paused, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           product_id = excluded.product_id,
           mainline_id = excluded.mainline_id,
           name = excluded.name,
           kind = excluded.kind,
           repo_full_name = excluded.repo_full_name,
           local_repo_path = excluded.local_repo_path,
           verify_command = excluded.verify_command,
           build_command = excluded.build_command,
           deploy_command = excluded.deploy_command,
           rollback_command = excluded.rollback_command,
           health_url = excluded.health_url,
           paused = excluded.paused,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        product.id,
        product.mainlineId,
        existing?.slug ?? slug,
        rawName,
        input.kind ?? existing?.kind ?? "repo",
        typeof input.repoFullName === "string" ? input.repoFullName : existing?.repoFullName ?? "",
        typeof input.localRepoPath === "string" ? input.localRepoPath : existing?.localRepoPath ?? "",
        typeof input.verifyCommand === "string" ? input.verifyCommand : existing?.verifyCommand ?? "",
        typeof input.buildCommand === "string" ? input.buildCommand : existing?.buildCommand ?? "",
        typeof input.deployCommand === "string" ? input.deployCommand : existing?.deployCommand ?? "",
        typeof input.rollbackCommand === "string" ? input.rollbackCommand : existing?.rollbackCommand ?? "",
        typeof input.healthUrl === "string" ? input.healthUrl : existing?.healthUrl ?? "",
        (input.paused !== undefined ? Boolean(input.paused) : (existing?.paused ?? false)) ? 1 : 0,
        existing?.createdAt ?? now,
        now,
      );

    return this.getAsset(id)!;
  }

  portfolio(): PortfolioTree {
    const mainlines = this.listMainlines();
    const products = this.listProducts();
    const assets = this.listAssets();
    return {
      mainlines: mainlines.map((ml) => ({
        ...ml,
        products: products
          .filter((p) => p.mainlineId === ml.id)
          .map((p) => ({
            ...p,
            assets: assets.filter((a) => a.productId === p.id),
          })),
      })),
    };
  }

  /**
   * Resolves any identifier (assetId, productId, mainlineId, "Product/project", "owner/repo", or project name)
   * into the single canonical { mainline, product, asset } hierarchy.
   */
  resolveCanonicalRef(rawRef?: string | null): CanonicalResolution {
    const key = (rawRef ?? "").trim();
    if (!key) return { mainline: null, product: null, asset: null };

    const directAsset = this.db
      .prepare(
        `SELECT * FROM opc_kernel_assets
         WHERE id = ? OR slug = ? OR lower(name) = lower(?) OR lower(repo_full_name) = lower(?)
         LIMIT 1`,
      )
      .get(key, key.toLowerCase(), key, key) as Record<string, unknown> | undefined;
    if (directAsset) {
      const asset = this.mapAsset(directAsset);
      const product = this.getProduct(asset.productId);
      const mainline = this.getMainline(asset.mainlineId);
      return { mainline, product, asset };
    }

    if (key.includes("/")) {
      const [left, right] = key.split("/", 2);
      const subAsset = this.db
        .prepare("SELECT * FROM opc_kernel_assets WHERE lower(name) = lower(?) LIMIT 1")
        .get(right) as Record<string, unknown> | undefined;
      if (subAsset) {
        const asset = this.mapAsset(subAsset);
        return {
          mainline: this.getMainline(asset.mainlineId),
          product: this.getProduct(asset.productId),
          asset,
        };
      }
      const leftProd = this.db
        .prepare("SELECT * FROM opc_kernel_products WHERE lower(name) = lower(?) OR slug = ? LIMIT 1")
        .get(left, left.toLowerCase()) as Record<string, unknown> | undefined;
      if (leftProd) {
        const product = this.mapProduct(leftProd);
        return {
          mainline: this.getMainline(product.mainlineId),
          product,
          asset: null,
        };
      }
    }

    const directProduct = this.db
      .prepare("SELECT * FROM opc_kernel_products WHERE id = ? OR slug = ? OR lower(name) = lower(?) LIMIT 1")
      .get(key, key.toLowerCase(), key) as Record<string, unknown> | undefined;
    if (directProduct) {
      const product = this.mapProduct(directProduct);
      const firstAsset = this.listAssets(product.id)[0] ?? null;
      return {
        mainline: this.getMainline(product.mainlineId),
        product,
        asset: firstAsset,
      };
    }

    const directMainline = this.db
      .prepare("SELECT * FROM opc_kernel_mainlines WHERE id = ? OR slug = ? OR lower(name) = lower(?) LIMIT 1")
      .get(key, key.toLowerCase(), key) as Record<string, unknown> | undefined;
    if (directMainline) {
      return { mainline: this.mapMainline(directMainline), product: null, asset: null };
    }

    return { mainline: null, product: null, asset: null };
  }

  /**
   * Real programmatic governance check: enforces paused assets, kill-switches, paused mainlines,
   * and freezeNonMainline rules across intake, planning, and factory dispatch.
   */
  checkAdmission(
    rawRef: string,
    options: { isEmergencyBug?: boolean } = {},
  ): AdmissionCheckResult {
    const resolution = this.resolveCanonicalRef(rawRef);

    // Check legacy kill-switch table if present
    const hasKillTable = Boolean(
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opc_kill_switches'")
        .get(),
    );
    if (hasKillTable) {
      const candidates = [
        rawRef.trim(),
        resolution.product?.name,
        resolution.asset?.name,
      ].filter((x): x is string => Boolean(x));
      for (const candidate of candidates) {
        const stopped = this.db
          .prepare("SELECT status FROM opc_kill_switches WHERE lower(project) = lower(?) AND status = 'stopped' LIMIT 1")
          .get(candidate) as { status?: string } | undefined;
        if (stopped) {
          return {
            allowed: false,
            code: "kill_switch_stopped",
            reason: `项目「${candidate}」已触发商业止损停服（Kill Switch），禁止继续投入算力与派工。`,
            resolution,
          };
        }
      }
    }

    if (resolution.asset?.paused || resolution.product?.status === "paused") {
      return {
        allowed: false,
        code: "asset_paused",
        reason: `资产/产品「${resolution.asset?.name ?? resolution.product?.name ?? rawRef}」当前处于暂停状态。`,
        resolution,
      };
    }

    if (resolution.mainline && resolution.mainline.status !== "active") {
      return {
        allowed: false,
        code: "mainline_paused",
        reason: `归属主线「${resolution.mainline.name}」当前未激活（状态：${resolution.mainline.status}）。`,
        resolution,
      };
    }

    if (!options.isEmergencyBug) {
      const freezingMainlines = this.listMainlines().filter(
        (m) => m.status === "active" && m.freezeNonMainline,
      );
      if (freezingMainlines.length > 0) {
        const allowedIds = new Set(freezingMainlines.map((m) => m.id));
        const targetMainlineId = resolution.mainline?.id ?? null;
        const isInfra = resolution.product?.role === "internal_infra" && targetMainlineId !== "ml_dark_factory";
        if (!targetMainlineId || !allowedIds.has(targetMainlineId) || isInfra) {
          // Check founder-approved freeze exemptions in opc_freeze_overrides if table exists
          const hasOverrideTable = Boolean(
            this.db
              .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opc_freeze_overrides'")
              .get(),
          );
          if (hasOverrideTable) {
            const nowIso = new Date().toISOString();
            const candidates = [
              rawRef.trim(),
              resolution.product?.name,
              resolution.product?.slug,
              resolution.asset?.name,
              resolution.asset?.slug,
            ].filter((x): x is string => Boolean(x));
            for (const cand of candidates) {
              const exempted = this.db
                .prepare(
                  `SELECT id FROM opc_freeze_overrides
                   WHERE lower(target_ref) = lower(?) AND consumed = 0
                     AND (expires_at IS NULL OR expires_at > ?)
                   LIMIT 1`,
                )
                .get(cand, nowIso);
              if (exempted) {
                return { allowed: true, resolution };
              }
            }
          }

          const names = freezingMainlines.map((m) => m.name).join("、");
          return {
            allowed: false,
            code: "mainline_frozen",
            reason: `当前聚焦主线（${names}）已开启「冻结非主线与外围基建」铁律，拒绝「${rawRef}」准入或派工。`,
            resolution,
          };
        }
      }
    }

    return { allowed: true, resolution };
  }

  private mapMainline(row: Record<string, unknown>): MainlineRecord {
    return {
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
      thesis: String(row.thesis ?? ""),
      goal: String(row.goal ?? ""),
      priorityWeight: Number(row.priority_weight ?? 50),
      quotaSharePct: Number(row.quota_share_pct ?? 50),
      freezeNonMainline: Boolean(row.freeze_non_mainline),
      status: String(row.status ?? "active") as MainlineStatus,
      milestones: safeJson<MilestoneItem[]>(String(row.milestones_json ?? "[]"), []),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapProduct(row: Record<string, unknown>): ProductRecord {
    return {
      id: String(row.id),
      mainlineId: String(row.mainline_id),
      slug: String(row.slug),
      name: String(row.name),
      role: String(row.role ?? "flagship_paid") as ProductRole,
      status: String(row.status ?? "active") as ProductRecord["status"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapAsset(row: Record<string, unknown>): AssetRecord {
    return {
      id: String(row.id),
      productId: String(row.product_id),
      mainlineId: String(row.mainline_id),
      slug: String(row.slug),
      name: String(row.name),
      kind: String(row.kind ?? "repo") as AssetKind,
      repoFullName: String(row.repo_full_name ?? ""),
      localRepoPath: String(row.local_repo_path ?? ""),
      verifyCommand: String(row.verify_command ?? ""),
      buildCommand: String(row.build_command ?? ""),
      deployCommand: String(row.deploy_command ?? ""),
      rollbackCommand: String(row.rollback_command ?? ""),
      healthUrl: String(row.health_url ?? ""),
      paused: Boolean(row.paused),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
