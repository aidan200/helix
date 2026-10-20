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
 *   不动，凭据只进不出；kind 同款缺席不动）；delete；list（daemon 内
 *   全量）/ listView（回执视图——hasApiKey + verifiedAt，apiKey 原值
 *   永不出库）；
 * - verify：按 kind 分叉探测——embedding 端点一次短文本嵌入（回实测
 *   dim；vec0 dim 锁表语义）；classifier 端点一次 noul 判定（回校准
 *   概率）。ok 落 verifiedAt，fail 回定位信息；
 * - resolve：endpointId → EmbeddingEndpointConfig（条目完整才可用；
 *   条目已删/不存在 → null——记忆可用性闸的输入）；
 * - setDefault / resolveDefault（批1 全局默认 embedding 端点；D1 渐进收编
 *   泛化 kind 维度）：默认端点引用态 KV 单点——embedding.defaultEndpointId
 *   （向量）与 classifier.defaultEndpointId（分类判官）同构对称，setDefault
 *   校验（条目存在 ∧ kind 吻合 ∧ 已 verify，kind 缺省 = embedding）；
 *   resolveDefault() 仍为向量面全消费面唯一取用单点（E-306 契约零变化），
 *   分类默认由 resolveDefaultClassifierRecord() 对称取用 + resolveJudgeRecord
 *   判官端点兜底层（显式引用 ＞ 默认分类端点 ＞ 缺席）；
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
import type { JudgePort } from "../ports/outbound/JudgePort";

/** 端点清单 KV 键（JSON 数组）。 */
export const EMBEDDING_ENDPOINTS_KEY = "embedding_endpoints";

/** 全局默认 embedding 端点引用 KV 键（批1：引用态指向 embedding_endpoints
 *  条目 id——独立 KV 引用态而非端点记录加 isDefault 字段（与
 *  memory.endpointId 引用态同构先例）：端点删除时引用自然悬空 = 无默认，
 *  各消费面按「无默认」降级，不需要级联清理；端点记录 schema 零改动）。 */
export const EMBEDDING_DEFAULT_ENDPOINT_ID_KEY = "embedding.defaultEndpointId";

/** 全局默认 classifier 端点引用 KV 键（D1 渐进收编：与
 *  embedding.defaultEndpointId 同构对称——embedding 配置域 kind 维度的
 *  默认引用态，判官消费面兜底取用（显式 judgeEndpointId 类键位优先，
 *  未配置时取本默认；无默认 = 判官缺席维持现状降级）。悬空语义同款：
 *  端点删除即悬空 = 无默认，无级联清理。 */
export const CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY = "classifier.defaultEndpointId";

/** kind → 默认引用 KV 键（单点：setDefault/resolveDefaultRecord 分 kind 收口）。 */
function defaultKeyOf(kind: EndpointKind): string {
  return kind === "classifier" ? CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY : EMBEDDING_DEFAULT_ENDPOINT_ID_KEY;
}

/** 端点用途维度（B4a）：embedding = 向量嵌入（记忆主链路）；classifier =
 *  分类判官（Jev 等单步判别——自动沉淀写入闸判定面）。同域不同用途，
 *  存量记录无 kind 字段 = embedding（零迁移兼容）。 */
export type EndpointKind = "embedding" | "classifier";

/** 端点存储行（KV JSON 数组元素形态）。 */
export interface EmbeddingEndpointRecord {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  /** 端点用途（缺席 = embedding——存量兼容）。 */
  readonly kind?: EndpointKind;
  /** 分类端点协议变体（kind=classifier 专用；缺席 = "jev"——存量兼容）。
   *  makeJudgeAdapter 注册表按此分派适配器，新分类模型（非 Jev 协议）
   *  接入时新增变体值 + 注册表条目，不改配置域形状（TR-159：parseRecords
   *  逐字段显式透传，set 更新缺省保留）。 */
  readonly variant?: string;
  /** 最近一次连通验证通过时间（epoch ms；从未验证 = 缺席）。 */
  readonly verifiedAt?: number;
}

/** 回执视图行（凭据卫生：apiKey → hasApiKey + 尾 4 位脱敏；variant 透传
 *  ——缺席 = 存量 jev 直连形态）。 */
export interface EmbeddingEndpointDto {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly kind: EndpointKind;
  readonly variant?: string;
  readonly hasApiKey: boolean;
  readonly keyMasked?: string;
  readonly verifiedAt: number | null;
}

export interface EmbeddingConfigServiceDeps {
  readonly config: RuntimeConfigPort;
  /** 按目标端点现配构造探测端口（verify 连通测试面——组合根注入
   *  OpenAiCompatEmbeddingAdapter 工厂；与 steward 记忆主端口同实现类）。 */
  readonly createProbe: (cfg: EmbeddingEndpointConfig) => EmbeddingPort;
  /** 按目标端点现配构造判官探测端口（classifier 端点 verify 面——B4a；
   *  组合根注入 makeJudgeAdapter 工厂——含 variant 协议变体标注，探测
   *  面与真体同链分派，新 variant 自动覆盖）。 */
  readonly createJudgeProbe: (cfg: EmbeddingEndpointConfig & { readonly variant?: string }) => JudgePort;
  /** uuid 生成器（测试注入；缺省 crypto.randomUUID）。 */
  readonly newId?: () => string;
  readonly clock?: () => number;
}

/** 判官端点兜底解析 lookup 面（D1 渐进收编单点消费形状——
 *  EmbeddingConfigService 结构性满足；各判官消费面 fake 同形注入）。 */
export interface JudgeEndpointLookup {
  resolveRecord(endpointId: string): EmbeddingEndpointRecord | null;
  resolveDefaultClassifierRecord(): EmbeddingEndpointRecord | null;
}

/**
 * 判官端点兜底解析（D1 渐进收编单点）：各消费面的 judgeEndpointId 类显式
 * 键位优先（显式在场即显式语义——悬空/非 classifier → null 不静默落默认）；
 * 未配置（undefined/空串）→ 取全局默认分类端点（有默认 = 判官在场）；
 * 无默认（未设/悬空/误指）→ null = 判官缺席，各消费面维持现状降级。
 * 全部判官消费面（记忆查重精判 / 分诊 / 意图 / barge-in 停止判定…）一律
 * 经本函数解析，不逐面各写一套。
 */
export function resolveJudgeRecord(
  explicitId: string | undefined | null,
  lookup: JudgeEndpointLookup,
): EmbeddingEndpointRecord | null {
  const id = explicitId !== undefined && explicitId !== null && explicitId.trim() !== "" ? explicitId.trim() : null;
  const record = id === null ? lookup.resolveDefaultClassifierRecord() : lookup.resolveRecord(id);
  return record !== null && record.kind === "classifier" ? record : null;
}

/** 端点记录 → 端口配置窄投影（apiKey 缺席即不传键——与 set 的凭据"空串清除/缺省不动"语义同源）。 */
export function endpointConfigOf(record: EmbeddingEndpointRecord): EmbeddingEndpointConfig {
  return {
    baseUrl: record.baseUrl,
    model: record.model,
    ...(record.apiKey !== undefined ? { apiKey: record.apiKey } : {}),
  };
}

/** 默认端点解析纯函数（评审 F1 单点收编）：records + 默认引用 id → 记录|null。
 *  判据：引用未设/空串 → null；悬空（条目已删）→ null；kind 不吻合（缺省 = embedding）
 *  → null。无 IO 无状态——子进程（ChildMain 本地记忆/向量栈）与独立脚本
 *  （backfill-kg-vectors）无需构造 EmbeddingConfigService 全量装配即可复用同一
 *  判据，E-306「resolveDefault 全消费面唯一取用单点」不再靠注释"与父进程同判"维系。 */
export function resolveDefaultRecordOf(
  records: readonly EmbeddingEndpointRecord[],
  defaultId: string | undefined,
  kind: EndpointKind = "embedding",
): EmbeddingEndpointRecord | null {
  if (defaultId === undefined || defaultId.trim() === "") return null;
  const record = records.find((r) => r.id === defaultId) ?? null;
  if (record === null || (record.kind ?? "embedding") !== kind) return null;
  return record;
}

/** 默认端点配置纯函数（resolveDefaultRecordOf 的窄投影面——消费面直取端口配置时用）。 */
export function resolveDefaultConfigOf(
  records: readonly EmbeddingEndpointRecord[],
  defaultId: string | undefined,
  kind: EndpointKind = "embedding",
): EmbeddingEndpointConfig | null {
  const record = resolveDefaultRecordOf(records, defaultId, kind);
  return record === null ? null : endpointConfigOf(record);
}

/** KV JSON 防御解析（形态非法视同空表）。导出（批E）：ChildMain 本地
 *  memory_search 栈复用同源解析（子进程无 EmbeddingConfigService 全量装配——
 *  只消费记录面与 resolveRecord 面，parse 不另写一份）。 */
export function parseRecords(raw: string | undefined): EmbeddingEndpointRecord[] {
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
        ...(r.kind === "embedding" || r.kind === "classifier" ? { kind: r.kind } : {}),
        ...(typeof r.variant === "string" && r.variant !== "" ? { variant: r.variant } : {}),
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
  /** 端点清单写面互斥链（评审 F1）：set/delete/markVerified 都是「同步读
   *  KV → await 写回」的读改写序列，config.set 虽走 WriteQueue 单写但读
   *  发生在入队前——并发交错时后写基于旧快照覆盖先写（丢更新）。三写面
   *  经本链串行化：读快照必在前一笔写回落定之后。 */
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(deps: EmbeddingConfigServiceDeps) {
    this.deps = deps;
    this.now = deps.clock ?? Date.now;
  }

  /** 写面互斥入口（前手失败不断链——失败已由各写面自身收口为结果值）。 */
  private enqueueMutation<T>(op: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(op, op);
    this.mutationChain = next.catch(() => undefined);
    return next;
  }

  /** 全量端点（daemon 内——含 apiKey；勿直接进回执帧。kind 归一显式：
   *  存储缺席 = embedding，出口恒有值；写盘仍保持缺席兼容）。 */
  list(): readonly EmbeddingEndpointRecord[] {
    return parseRecords(this.deps.config.get(EMBEDDING_ENDPOINTS_KEY)).map((r) => ({
      ...r,
      kind: r.kind ?? "embedding",
    }));
  }

  /** 回执视图（凭据卫生：apiKey → hasApiKey + 尾 4 位脱敏；variant 透传——
   *  缺席 = 存量 jev 直连形态，出口不带字段）。 */
  listView(): readonly EmbeddingEndpointDto[] {
    return this.list().map((r) => ({
      id: r.id,
      name: r.name,
      baseUrl: r.baseUrl,
      model: r.model,
      kind: r.kind ?? "embedding",
      ...(r.variant !== undefined && r.variant !== "" ? { variant: r.variant } : {}),
      hasApiKey: r.apiKey !== undefined,
      ...(r.apiKey !== undefined ? { keyMasked: `····${r.apiKey.slice(-4)}` } : {}),
      verifiedAt: r.verifiedAt ?? null,
    }));
  }

  /**
   * 新增或更新（id 缺省新增；带 id 更新——name/baseUrl/model 覆盖写，
   * apiKey 空串 = 清除、缺省 = 不动）。verifiedAt 是「该端点+模型可通」的
   * 校准时间：**只在 baseUrl/model 变更时清**（换端点/换模型 → 旧校准不再代表
   * 当前配置）；name/apiKey 变更保留（apiKey 轮换不清校准——旧校准仍说明
   * 端点可达，凭据正确性下次验证/调用时暴露）。
   */
  async set(input: {
    id?: string;
    name: string;
    /** 直连型必填（variant=pi-ai 目录型免填——缺省空串）。 */
    baseUrl?: string;
    apiKey?: string;
    model: string;
    kind?: EndpointKind;
    variant?: string;
  }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    // 入参校验互斥外先行（只读面无临界区）
    return this.enqueueMutation(() => this.setInner(input));
  }

  private async setInner(input: {
    id?: string;
    name: string;
    baseUrl?: string;
    apiKey?: string;
    model: string;
    kind?: EndpointKind;
    variant?: string;
  }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const name = input.name.trim();
    const baseUrl = (input.baseUrl ?? "").trim();
    const model = input.model.trim();
    // baseUrl 按 variant 条件必填：目录型（pi-ai——目录 + provider key，不经
    // 自定义服务根）免填；直连型（jev 存量形态）仍必填。新目录 variant 接入
    // 时扩展本集合（JudgeAdapterFactory 同步登记）。
    const catalogVariants = new Set(["pi-ai"]);
    const needsBaseUrl = !(input.variant !== undefined && catalogVariants.has(input.variant));
    if (name === "" || model === "" || (needsBaseUrl && baseUrl === "")) {
      return {
        ok: false,
        error: needsBaseUrl ? "端点字段不得为空（name/baseUrl/model）" : "端点字段不得为空（name/model）",
      };
    }
    const records = [...this.list()];
    if (input.id === undefined) {
      const id = this.deps.newId?.() ?? crypto.randomUUID();
      records.push({
        id,
        name,
        baseUrl,
        model,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.variant !== undefined && input.variant !== "" ? { variant: input.variant } : {}),
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
      // kind 缺省 = 保留现值（与 apiKey 同款——编辑面不改用途不丢分类）；
      // 显式传则覆盖
      ...(input.kind !== undefined ? { kind: input.kind } : prev.kind !== undefined ? { kind: prev.kind } : {}),
      // variant 缺省 = 保留现值（与 kind 同款——编辑面不换协议变体不丢）
      ...(input.variant !== undefined && input.variant !== ""
        ? { variant: input.variant }
        : prev.variant !== undefined
          ? { variant: prev.variant }
          : {}),
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

  /** 删除（id 不存在 → error）。写面互斥内执行（读改写丢更新防护）。 */
  async delete(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.enqueueMutation(async () => {
      const records = this.list();
      const next = records.filter((r) => r.id !== id);
      if (next.length === records.length) return { ok: false as const, error: `端点不存在：${id}` };
      await this.deps.config.set(EMBEDDING_ENDPOINTS_KEY, JSON.stringify(next));
      return { ok: true as const };
    });
  }

  /**
   * 连通测试（按 kind 分叉）：embedding 端点一次短文本嵌入（回实测 dim）；
   * classifier 端点一次 noul 判定（回校准概率）。ok → verifiedAt 落盘；
   * fail → error 含定位信息（verifiedAt 不动——上次成功时间保留）。
   */
  async verify(id: string): Promise<
    | { state: "ok"; kind: "embedding"; dim: number }
    | { state: "ok"; kind: "classifier"; prob: number }
    | { state: "fail"; error: string }
  > {
    const record = this.list().find((r) => r.id === id);
    if (record === undefined) return { state: "fail", error: `端点不存在：${id}` };
    const endpointCfg: EmbeddingEndpointConfig = {
      baseUrl: record.baseUrl,
      model: record.model,
      ...(record.apiKey !== undefined ? { apiKey: record.apiKey } : {}),
    };
    try {
      if ((record.kind ?? "embedding") === "classifier") {
        // 哨兵 = 强确定性问题对：事实陈述 + 答案明确为 yes 的问题——校准
        // 判官应回高置信 ~0.95+，连通徽标显示直观（强问题弱回执 = 服务异常）。
        // 不用弱语义哨兵（"Is this a valid test query?"）——实测只回 ~0.69，
// 显示困惑值（用户实测 2026-09）。
        const judge = this.deps.createJudgeProbe({
          baseUrl: record.baseUrl,
          model: record.model,
          ...(record.apiKey !== undefined ? { apiKey: record.apiKey } : {}),
          ...(typeof record.variant === "string" && record.variant !== "" ? { variant: record.variant } : {}),
        });
        const prob = await judge.noul(
          "The number two is an even prime number.",
          "Is the number two even?",
        );
        await this.markVerified(id);
        return { state: "ok", kind: "classifier", prob };
      }
      const probe = this.deps.createProbe(endpointCfg);
      const { dim } = await probe.embed(["hi"]);
      await this.markVerified(id);
      return { state: "ok", kind: "embedding", dim };
    } catch (err) {
      return { state: "fail", error: (err as Error).message };
    }
  }

  /** verifiedAt 落盘（verify 成功路径共用）。写面互斥内执行（读改写丢更新
   *  防护——verify 的网络探测在互斥外，只有落盘段进临界区）。 */
  private markVerified(id: string): Promise<void> {
    return this.enqueueMutation(async () => {
      const records = [...this.list()];
      const idx = records.findIndex((r) => r.id === id);
      if (idx !== -1) {
        records[idx] = { ...records[idx]!, verifiedAt: this.now() };
        await this.deps.config.set(EMBEDDING_ENDPOINTS_KEY, JSON.stringify(records));
      }
    });
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
   * 设置全局默认端点（批1 embedding；D1 渐进收编泛化 kind 维度——classifier
   * 默认端点与之同构对称）。校验三拒：条目不存在 / kind 不符（判官端点不进
   * 向量语义、向量端点不进判官语义）/ 未 verify（未连通验证过的端点不当默认
   * ——默认端点是消费面单点依赖，须过连通关）。kind 缺省 = embedding（E-306
   * 契约零变化）。
   */
  async setDefault(endpointId: string, kind: EndpointKind = "embedding"): Promise<{ ok: true } | { ok: false; error: string }> {
    const record = this.resolveRecord(endpointId);
    if (record === null) return { ok: false, error: `端点不存在：${endpointId}` };
    if ((record.kind ?? "embedding") !== kind) {
      return {
        ok: false,
        error: `端点 ${record.name} 不是${kind === "classifier" ? "分类" : "向量"}端点（kind=${record.kind ?? "embedding"}）——默认端点仅限 kind=${kind}`,
      };
    }
    if (record.verifiedAt === undefined) {
      return { ok: false, error: `端点 ${record.name} 尚未通过连通验证——请先测试连通再设为默认` };
    }
    await this.deps.config.set(defaultKeyOf(kind), endpointId);
    return { ok: true };
  }

  /**
   * 默认端点解析（批1；D1 泛化 kind 参数——缺省 "embedding" = E-306 契约
   * 零变化）：全消费面唯一取用单点——记忆 / kg 向量 / 未来模块一律经本方法
   * 取 embedding 端点。未设默认 / 引用悬空（条目已删）/ 条目不完整 / 误指
   * 非本 kind 条目 → null = 「向量面不可用」，各消费面按自己的降级纪律处理
   * （记忆拒开、kg 嵌入降级 warn）。
   */
  resolveDefault(): EmbeddingEndpointConfig | null {
    return resolveDefaultConfigOf(this.list(), this.deps.config.get(EMBEDDING_DEFAULT_ENDPOINT_ID_KEY), "embedding");
  }

  /** 默认分类端点配置（D1 对称面：判官消费面兜底取用；未设/悬空/误指 → null）。 */
  resolveDefaultClassifier(): EmbeddingEndpointConfig | null {
    return resolveDefaultConfigOf(this.list(), this.deps.config.get(CLASSIFIER_DEFAULT_ENDPOINT_ID_KEY), "classifier");
  }

  /** 默认端点记录（含 id/name 等元数据；悬空/非本 kind/不完整 → null。
   *  kind 缺省 = embedding（E-306 契约零变化）。 */
  resolveDefaultRecord(kind: EndpointKind = "embedding"): EmbeddingEndpointRecord | null {
    return resolveDefaultRecordOf(this.list(), this.deps.config.get(defaultKeyOf(kind)), kind);
  }

  /** 默认分类端点记录（D1：resolveJudgeRecord 兑底层的默认档数据源——含 variant）。 */
  resolveDefaultClassifierRecord(): EmbeddingEndpointRecord | null {
    return this.resolveDefaultRecord("classifier");
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
