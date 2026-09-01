import type { CatalogSnapshot, AuthVerifyOutcome } from "../outbound/ModelCatalogPort";

/**
 * 模型与会话管理命令面（inbound，TR-AD-2：inbound = 模型与会话管理命令面；
 * 契约 C §1 全表）。WS 驱动侧只转发不决策（AG-12）；实现体 =
 * application/services/ModelService.ts。
 *
 * 错误语义（service 层抛、driving 层映射回执；结果帧微批
 * 已登记专用错误码，契约 C §4 与实现对齐）：
 * - ModelNotFoundError → model_not_found；ProviderNotFoundError →
 *   provider_not_found（catalog/catalog_refresh 通路另用 catalog_unreachable）；
 * - SessionNotFoundError（SessionRegistry 既有）：会话不存在 → session.not_found。
 */
export interface ModelPort {
  /** model.set：运行期切换（per-session，下一 turn 生效；成功即触发 model.changed 广播）。 */
  setModel(sessionId: string, model: string): Promise<ModelSetOutcome>;
  /** thinking.set：会话推理强度覆盖（thinking 批①；per-session，下一 turn 生效；成功即触发 thinking.changed 广播）。 */
  setThinking(sessionId: string, level: string): Promise<ThinkingSetOutcome>;
  /** model.get：会话当前模型 + 与全局默认的关系。 */
  getModel(sessionId: string): Promise<ModelInfo>;
  /** model.catalog：合并目录读面（4h 缓存口径）。 */
  catalog(): Promise<CatalogSnapshot>;
  /** model.catalog_refresh：强制拉 pi.dev（失败保缓存降级，degraded 列明细）。 */
  catalogRefresh(): Promise<CatalogSnapshot & { degraded: readonly string[] }>;
  /** model.set_default：全局默认（新会话继承；既有会话不跟随）。 */
  setDefault(model: string): Promise<{ previous: string }>;
  /** model.set_thinking_default（R7 全局兜底批）：全局默认推理强度；null = 清除。 */
  setThinkingDefault(level: string | null): Promise<{ previous: string | null }>;
  /** model.get_default：SQLite 读面（builtin 兜底）。 */
  getDefault(): { model: string; thinkingDefault: string | null };
  /** auth.list：provider 全集 × 凭据状态（脱敏）。 */
  authList(): Promise<AuthProviderStatus[]>;
  /** auth.set_key：写 auth.json（空值协议层拒绝前的 daemon 侧防线）。 */
  authSetKey(providerId: string, apiKey: string): Promise<{ keyMasked: string }>;
  /** auth.delete_key：删凭据（幂等）。 */
  authDeleteKey(providerId: string): Promise<void>;
  /** auth.verify：连通最小请求（不缓存，每次真实请求）。 */
  authVerify(providerId: string): Promise<AuthVerifyOutcome>;
}

/** model.set 成功结果（即时 ack；model.changed 随后广播）。 */
export interface ModelSetOutcome {
  readonly accepted: true;
  readonly effective: "next-turn";
  readonly previous: string;
}

/** thinking.set 成功结果（thinking.changed 广播同源载荷；override/effective 双位，契约 ①）。 */
export interface ThinkingSetOutcome {
  /** 会话覆盖意图；null = 无覆盖。 */
  readonly override: string | null;
  /** 引擎按当前模型能力解析的生效档；null = 全链不支持（不传参，provider 默认）。 */
  readonly effective: string | null;
}

/** model.get 结果（契约 C §1.1：isDefault = 会话模型是否即全局默认）。 */
export interface ModelInfo {
  readonly model: string;
  readonly isDefault: boolean;
  readonly defaultModel: string;
}

/** auth.list 条目（协议 AuthProviderInfo 的 domain 侧镜像；verifiedAt/
 * verifyStatus 不落 daemon（verify 不缓存，前端三态自管理）→ 恒缺省）。 */
export interface AuthProviderStatus {
  readonly providerId: string;
  readonly configured: boolean;
  readonly keyMasked?: string;
}
