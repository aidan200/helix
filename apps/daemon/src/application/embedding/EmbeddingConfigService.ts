/**
 * EmbeddingConfigService —— embedding 端点配置域 application service
 * （管家记忆 B2 批）。
 *
 * 定位：向量嵌入端点的配置面单点（CRUD + 连通测试 + 端点解析）。B1 期
 * 端点三字段直接挂在 steward.memory KV（单端点私有形态）；B2 收编为独立
 * 配置域——runtime_config KV `embedding_endpoints` 一键存多端点数组，
 * 模型页「向量模型」tab 消费；管家记忆组改经 endpointId 引用本域条目。
 *
 * 职责：
 * - CRUD：set（缺省 id 新增 uuid / 带 id 更新——apiKey 空串清除、缺省
 *   不动，凭据只进不出）；delete；list（daemon 内全量）/ listView（回执
 *   视图——hasApiKey + verifiedAt，apiKey 原值永不出库）；
 * - verify：目标端点一次短文本嵌入——ok 落 verifiedAt + 回实测 dim
 *   （vec0 dim 锁表语义），fail 回定位信息；
 * - resolve：endpointId → EmbeddingEndpointConfig（条目完整才可用；
 *   条目已删/不存在 → null——记忆可用性闸的输入）；
 * - migrateLegacyStewardEndpoint：一次性迁移——旧 KV
 *   steward.memory.embedding（B1 三字段）存在且 embedding_endpoints 为空
 *   → 迁成首条端点（name="默认端点"）+ steward.memory.endpointId 指向 +
 *   清旧键；否则零动作（幂等安全）。
 *
 * apiKey 存储策略：KV 明文（runtime_config 表）——与 auth.json 同款
 * （不另造加密，daemon 本地文件权限即边界）；出库面统一 hasApiKey。
 */

import type { RuntimeConfigPort } from "../ports/outbound/RuntimeConfigPort";
import type { EmbeddingEndpointConfig, EmbeddingPort } from "../ports/outbound/EmbeddingPort";

/** 端点清单 KV 键（JSON 数组）。 */
export const EMBEDDING_ENDPOINTS_KEY = "embedding_endpoints";

/** 端点存储行（KV JSON 数组元素形态）。 */
export interface EmbeddingEndpointRecord {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  /** 最近一次连通验证通过时间（epoch ms；从未验证 = 缺席）。 */
  readonly verifiedAt?: number;
}

/** 回执视图行（凭据卫生：apiKey → hasApiKey + 尾 4 位脱敏）。 */
export interface EmbeddingEndpointDto {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly hasApiKey: boolean;
  readonly keyMasked?: string;
  readonly verifiedAt: number | null;
}

export interface EmbeddingConfigServiceDeps {
  readonly config: RuntimeConfigPort;
  /** 按目标端点现配构造探测端口（verify 连通测试面——组合根注入
   *  OpenAiCompatEmbeddingAdapter 工厂；与 steward 记忆主端口同实现类）。 */
  readonly createProbe: (cfg: EmbeddingEndpointConfig) => EmbeddingPort;
  /** uuid 生成器（测试注入；缺省 crypto.randomUUID）。 */
  readonly newId?: () => string;
  readonly clock?: () => number;
}

/** KV JSON 防御解析（形态非法视同空表）。 */
function parseRecords(raw: string | undefined): EmbeddingEndpointRecord[] {
  if (raw === undefined || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: EmbeddingEndpointRecord[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Partial<EmbeddingEndpointRecord>;
      if (typeof r.id !== "string" || r.id === "") continue;
      if (typeof r.name !== "string" || typeof r.baseUrl !== "string" || typeof r.model !== "string") continue;
      out.push({
        id: r.id,
        name: r.name,
        baseUrl: r.baseUrl,
        model: r.model,
        ...(typeof r.apiKey === "string" && r.apiKey !== "" ? { apiKey: r.apiKey } : {}),
        ...(typeof r.verifiedAt === "number" ? { verifiedAt: r.verifiedAt } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export class EmbeddingConfigService {
  private readonly deps: EmbeddingConfigServiceDeps;
  private readonly now: () => number;

  constructor(deps: EmbeddingConfigServiceDeps) {
    this.deps = deps;
    this.now = deps.clock ?? Date.now;
  }

  /** 全量端点（daemon 内——含 apiKey；勿直接进回执帧）。 */
  list(): readonly EmbeddingEndpointRecord[] {
    return parseRecords(this.deps.config.get(EMBEDDING_ENDPOINTS_KEY));
  }

  /** 回执视图（凭据卫生：apiKey → hasApiKey + 尾 4 位脱敏）。 */
  listView(): readonly EmbeddingEndpointDto[] {
    return this.list().map((r) => ({
      id: r.id,
      name: r.name,
      baseUrl: r.baseUrl,
      model: r.model,
      hasApiKey: r.apiKey !== undefined,
      ...(r.apiKey !== undefined ? { keyMasked: `····${r.apiKey.slice(-4)}` } : {}),
      verifiedAt: r.verifiedAt ?? null,
    }));
  }

  /**
   * 新增或更新（id 缺省新增；带 id 更新——name/baseUrl/model 覆盖写，
   * apiKey 空串 = 清除、缺省 = 不动）。字段变更后旧 verifiedAt 语义失效
   * （端点/模型可能已换）——编辑即清。
   */
  async set(input: {
    id?: string;
    name: string;
    baseUrl: string;
    apiKey?: string;
    model: string;
  }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const name = input.name.trim();
    const baseUrl = input.baseUrl.trim();
    const model = input.model.trim();
    if (name === "" || baseUrl === "" || model === "") {
      return { ok: false, error: "端点字段不得为空（name/baseUrl/model）" };
    }
    const records = [...this.list()];
    if (input.id === undefined) {
      const id = this.deps.newId?.() ?? crypto.randomUUID();
      records.push({
        id,
        name,
        baseUrl,
        model,
        ...(input.apiKey !== undefined && input.apiKey !== "" ? { apiKey: input.apiKey } : {}),
      });
      await this.deps.config.set(EMBEDDING_ENDPOINTS_KEY, JSON.stringify(records));
      return { ok: true, id };
    }
    const idx = records.findIndex((r) => r.id === input.id);
    if (idx === -1) return { ok: false, error: `端点不存在：${input.id}` };
    const prev = records[idx]!;
    records[idx] = {
      id: prev.id,
      name,
      baseUrl,
      model,
      // apiKey 空串 = 清除；缺省 = 保留现值（凭据只进不出——编辑面无原值可回填）
      ...(input.apiKey !== undefined
        ? input.apiKey !== ""
          ? { apiKey: input.apiKey }
          : {}
        : prev.apiKey !== undefined
          ? { apiKey: prev.apiKey }
          : {}),
      ...(prev.baseUrl === baseUrl && prev.model === model ? { verifiedAt: prev.verifiedAt } : {}),
    };
    await this.deps.config.set(EMBEDDING_ENDPOINTS_KEY, JSON.stringify(records));
    return { ok: true, id: input.id };
  }

  /** 删除（id 不存在 → error）。 */
  async delete(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const records = this.list();
    const next = records.filter((r) => r.id !== id);
    if (next.length === records.length) return { ok: false, error: `端点不存在：${id}` };
    await this.deps.config.set(EMBEDDING_ENDPOINTS_KEY, JSON.stringify(next));
    return { ok: true };
  }

  /**
   * 连通测试：按目标端点现配构造探测端口，一次短文本嵌入。ok → verifiedAt
   * 落盘 + 回实测 dim；fail → error 含定位信息（verifiedAt 不动——上次
   * 成功时间保留）。
   */
  async verify(id: string): Promise<{ state: "ok"; dim: number } | { state: "fail"; error: string }> {
    const record = this.list().find((r) => r.id === id);
    if (record === undefined) return { state: "fail", error: `端点不存在：${id}` };
    const probe = this.deps.createProbe({
      baseUrl: record.baseUrl,
      model: record.model,
      ...(record.apiKey !== undefined ? { apiKey: record.apiKey } : {}),
    });
    try {
      const { dim } = await probe.embed(["hi"]);
      const records = [...this.list()];
      const idx = records.findIndex((r) => r.id === id);
      if (idx !== -1) {
        records[idx] = { ...records[idx]!, verifiedAt: this.now() };
        await this.deps.config.set(EMBEDDING_ENDPOINTS_KEY, JSON.stringify(records));
      }
      return { state: "ok", dim };
    } catch (err) {
      return { state: "fail", error: (err as Error).message };
    }
  }

  /** endpointId → 端点记录（含 name 等元数据；条目已删/不存在 → null——记忆
   *  引用态回执与可用性闸的输入）。 */
  resolveRecord(endpointId: string): EmbeddingEndpointRecord | null {
    return this.list().find((r) => r.id === endpointId) ?? null;
  }

  /** endpointId → EmbeddingEndpointConfig（条目已删/不存在 → null）。 */
  resolve(endpointId: string): EmbeddingEndpointConfig | null {
    const record = this.resolveRecord(endpointId);
    if (record === null) return null;
    return {
      baseUrl: record.baseUrl,
      model: record.model,
      ...(record.apiKey !== undefined ? { apiKey: record.apiKey } : {}),
    };
  }

  /**
   * 一次性迁移：旧 KV steward.memory.embedding（B1 三字段）存在且
   * embedding_endpoints 为空 → 迁成首条端点（name="默认端点"）+
   * steward.memory.endpointId 指向 + 清旧键。返回新端点 id；零动作 → null。
   */
  async migrateLegacyStewardEndpoint(legacyKey: string, endpointIdKey: string): Promise<string | null> {
    const legacyRaw = this.deps.config.get(legacyKey);
    if (legacyRaw === undefined || legacyRaw.trim() === "") return null;
    if (this.list().length > 0) return null; // 新域已有数据——不迁移（防覆盖）
    let legacy: { baseUrl?: unknown; apiKey?: unknown; model?: unknown };
    try {
      legacy = JSON.parse(legacyRaw) as typeof legacy;
    } catch {
      return null; // 形态非法视同无旧配置
    }
    if (typeof legacy.baseUrl !== "string" || legacy.baseUrl.trim() === "") return null;
    if (typeof legacy.model !== "string" || legacy.model.trim() === "") return null;
    const id = this.deps.newId?.() ?? crypto.randomUUID();
    const record: EmbeddingEndpointRecord = {
      id,
      name: "默认端点",
      baseUrl: legacy.baseUrl.trim(),
      model: legacy.model.trim(),
      ...(typeof legacy.apiKey === "string" && legacy.apiKey !== "" ? { apiKey: legacy.apiKey } : {}),
    };
    await this.deps.config.set(EMBEDDING_ENDPOINTS_KEY, JSON.stringify([record]));
    await this.deps.config.set(endpointIdKey, id);
    await this.deps.config.set(legacyKey, "");
    return id;
  }
}
