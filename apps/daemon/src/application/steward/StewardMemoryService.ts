/**
 * StewardMemoryService —— 管家长期记忆 application service（管家记忆 B1 批）。
 *
 * 定位：StewardService 的记忆域编排面（委托注入，缺席 = 记忆整体降级
 * 不可用、对话主链路零影响）。编排两出站端口：
 * - EmbeddingPort（文本 → 向量；OpenAI 兼容 HTTP——端点配置 KV 惰性读，
 *   未配置 = 记忆不可用）；
 * - StewardMemoryPort（sqlite-vec 存储；vec0 扩展不可解析 = 装配层缺
 *   席注入，同降级路径）。
 *
 * 三职责：
 * ① 召回（recallSection）：ask 前轮内 query 嵌入 → cosine topK → system
 *    prompt 记忆段文本。任何失败（端点不可达/协议异常/维度重建失败）
 *    静默降级为 undefined（无记忆段）+ logger.warn——召回绝不能挡对话；
 * ② 写入（remember）：confirm 闸执行体调用——条目 embed → 维度对齐 →
 *    append。失败原样上抛（确认卡回执展示失败详情——写路径不静默）；
 * ③ 维度切换重建（ensureDim）：vec0 维度建表锁死——换 embedding 模型
 *    （dim 变）→ resetVectors 清向量面 → 全量条目分批重嵌入回填。
 *    文本是唯一 source of truth，向量是可再生缓存。
 *
 * 配置面（RuntimeConfigPort KV 两键——steward.enabled/model 先例同构）：
 * - steward.memory.enabled = "1"/"0"（开关——记忆是可选项：无 Ollama
 *   无云 API 用户不开，零依赖开箱）；
 * - steward.memory.embedding = JSON {baseUrl, apiKey?, model}（OpenAI
 *   兼容端点——云端 provider 与本地 Ollama/LM Studio 同协议通吃）。
 * 凭据卫生：getMemoryState 导出面只回 hasApiKey 布尔，apiKey 永不出库。
 */

import type { RuntimeConfigPort } from "../ports/outbound/RuntimeConfigPort";
import type { EmbeddingEndpointConfig, EmbeddingPort } from "../ports/outbound/EmbeddingPort";
import type {
  StewardMemoryEntry,
  StewardMemoryPort,
} from "../ports/outbound/StewardMemoryPort";

/** 记忆开关 KV 键。 */
export const STEWARD_MEMORY_ENABLED_KEY = "steward.memory.enabled";
/** 嵌入端点配置 KV 键（JSON {baseUrl, apiKey?, model}）。 */
export const STEWARD_MEMORY_EMBEDDING_KEY = "steward.memory.embedding";
/** 召回 topK（B1 定格 5——system prompt 预算纪律，与对话 16k 窗口同族）。 */
export const STEWARD_MEMORY_RECALL_TOP_K = 5;
/** 维度重建分批大小（embedding 批量调用——端点速率防御）。 */
const REBUILD_BATCH_SIZE = 32;

/** 配置面导出现态（凭据卫生：只回 hasApiKey）。 */
export interface StewardMemoryState {
  /** 记忆开关现态（默认 false）。 */
  readonly enabled: boolean;
  /** 综合可用性（开关开 ∧ 端点已配 ∧ 存储已装配——召回/写入真实门槛）。 */
  readonly available: boolean;
  /** 端点配置现态（未配置 = null）。 */
  readonly endpoint: { readonly baseUrl: string; readonly model: string; readonly hasApiKey: boolean } | null;
  /** 记忆条目总数。 */
  readonly entryCount: number;
  /** 当前向量维度（未初始化 = null）。 */
  readonly dim: number | null;
}

export interface StewardMemoryServiceDeps {
  readonly config: RuntimeConfigPort;
  readonly embedding: EmbeddingPort;
  /** 存储面（vec0 不可用 → 装配层缺席注入 → 记忆整体降级）。 */
  readonly store?: StewardMemoryPort;
  readonly clock?: () => number;
  readonly logger?: { warn(message: string): void };
}

/** 端点配置 KV 解析（纯函数导出——组合根 embedding 适配器 getConfig
 *  与服务内部共用同一解析单源；形态非法视同未配置）。 */
export function readEmbeddingEndpointConfig(config: RuntimeConfigPort): EmbeddingEndpointConfig | null {
  const raw = config.get(STEWARD_MEMORY_EMBEDDING_KEY);
  if (raw === undefined || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EmbeddingEndpointConfig>;
    if (typeof parsed.baseUrl !== "string" || parsed.baseUrl.trim() === "") return null;
    if (typeof parsed.model !== "string" || parsed.model.trim() === "") return null;
    return {
      baseUrl: parsed.baseUrl.trim(),
      model: parsed.model.trim(),
      ...(typeof parsed.apiKey === "string" && parsed.apiKey !== "" ? { apiKey: parsed.apiKey } : {}),
    };
  } catch {
    return null;
  }
}

export class StewardMemoryService {
  private readonly deps: StewardMemoryServiceDeps;
  private readonly now: () => number;

  constructor(deps: StewardMemoryServiceDeps) {
    this.deps = deps;
    this.now = deps.clock ?? Date.now;
  }

  /** 端点配置读面（KV JSON 防御解析——形态非法视同未配置）。 */
  endpointConfig(): EmbeddingEndpointConfig | null {
    return readEmbeddingEndpointConfig(this.deps.config);
  }

  isEnabled(): boolean {
    return this.deps.config.get(STEWARD_MEMORY_ENABLED_KEY) === "1";
  }

  /** 综合可用性（召回/写入统一门槛）。 */
  isAvailable(): boolean {
    return this.isEnabled() && this.endpointConfig() !== null && this.deps.store !== undefined;
  }

  /** 配置面导出现态（凭据卫生：apiKey 不出库）。 */
  getMemoryState(): StewardMemoryState {
    const cfg = this.endpointConfig();
    return {
      enabled: this.isEnabled(),
      available: this.isAvailable(),
      endpoint:
        cfg === null
          ? null
          : { baseUrl: cfg.baseUrl, model: cfg.model, hasApiKey: cfg.apiKey !== undefined },
      entryCount: this.deps.store?.count() ?? 0,
      dim: this.deps.store?.storedDim() ?? null,
    };
  }

  /** 配置写面（开关 + 端点三字段可选更新；baseUrl/model 非空校验）。 */
  async setMemoryConfig(patch: {
    enabled?: boolean;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const current = this.endpointConfig();
    const next: EmbeddingEndpointConfig = {
      baseUrl: patch.baseUrl !== undefined ? patch.baseUrl.trim() : (current?.baseUrl ?? ""),
      model: patch.model !== undefined ? patch.model.trim() : (current?.model ?? ""),
      ...(patch.apiKey !== undefined
        ? patch.apiKey !== ""
          ? { apiKey: patch.apiKey }
          : {}
        : current?.apiKey !== undefined
          ? { apiKey: current.apiKey }
          : {}),
    };
    if (patch.enabled === true && (next.baseUrl === "" || next.model === "")) {
      return { ok: false, error: "开启记忆前请先配置嵌入端点（baseUrl 与 model 必填）" };
    }
    if ((patch.baseUrl !== undefined || patch.model !== undefined || patch.apiKey !== undefined) &&
        (next.baseUrl === "" || next.model === "")) {
      return { ok: false, error: "嵌入端点 baseUrl 与 model 不得为空" };
    }
    if (patch.baseUrl !== undefined || patch.model !== undefined || patch.apiKey !== undefined) {
      await this.deps.config.set(STEWARD_MEMORY_EMBEDDING_KEY, JSON.stringify(next));
    }
    if (patch.enabled !== undefined) {
      await this.deps.config.set(STEWARD_MEMORY_ENABLED_KEY, patch.enabled ? "1" : "0");
    }
    return { ok: true };
  }

  /**
   * 召回（ask 前轮内）：query 嵌入 → 维度对齐 → cosine topK → system
   * prompt 记忆段文本。任何失败静默降级 undefined + warn（召回绝不能
   * 挡对话主链路）；记忆不可用 → undefined（零调用零日志——常态降级）。
   */
  async recallSection(queryText: string): Promise<string | undefined> {
    if (!this.isAvailable()) return undefined;
    try {
      const { vectors, dim } = await this.deps.embedding.embed([queryText]);
      await this.ensureDim(dim);
      const hits = this.deps.store!.search(vectors[0]!, STEWARD_MEMORY_RECALL_TOP_K);
      if (hits.length === 0) return undefined;
      const lines = hits.map(
        (h) => `- [${h.kind === "preference" ? "偏好" : "事实"}] ${h.text}`,
      );
      return `## 长期记忆（按本轮输入语义召回，仅供作答参考——与本轮指令冲突时以本轮指令为准）\n${lines.join("\n")}`;
    } catch (err) {
      this.deps.logger?.warn(`steward 记忆召回降级：${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * 写入（confirm 闸执行体调用）：条目 embed → 维度对齐 → append。
   * 失败原样上抛（确认卡回执展示失败详情——写路径不静默）。
   */
  async remember(text: string, kind: "fact" | "preference", source: string): Promise<{ id: number }> {
    if (!this.isAvailable()) {
      throw new Error("记忆功能未启用或未配置（设置 → 通用 → 管家 → 记忆）");
    }
    const trimmed = text.trim();
    if (trimmed === "") throw new Error("记忆文本不得为空");
    const { vectors, dim } = await this.deps.embedding.embed([trimmed]);
    await this.ensureDim(dim);
    const store = this.deps.store!;
    store.append([{ kind, text: trimmed, source, createdAt: this.now(), vector: vectors[0]! }]);
    const entries = store.list();
    return { id: entries[entries.length - 1]!.id };
  }

  /** 条目只读列表（配置面展示数据源）。 */
  listEntries(): readonly StewardMemoryEntry[] {
    return this.deps.store?.list() ?? [];
  }

  /** 条目删除（配置面写面；id 不存在 → false）。 */
  forgetEntry(id: number): boolean {
    return this.deps.store?.forget(id) ?? false;
  }

  /**
   * 维度对齐（换 embedding 模型 → dim 变 → vec0 重建）：清向量面 →
   * 全量条目分批重嵌入回填。重建失败（端点中途挂）抛错——meta dim 已
   * 更新、向量面部分回填，下次 embed 比对仍触发重建（幂等收敛）。
   */
  private async ensureDim(dim: number): Promise<void> {
    const store = this.deps.store!;
    if (store.storedDim() === dim) return;
    store.resetVectors(dim);
    const entries = store.list();
    // 重建是罕见路径（换模型才触发）——分批串行调端点逐批回填，失败即抛
    //（下轮 embed 比对重入，已回填批次幂等覆盖）。
    for (let i = 0; i < entries.length; i += REBUILD_BATCH_SIZE) {
      const batch = entries.slice(i, i + REBUILD_BATCH_SIZE);
      const { vectors } = await this.deps.embedding.embed(batch.map((e) => e.text));
      for (let j = 0; j < batch.length; j++) {
        store.putVector(batch[j]!.id, vectors[j]!);
      }
    }
  }
}
