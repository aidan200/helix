import { builtinModels, getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import type { Api, AssistantMessageEvent, Model, Models } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AuthVerifyOutcome,
  CatalogModelView,
  CatalogSnapshot,
  ModelCatalogPort,
} from "../../../application/ports/outbound/ModelCatalogPort";

/**
 * ModelCatalog —— builtin 静态表 + pi.dev overlay 合并目录（AD-2
 * architecture.md §6.2；契约 C §3）。
 *
 * 【实现方式（G-2 裁决）】**零 pi-coding-agent import**：withRemoteCatalog
 * 模式借鉴自实现（端点 `{base}/api/models/providers/{id}`、ETag 条件请求、
 * 304 只更新 checkedAt、404/501 清 etag、瞬时失败保缓存、mergeModels 同 id
 * 替换新 id 追加、localGeneratedAt 防降级、models-store.json 落盘兜底）。
 *
 * 【pi-ai import 域】本文件在 driven/pi-engine（TR-AD-7 三域内合法；
 * AG-04 守护）；对 application 只暴露 ModelCatalogPort（类型镜像）。
 *
 * 【缓存口径】catalog() = 读面 + 过期刷新（>4h 对 pi.dev 条件请求）；
 * refresh() = 强制全量拉取（绕过 4h）。per-provider ETag/checkedAt。
 */

/** pi.dev 远端目录默认端点。 */
export const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";

/** 目录拉取 fetch 最小面（globalThis.fetch 天然满足；测试 mock 低门槛）。 */
export type CatalogFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<Response> | Response;

/** 刷新窗口（4h，withRemoteCatalog 同源口径）。 */
export const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** 落盘 store 的 per-provider 条目（pi-ai ModelsStoreEntry 同构）。 */
export interface OverlayEntry {
  models: Model<Api>[];
  /** 远端目录 Last-Modified（epoch ms；缺省 0）。 */
  lastModified?: number;
  /** 上次远端核对时间（epoch ms）。 */
  checkedAt?: number;
  /** ETag（原样回传 If-None-Match）。 */
  etag?: string;
}

/** 落盘 store 文件形状。 */
interface StoreFile {
  version: 1;
  providers: Record<string, OverlayEntry>;
}

export interface ModelCatalogOptions {
  /** 底座 Models（缺省 builtinModels()；测试注入受控 fake catalog）。 */
  readonly models?: Models;
  /** builtin 目录生成时间戳（防降级基线；缺省 getBuiltinModelDataGeneratedAt()）。 */
  readonly localGeneratedAt?: number;
  /** 落盘兜底缓存路径（缺省不落盘——纯内存）。 */
  readonly storePath?: string;
  /** pi.dev 端点基座（测试注入 mock server）。 */
  readonly baseUrl?: string;
  /**
   * fetch 实现（缺省 globalThis.fetch；测试注入 mock——最小面：URL 字符串 +
   * headers init，同步/异步 Response 均可）。
   */
  readonly fetchImpl?: CatalogFetch;
  /** 时钟（测试注入）。 */
  readonly now?: () => number;
  /** 参与远端 overlay 的 provider ids（缺省 = 底座全部 provider）。 */
  readonly providers?: readonly string[];
  /** 连通验证模型变换面（测试注入：baseUrl 指向 stub server）。 */
  readonly verifyModelTransform?: (model: Model<Api>) => Model<Api>;
}

/** mergeModels（withRemoteCatalog 同构）：builtin 为 baseline、同 id 替换、新 id 追加。 */
export function mergeModels(baseline: readonly Model<Api>[], dynamic: readonly Model<Api>[]): Model<Api>[] {
  const merged = [...baseline];
  for (const model of dynamic) {
    const index = merged.findIndex((entry) => entry.id === model.id);
    if (index >= 0) merged[index] = model;
    else merged.push(model);
  }
  return merged;
}

/** 远端目录载荷解析（数组 / {models: []} / 对象值表三形态兼容）。 */
export function parseCatalog(providerId: string, value: unknown): Model<Api>[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && "models" in value && Array.isArray((value as { models: unknown }).models)
      ? (value as { models: unknown[] }).models
      : typeof value === "object" && value !== null
        ? Object.values(value)
        : undefined;
  if (!entries) throw new Error(`provider "${providerId}" 的远端目录载荷形态非法`);
  return entries
    .filter((entry): entry is Model<Api> => typeof entry === "object" && entry !== null && "id" in entry)
    .map((model) => ({ ...model, provider: providerId }));
}

/**
 * localGeneratedAt 防降级（withRemoteCatalog 同构）：远端条目无 Last-Modified
 * 或不晚于 builtin 生成时间 → overlay 视为不比本地新，忽略（builtin 胜出）。
 */
export function effectiveOverlay(entry: OverlayEntry | undefined, localGeneratedAt: number | undefined): Model<Api>[] {
  if (!entry || entry.models.length === 0) return [];
  if (localGeneratedAt !== undefined && (entry.lastModified === undefined || entry.lastModified <= localGeneratedAt)) {
    return [];
  }
  return entry.models;
}

export class ModelCatalog implements ModelCatalogPort {
  private readonly base: Models;
  private readonly localGeneratedAt: number | undefined;
  private readonly storePath: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: CatalogFetch;
  private readonly now: () => number;
  private readonly providerIdList: readonly string[];
  private readonly verifyModelTransform: ((model: Model<Api>) => Model<Api>) | undefined;
  private readonly store = new Map<string, OverlayEntry>();

  constructor(options: ModelCatalogOptions = {}) {
    this.base = options.models ?? builtinModels();
    this.localGeneratedAt = options.localGeneratedAt ?? getBuiltinModelDataGeneratedAt();
    this.storePath = options.storePath;
    this.baseUrl = options.baseUrl ?? DEFAULT_CATALOG_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.providerIdList = options.providers ?? this.base.getProviders().map((p) => p.id);
    this.verifyModelTransform = options.verifyModelTransform;
    this.loadStore();
  }

  // ── ModelCatalogPort 读面 ─────────────────────────────────

  /** 目录读面（4h 缓存口径）：任一 provider 过期 → 条件刷新；失败保缓存。 */
  async catalog(): Promise<CatalogSnapshot> {
    if (this.stale()) {
      await this.refreshAll(false);
    }
    return this.snapshot(undefined);
  }

  /** 强制刷新（绕过 4h；per-provider 并发；单点失败保缓存）。 */
  async refresh(): Promise<CatalogSnapshot & { degraded: readonly string[] }> {
    const result = await this.refreshAll(true);
    // 任一 provider 远端确认即 remote 口径；全部失败 → 保缓存/兜底 builtin
    const snapshot = this.snapshot(result.failures.length < this.providerIdList.length ? "remote" : undefined);
    return { ...snapshot, degraded: result.failures };
  }

  /** "provider/model-id" 在合并目录中（解析优先 overlay，缺省 builtin）。 */
  hasModel(modelId: string): boolean {
    return this.resolveModel(modelId) !== undefined;
  }

  /** 合并目录的 provider id 全集。 */
  providerIds(): readonly string[] {
    const ids = new Set(this.providerIdList);
    for (const [providerId, entry] of this.store) {
      if (effectiveOverlay(entry, this.localGeneratedAt).length > 0) ids.add(providerId);
    }
    return [...ids];
  }

  /** 连通验证（auth.verify 最小请求：streamSimple maxTokens=1）。 */
  async verify(providerId: string, apiKey: string | undefined): Promise<AuthVerifyOutcome> {
    if (apiKey === undefined || apiKey === "") {
      return { status: "fail", reason: `provider "${providerId}" 未录入 API key（先 auth.set_key）` };
    }
    const model = this.mergedModels().find((m) => m.provider === providerId);
    if (model === undefined) {
      return { status: "fail", reason: `目录中无 provider "${providerId}" 的模型` };
    }
    const target = this.verifyModelTransform?.(model) ?? model;
    const t0 = this.now();
    try {
      const stream = this.base.streamSimple(target, {
        messages: [{ role: "user", content: [{ type: "text", text: "ping" }], timestamp: 0 }],
      }, { apiKey, maxTokens: 1, maxRetries: 0 });
      for await (const event of stream) {
        const outcome = this.verifyEvent(event, this.now() - t0);
        if (outcome !== undefined) return outcome;
      }
      return { status: "fail", reason: "provider 流未产生结果（无 done/error 终态事件）" };
    } catch (err) {
      return { status: "fail", reason: (err as Error).message };
    }
  }

  // ── 组合根/引擎装配扩展面（非 port 面：pi Model 对象出口） ──

  /** 合并全量模型（builtin baseline + 各 provider 有效 overlay）。 */
  mergedModels(): Model<Api>[] {
    return this.providerIdList.flatMap((providerId) =>
      mergeModels(this.base.getModels(providerId), this.overlayOf(providerId)),
    );
  }

  /**
   * 合并视图 Models（引擎装配用：getModels/getModel 读合并面，其余方法
   * 全部显式直透底座——底座是原型链实例，对象展开会丢方法）。
   */
  modelsView(): Models {
    const catalog = this;
    return {
      getProviders: () => catalog.base.getProviders(),
      getProvider: (id) => catalog.base.getProvider(id),
      getModels: (providerId?: string) =>
        providerId === undefined
          ? catalog.mergedModels()
          : mergeModels(catalog.base.getModels(providerId), catalog.overlayOf(providerId)),
      getModel: (providerId: string, id: string) => catalog.resolveIn(providerId, id),
      refresh: (options) => catalog.base.refresh(options),
      checkAuth: (providerId, options) => catalog.base.checkAuth(providerId, options),
      getAvailable: (providerId, options) => catalog.base.getAvailable(providerId, options),
      getAuth: (providerIdOrModel, overrides) =>
        catalog.base.getAuth(providerIdOrModel as never, overrides),
      login: (providerId, type, interaction) => catalog.base.login(providerId, type, interaction),
      logout: (providerId, options) => catalog.base.logout(providerId, options),
      stream: (model, context, options) => catalog.base.stream(model, context, options),
      complete: (model, context, options) => catalog.base.complete(model, context, options),
      streamSimple: (model, context, options) => catalog.base.streamSimple(model, context, options),
      completeSimple: (model, context, options) => catalog.base.completeSimple(model, context, options),
      fetchDeferred: (model, handle, options) => catalog.base.fetchDeferred(model, handle, options),
      cancelDeferred: (model, handle, options) => catalog.base.cancelDeferred(model, handle, options),
    };
  }

  /** "provider/model-id" → 完整 Model（合并面解析；未知 undefined）。 */
  resolveModel(modelId: string): Model<Api> | undefined {
    const slash = modelId.indexOf("/");
    if (slash <= 0) return undefined;
    return this.resolveIn(modelId.slice(0, slash), modelId.slice(slash + 1));
  }

  private resolveIn(providerId: string, id: string): Model<Api> | undefined {
    const overlayHit = this.overlayOf(providerId).find((m) => m.id === id);
    if (overlayHit !== undefined) return overlayHit;
    return this.base.getModel(providerId, id);
  }

  private overlayOf(providerId: string): Model<Api>[] {
    return effectiveOverlay(this.store.get(providerId), this.localGeneratedAt);
  }

  // ── 刷新与快照 ────────────────────────────────────────────

  /** 任一 provider 的 checkedAt 超过刷新窗口（或从未核对）→ 目录过期。 */
  private stale(): boolean {
    const now = this.now();
    for (const providerId of this.providerIdList) {
      const entry = this.store.get(providerId);
      if (entry === undefined) return true;
      if (entry.checkedAt === undefined || now - entry.checkedAt >= REFRESH_INTERVAL_MS) return true;
    }
    return false;
  }

  private async refreshAll(
    force: boolean,
  ): Promise<{ failures: string[] }> {
    const failures: string[] = [];
    await Promise.all(
      this.providerIdList.map(async (providerId) => {
        try {
          await this.refreshProvider(providerId, force);
        } catch (err) {
          failures.push(`${providerId}: ${(err as Error).message}`); // 瞬时失败保缓存（entry 不动）
        }
      }),
    );
    this.persistStore(); // 落盘兜底（best-effort）
    return { failures };
  }

  /**
   * 单 provider 条件刷新（withRemoteCatalog 模式自实现）：
   * - force=false 且 checkedAt 未过 4h 窗口 → 跳过（缓存口径）；
   * - 有缓存 body 才发 If-None-Match（304 不可能清空 overlay）；
   * - 304 → 只挪 checkedAt；404/501 → 清 etag + lastModified=0；
   *   其余非 2xx → 保缓存记 checkedAt（瞬时失败，etag 仍有效下次再验）。
   */
  private async refreshProvider(providerId: string, force: boolean): Promise<void> {
    const entry = this.store.get(providerId);
    if (!force && entry?.checkedAt !== undefined && entry.lastModified !== undefined && this.now() - entry.checkedAt < REFRESH_INTERVAL_MS) {
      return;
    }
    const headers: Record<string, string> = { accept: "application/json" };
    const validator = entry !== undefined && entry.models.length > 0 ? entry.etag : undefined;
    if (validator !== undefined) headers["if-none-match"] = validator;
    const url = new URL(`/api/models/providers/${encodeURIComponent(providerId)}`, this.baseUrl);
    let response: Response;
    try {
      response = await this.fetchImpl(url.href, { headers });
    } catch (err) {
      throw new Error(`拉取失败：${(err as Error).message}`); // 网络不可达：entry 原样保留
    }
    const checkedAt = this.now();
    if (response.status === 304) {
      if (entry !== undefined) this.store.set(providerId, { ...entry, checkedAt });
      return;
    }
    if (response.status === 404 || response.status === 501) {
      this.store.set(providerId, {
        models: entry?.models ?? [],
        checkedAt,
        lastModified: 0,
        etag: undefined,
      });
      return;
    }
    if (!response.ok) {
      if (entry !== undefined) this.store.set(providerId, { ...entry, checkedAt });
      throw new Error(`HTTP ${response.status}`);
    }
    const refreshed = parseCatalog(providerId, await response.json());
    const lastModifiedHeader = Date.parse(response.headers.get("last-modified") ?? "");
    this.store.set(providerId, {
      models: refreshed,
      checkedAt,
      lastModified: Number.isNaN(lastModifiedHeader) ? 0 : lastModifiedHeader,
      etag: response.headers.get("etag") ?? undefined,
    });
  }

  /** 当前合并快照（CatalogModelView 投影 + 来源标记）。 */
  private snapshot(sourceOverride: "cache" | "remote" | undefined): CatalogSnapshot {
    const models: CatalogModelView[] = this.mergedModels().map((m) => {
      const overlay = this.overlayOf(m.provider).some((o) => o.id === m.id);
      return {
        id: `${m.provider}/${m.id}`,
        providerId: m.provider,
        contextWindow: m.contextWindow ?? 0,
        cost: {
          input: m.cost?.input ?? 0,
          output: m.cost?.output ?? 0,
          cacheRead: m.cost?.cacheRead ?? 0,
          cacheWrite: m.cost?.cacheWrite ?? 0,
        },
        source: overlay ? "overlay" : "builtin",
      };
    });
    let refreshedAt = 0;
    for (const entry of this.store.values()) {
      refreshedAt = Math.max(refreshedAt, entry.checkedAt ?? 0);
    }
    const anyOverlay = models.some((m) => m.source === "overlay");
    const source: CatalogSnapshot["source"] =
      sourceOverride ?? (anyOverlay ? "cache" : "builtin");
    return { models, refreshedAt, source };
  }

  private verifyEvent(event: AssistantMessageEvent, latencyMs: number): AuthVerifyOutcome | undefined {
    if (event.type === "done") return { status: "ok", latencyMs };
    if (event.type === "error") {
      const reason =
        event.error.errorMessage ??
        `provider 返回错误（stopReason=${event.error.stopReason}）`;
      return { status: "fail", reason };
    }
    return undefined;
  }

  // ── 落盘兜底（models-store.json，best-effort） ─────────────

  private loadStore(): void {
    if (this.storePath === undefined || !existsSync(this.storePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.storePath, "utf8")) as Partial<StoreFile>;
      if (parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object") {
        for (const [providerId, entry] of Object.entries(parsed.providers)) {
          if (entry && typeof entry === "object" && Array.isArray((entry as OverlayEntry).models)) {
            this.store.set(providerId, entry as OverlayEntry);
          }
        }
      }
    } catch {
      // 损坏 store：视同无缓存（builtin 兜底），不阻断启动
    }
  }

  private persistStore(): void {
    if (this.storePath === undefined) return;
    try {
      const file: StoreFile = {
        version: 1,
        providers: Object.fromEntries(this.store.entries()),
      };
      mkdirSync(path.dirname(this.storePath), { recursive: true });
      const tmp = `${this.storePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(file), "utf8");
      renameSync(tmp, this.storePath);
    } catch {
      // 落盘失败不阻断目录读面（内存仍有效）
    }
  }
}
