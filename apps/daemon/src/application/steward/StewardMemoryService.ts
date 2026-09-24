/**
 * StewardMemoryService —— 管家长期记忆 application service（管家记忆 B1 批
 * 落地、B2 批配置域化改造）。
 *
 * 定位：StewardService 的记忆域编排面（委托注入，缺席 = 记忆整体降级
 * 不可用、对话主链路零影响）。编排两出站端口：
 * - EmbeddingPort（文本 → 向量；OpenAI 兼容 HTTP——端点配置经
 *   EmbeddingConfigService 惰性解析（endpointId → 条目），未引用/条目已删
 *   = 记忆不可用）；
 * - StewardMemoryPort（sqlite-vec 存储；vec0 扩展不可解析 = 装配层缺
 *   席注入，同降级路径）。
 *
 * 三职责：
 * ① 召回（recallSection）：ask 前轮内 query 嵌入 → cosine topK → system
 *    prompt 记忆段文本。任何失败（端点不可达/协议异常/维度重建失败）
 *    静默降级为 undefined（无记忆段）+ logger.warn——召回绝不能挡对话；
 * ② 写入（remember / appendMemoryEntry）：confirm 闸执行体与人工新增
 *    （steward.memory_append 命令）双入口——条目 embed → 维度对齐 →
 *    append。失败原样上抛（写路径不静默）；
 * ③ 维度切换重建（ensureDim）：vec0 维度建表锁死——换 embedding 模型
 *    （dim 变）→ resetVectors 清向量面 → 全量条目分批重嵌入回填。
 *    文本是唯一 source of truth，向量是可再生缓存。
 *
 * 配置面（B2 瘦身形态——RuntimeConfigPort KV 两键）：
 * - steward.memory.enabled = "1"/"0"（开关——记忆是可选项：无 Ollama
 *   无云 API 用户不开，零依赖开箱）；
 * - steward.memory.endpointId（引用 embedding_endpoints 配置域条目——
 *   B1 期的 steward.memory.embedding 三字段私钥已一次性迁移进该域）。
 * available 闸 = 开关 ∧ endpointId 有效 ∧ 条目完整 ∧ 存储已装配。
 * 凭据卫生：getMemoryState 导出面只回引用态（id/name/model/hasApiKey），
 * apiKey 与 baseUrl 永不出库。
 */

import type { RuntimeConfigPort } from "../ports/outbound/RuntimeConfigPort";
import type { EmbeddingEndpointConfig, EmbeddingPort } from "../ports/outbound/EmbeddingPort";
import type { JudgePort } from "../ports/outbound/JudgePort";
import type { EmbeddingEndpointRecord } from "../embedding/EmbeddingConfigService";
import type {
  StewardMemoryEntry,
  StewardMemoryPort,
} from "../ports/outbound/StewardMemoryPort";

/** 记忆开关 KV 键。 */
export const STEWARD_MEMORY_ENABLED_KEY = "steward.memory.enabled";
/**
 * 旧嵌入端点配置 KV 键（B1 三字段 JSON——B2 起退役，仅供一次性迁移读取；
 * 迁移后清空）。
 */
export const STEWARD_MEMORY_EMBEDDING_KEY = "steward.memory.embedding";
/** 嵌入端点引用 KV 键（B2：指向 embedding_endpoints 配置域条目 id）。 */
export const STEWARD_MEMORY_ENDPOINT_ID_KEY = "steward.memory.endpointId";
/** 判官端点引用 KV 键（B4a 自动沉淀：指向 embedding_endpoints 域 kind=
 *  classifier 条目；未配置 = 自动沉淀静默不挂——对话主链路零影响）。 */
export const STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY = "steward.memory.judgeEndpointId";
/** 召回 topK（B1 定格 5——system prompt 预算纪律，与对话 16k 窗口同族）。 */
export const STEWARD_MEMORY_RECALL_TOP_K = 5;
/**
 * 召回相似度下限（B3：score < 此值的命中不注入——语义无关条目污染
 * system prompt 的噪音闸；bge-m3 cosine 经验值 0.30，近似主题即可达标，
 * 纯噪音明显低于此）。
 */
export const STEWARD_MEMORY_RECALL_MIN_SCORE = 0.3;
/**
 * 写入查重两段闸（B5：Jev 判官从「判增量」改为「判同一」）：
 * - 粗筛段：向量检索 top1 ≥ 0.85（放宽自 B3 的 0.92——召回更多候选交给判官精判）；
 * - 精判段：Jev noul 判「既有条目 vs 新句是否同一条记忆」≥ 0.5 → 覆盖更新；
 * - 降级：判官缺席/抛错 → 回退 0.92 纯向量高阈值（宁可不合并、不误合并
 *   不同记忆——0.85 无精判太宽）。
 */
export const STEWARD_MEMORY_DEDUP_RECALL_THRESHOLD = 0.85;
/** 判官缺席/抛错时的回退纯向量阈值（B3 原值保守段）。 */
export const STEWARD_MEMORY_DEDUP_FALLBACK_THRESHOLD = 0.92;
/** 判官同一性判定阈值（noul 校准概率 ≥ 此值 = 同一条记忆）。 */
export const STEWARD_MEMORY_SAME_THRESHOLD = 0.5;
/** 同一性判官问句（B5：查重精判段——不再判增量）。 */
export const STEWARD_MEMORY_SAME_QUESTION =
  "这两段文本表达的是同一条用户偏好或事实吗？（措辞不同但语义相同 = 同一条；同主题不同侧面 = 不是同一条）";
/** 维度重建分批大小（embedding 批量调用——端点速率防御）。 */
const REBUILD_BATCH_SIZE = 32;

/** embedding 配置域窄查询面（EmbeddingConfigService 结构性满足；测试注入 fake）。 */
export interface EmbeddingConfigLookup {
  resolveRecord(endpointId: string): EmbeddingEndpointRecord | null;
}

/** 配置面导出现态（B2 引用态：endpoint 只回 id/name/model/hasApiKey）。 */
export interface StewardMemoryState {
  /** 记忆开关现态（默认 false）。 */
  readonly enabled: boolean;
  /** 综合可用性（开关开 ∧ endpointId 有效 ∧ 条目完整 ∧ 存储已装配——召回/写入真实门槛）。 */
  readonly available: boolean;
  /** 当前引用端点（引用态；未引用或条目已删 = null）。 */
  readonly endpoint: { readonly id: string; readonly name: string; readonly model: string; readonly hasApiKey: boolean } | null;
  /** 记忆条目总数。 */
  readonly entryCount: number;
  /** 当前向量维度（未初始化 = null）。 */
  readonly dim: number | null;
  /** 当前判官端点引用（B4a 引用态；未引用/悬空/非 classifier = null）。 */
  readonly judgeEndpoint: { readonly id: string; readonly name: string; readonly model: string; readonly hasApiKey: boolean } | null;
}

export interface StewardMemoryServiceDeps {
  readonly config: RuntimeConfigPort;
  readonly embedding: EmbeddingPort;
  /** embedding 配置域查询面（endpointId → 端点条目）。 */
  readonly embeddingConfig: EmbeddingConfigLookup;
  /** 存储面（vec0 不可用 → 装配层缺席注入 → 记忆整体降级）。 */
  readonly store?: StewardMemoryPort;
  /** 判官面（B4a 自动沉淀；缺席 = 自动沉淀静默不挂——对话主链路零影响）。 */
  readonly judge?: JudgePort;
  readonly clock?: () => number;
  readonly logger?: { warn(message: string): void };
}

export class StewardMemoryService {
  private readonly deps: StewardMemoryServiceDeps;
  private readonly now: () => number;

  constructor(deps: StewardMemoryServiceDeps) {
    this.deps = deps;
    this.now = deps.clock ?? Date.now;
  }

  /** 当前引用的端点配置（endpointId 未设/条目已删 → null）。 */
  endpointConfig(): EmbeddingEndpointConfig | null {
    const endpointId = this.deps.config.get(STEWARD_MEMORY_ENDPOINT_ID_KEY);
    if (endpointId === undefined || endpointId === "") return null;
    return this.deps.embeddingConfig.resolveRecord(endpointId) === null
      ? null
      : this.deps.embeddingConfig.resolveRecord(endpointId)!;
  }

  /** 当前引用的端点记录（含 name——回执引用态数据源；null = 未引用/悬空）。 */
  private endpointRecord(): EmbeddingEndpointRecord | null {
    const endpointId = this.deps.config.get(STEWARD_MEMORY_ENDPOINT_ID_KEY);
    if (endpointId === undefined || endpointId === "") return null;
    return this.deps.embeddingConfig.resolveRecord(endpointId);
  }

  isEnabled(): boolean {
    return this.deps.config.get(STEWARD_MEMORY_ENABLED_KEY) === "1";
  }

  /** 综合可用性（召回/写入统一门槛）。 */
  isAvailable(): boolean {
    return this.isEnabled() && this.endpointRecord() !== null && this.deps.store !== undefined;
  }

  /** 当前判官端点记录（B4a：未引用/悬空/非 classifier → null——kind 校验
   *  保证判官端点与召回端点不串用；kind 缺席 = embedding 同判不适用）。 */
  private judgeEndpointRecord(): EmbeddingEndpointRecord | null {
    const judgeEndpointId = this.deps.config.get(STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY);
    if (judgeEndpointId === undefined || judgeEndpointId === "") return null;
    const record = this.deps.embeddingConfig.resolveRecord(judgeEndpointId);
    if (record === null || record.kind !== "classifier") return null;
    return record;
  }

  /** 自动沉淀可用性（B4a 遗留命名——B5 起判官用途为查重精判：记忆开关 ∧ 判官端点有效(classifier) ∧ judge port 已注入）。 */
  judgeSedimentAvailable(): boolean {
    return this.isEnabled() && this.judgeEndpointRecord() !== null && this.deps.judge !== undefined;
  }

  /** 同一性精判（B5 查重精判段；判官缺席/抛错由调用方回退纯向量阈值）。 */
  async judgeSame(existingText: string, incomingText: string): Promise<number> {
    if (!this.judgeSedimentAvailable()) throw new Error("判官不可用（开关/端点/判官面未就绪）");
    return this.deps.judge!.noul(`既有：${existingText}\n新写入：${incomingText}`, STEWARD_MEMORY_SAME_QUESTION);
  }

  /** 配置面导出现态（凭据卫生：apiKey/baseUrl 不出库）。 */
  getMemoryState(): StewardMemoryState {
    const record = this.endpointRecord();
    const judgeRecord = this.judgeEndpointRecord();
    return {
      enabled: this.isEnabled(),
      available: this.isAvailable(),
      endpoint:
        record === null
          ? null
          : { id: record.id, name: record.name, model: record.model, hasApiKey: record.apiKey !== undefined },
      entryCount: this.deps.store?.count() ?? 0,
      dim: this.deps.store?.storedDim() ?? null,
      judgeEndpoint:
        judgeRecord === null
          ? null
          : { id: judgeRecord.id, name: judgeRecord.name, model: judgeRecord.model, hasApiKey: judgeRecord.apiKey !== undefined },
    };
  }

  /**
   * 配置写面（开关 + 端点引用可选更新；无前置校验——引用悬空自然降级：
   * endpointId 指向不存在的条目 → endpointRecord() null → isAvailable()
   * 假即整体降级待命。先开后配是合法路径（endpointId 是记忆开启后才展开
   * 的从属项——写面拦截会造成死锁）。
   */
  async setMemoryConfig(patch: {
    enabled?: boolean;
    endpointId?: string;
    judgeEndpointId?: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (patch.endpointId !== undefined) {
      // 空串 = 清除引用（显式解绑）
      await this.deps.config.set(STEWARD_MEMORY_ENDPOINT_ID_KEY, patch.endpointId);
    }
    if (patch.judgeEndpointId !== undefined) {
      await this.deps.config.set(STEWARD_MEMORY_JUDGE_ENDPOINT_ID_KEY, patch.judgeEndpointId);
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
      const hits = this.deps
        .store!.search(vectors[0]!, STEWARD_MEMORY_RECALL_TOP_K)
        .filter((h) => h.score >= STEWARD_MEMORY_RECALL_MIN_SCORE);
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
  async remember(
    text: string,
    kind: "fact" | "preference",
    source: string,
  ): Promise<{ id: number; updated: boolean }> {
    if (!this.isAvailable()) {
      throw new Error("记忆功能未启用或未配置（设置 → 通用 → 管家 → 记忆）");
    }
    const trimmed = text.trim();
    if (trimmed === "") throw new Error("记忆文本不得为空");
    const { vectors, dim } = await this.deps.embedding.embed([trimmed]);
    await this.ensureDim(dim);
    const store = this.deps.store!;
    // B5 两段查重：0.85 向量粗筛 → Jev 精判同一性（缺席/抛错回退 0.92
    // 纯向量——保守不合并）；同一 → 覆盖更新原条目（id/createdAt/kind 保留
    // 首记形态，updatedAt 刷新——同一条记忆被更准确的重写刷新）。
    const top = store.search(vectors[0]!, 1)[0];
    if (top !== undefined && top.score >= STEWARD_MEMORY_DEDUP_RECALL_THRESHOLD && await this.isSameMemory(top, trimmed)) {
      store.updateEntry(top.id, trimmed, vectors[0]!, this.now());
      return { id: top.id, updated: true };
    }
    store.append([{ kind, text: trimmed, source, createdAt: this.now(), vector: vectors[0]! }]);
    const entries = store.list();
    return { id: entries[entries.length - 1]!.id, updated: false };
  }

  /**
   * 同一性判定（两段闸精判段）：判官可用 → noul 精判；缺席/抛错 → 回退
   * 纯向量 0.92 高阈值（宁可不合并不误合并——warn 留痕）。
   */
  private async isSameMemory(top: { text: string; score: number }, incoming: string): Promise<boolean> {
    if (!this.judgeSedimentAvailable()) return top.score >= STEWARD_MEMORY_DEDUP_FALLBACK_THRESHOLD;
    try {
      const p = await this.judgeSame(top.text, incoming);
      return p >= STEWARD_MEMORY_SAME_THRESHOLD;
    } catch (err) {
      this.deps.logger?.warn(`记忆查重精判降级（回退纯向量 ${STEWARD_MEMORY_DEDUP_FALLBACK_THRESHOLD}）：${(err as Error).message}`);
      return top.score >= STEWARD_MEMORY_DEDUP_FALLBACK_THRESHOLD;
    }
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
   * 人工新增（steward.memory_append 命令路径）：同 remember 双入口但
   * source 固定 "manual"、kind 缺省 "fact"。失败收口为 outcome（命令回执
   * error 判别——人工写路径不经确认卡）。
   */
  async appendMemoryEntry(text: string, kind?: "fact" | "preference"): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.remember(text, kind ?? "fact", "manual");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * 条目编辑重写（steward.memory_update 命令路径）：新文本重嵌 → 文本 +
   * 向量单事务重写。id 不存在 → error；不可用 → error（记忆未启用无法
   * 重嵌——编辑路径强依赖端点）。
   */
  async updateMemoryEntry(id: number, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.isAvailable()) {
      return { ok: false, error: "记忆功能未启用或未配置（设置 → 通用 → 管家 → 记忆）" };
    }
    const trimmed = text.trim();
    if (trimmed === "") return { ok: false, error: "记忆文本不得为空" };
    const store = this.deps.store!;
    if (!store.list().some((e) => e.id === id)) {
      return { ok: false, error: `记忆条目不存在：${id}` };
    }
    try {
      const { vectors, dim } = await this.deps.embedding.embed([trimmed]);
      await this.ensureDim(dim);
      if (!store.updateEntry(id, trimmed, vectors[0]!, this.now())) {
        return { ok: false, error: `记忆条目不存在：${id}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
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
