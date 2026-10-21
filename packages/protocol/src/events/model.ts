import type { EventFrame } from "../envelope";
import type {
  AuthCredentialType,
  AuthNotifyPayload,
  AuthPromptPayload,
  AuthProviderInfo,
} from "../types/auth";
import type { CatalogModel } from "../types/model";

// ── v0.2 新增 payload：session/model 族（契约 B §2 / 契约 C §2） ──

/** model.changed：运行期换模生效广播（v0.2 新增，契约 C §2.1；下一 turn 生效） */
export interface ModelChangedPayload {
  /** 信封 sessionId 同步携带；payload 内嵌一份供消费者免读信封 */
  sessionId: string;
  /** 新模型（"provider/model-id"，下一 turn 生效） */
  model: string;
  previous: string;
  effective: "next-turn";
}

// ── v0.2 新增 payload：model/auth 命令结果族（契约 C §1/§2.2；T2.3-result-frames 微批） ──

/** model.get.result：会话当前模型 + 与全局默认关系（契约 C §1.1） */
export interface ModelGetResultPayload {
  model: string;
  /** 会话模型是否即全局默认 */
  isDefault: boolean;
  defaultModel: string;
}

/** model.catalog.result：合并目录快照（契约 C §1.2；4h 缓存口径） */
export interface ModelCatalogResultPayload {
  models: CatalogModel[];
  /** 上次远端核对时间（epoch ms；无 overlay 历史 → 0） */
  refreshedAt: number;
  /** 快照数据来源：远端确认 / 落盘缓存 / 纯 builtin */
  source: "cache" | "builtin" | "remote";
}

/**
 * model.catalog_refresh.result：强制刷新快照 + 降级说明（契约 C §1.2）。
 * degraded = 拉取失败的 provider 明细（全部成功 = 空数组；快照仍可用）。
 */
export interface ModelCatalogRefreshResultPayload extends ModelCatalogResultPayload {
  degraded: string[];
}

/** model.set_default.result：全局默认变更回执（previous = 变更前默认） */
export interface ModelSetDefaultResultPayload {
  previous: string;
}

/** model.set_thinking_default.result（R7）：全局默认推理强度回执（previous = 变更前；null = 未配） */
export interface ModelSetThinkingDefaultResultPayload {
  previous: string | null;
}

/** model.get_default.result：全局默认读面（SQLite，builtin 兜底） */
export interface ModelGetDefaultResultPayload {
  model: string;
  /**
   * 全局默认推理强度（R7 additive）：null = 未配置（各 agent 未配槽位时默认关）；
   * 旧 daemon 不携带（可选字段，前端缺省按 null 处理）。
   */
  thinkingDefault?: string | null;
}

/** auth.list.result：provider 全集 × 凭据状态（脱敏，P-4 列表行数据） */
export interface AuthListResultPayload {
  providers: AuthProviderInfo[];
}

/** auth.set_key.result：写入回执（掩码形式，如 `····7f3a`） */
export interface AuthSetKeyResultPayload {
  keyMasked: string;
}

/** auth.delete_key.result：成功回执即帧本身（契约 C §1.3 响应 `{}`，无数据体） */
export type AuthDeleteKeyResultPayload = Record<string, never>;

/** auth.verify.result：连通验证（不缓存，每次真实请求；fail 携带原因） */
export type AuthVerifyResultPayload =
  | { status: "ok"; latencyMs: number }
  | { status: "fail"; reason: string };

/** auth.login.result：登录成功回执（订阅登录批；凭据类型二值以 AuthCredentialType 为单源） */
export interface AuthLoginResultPayload {
  providerId: string;
  credentialType: AuthCredentialType;
}

/** auth.logout.result：登出回执（无数据体） */
export type AuthLogoutResultPayload = Record<string, never>;

/** auth.prompt：登录交互 prompt 推送（requestId 关联 auth.respond 回填；select 型回填 option id） */
export interface AuthPromptEventPayload {
  providerId: string;
  requestId: string;
  prompt: AuthPromptPayload;
}

/** auth.notify：登录交互 notify 推送（auth_url/device_code/progress/info——镜像 pi-ai AuthEvent） */
export interface AuthNotifyEventPayload {
  providerId: string;
  event: AuthNotifyPayload;
}

/** auth.changed：凭据变更广播（登录/登出/录入/删除后；daemon 级全局，订阅无关） */
export interface AuthChangedPayload {
  providerId: string;
  /** 变更后凭据类型；缺省 = 已无凭据（登出/删除） */
  credentialType?: AuthCredentialType;
}

// ── v0.2 新增信封（契约 B §2 / 契约 C §2） ──

export interface ModelChangedEvent extends EventFrame<ModelChangedPayload> {
  channel?: "model";
  type: "model.changed";
}

// ── v0.2 新增信封：model/auth 命令结果帧（契约 C §2.2；T2.3-result-frames 微批）──

/**
 * model.get.result：会话当前模型命令结果（点对点回执）。
 * 信封 sessionId = 目标会话 id（与 session.loadHistory.result 同构：
 * per-session 命令）；仅发给发起 model.get 命令的连接，不经广播。
 */
export interface ModelGetResultEvent extends EventFrame<ModelGetResultPayload> {
  channel?: "model";
  type: "model.get.result";
}
/**
 * model.catalog.result：目录快照命令结果（点对点回执）。信封 sessionId =
 * SYSTEM_SESSION_ID（全局命令，无会话归属；与 session.list.result 同构）。
 */
export interface ModelCatalogResultEvent extends EventFrame<ModelCatalogResultPayload> {
  channel?: "model";
  type: "model.catalog.result";
}
/** model.catalog_refresh.result：强制刷新快照 + degraded 降级明细（点对点回执；全局命令） */
export interface ModelCatalogRefreshResultEvent
  extends EventFrame<ModelCatalogRefreshResultPayload> {
  channel?: "model";
  type: "model.catalog_refresh.result";
}
/** model.set_default.result：全局默认变更回执（点对点；全局命令） */
export interface ModelSetDefaultResultEvent extends EventFrame<ModelSetDefaultResultPayload> {
  channel?: "model";
  type: "model.set_default.result";
}
/** model.set_thinking_default.result 帧（R7） */
export interface ModelSetThinkingDefaultResultEvent extends EventFrame<ModelSetThinkingDefaultResultPayload> {
  channel?: "model";
  type: "model.set_thinking_default.result";
}
/** model.get_default.result：全局默认读面回执（点对点；全局命令） */
export interface ModelGetDefaultResultEvent extends EventFrame<ModelGetDefaultResultPayload> {
  channel?: "model";
  type: "model.get_default.result";
}
/** auth.list.result：provider 凭据状态清单回执（点对点；全局命令） */
export interface AuthListResultEvent extends EventFrame<AuthListResultPayload> {
  channel?: "model";
  type: "auth.list.result";
}
/** auth.set_key.result：写入回执（keyMasked 掩码；点对点；全局命令） */
export interface AuthSetKeyResultEvent extends EventFrame<AuthSetKeyResultPayload> {
  channel?: "model";
  type: "auth.set_key.result";
}
/** auth.delete_key.result：删除回执（无数据体；点对点；全局命令） */
export interface AuthDeleteKeyResultEvent extends EventFrame<AuthDeleteKeyResultPayload> {
  channel?: "model";
  type: "auth.delete_key.result";
}
/** auth.verify.result：连通验证回执（点对点；全局命令；fail 为正常结果非 error） */
export interface AuthVerifyResultEvent extends EventFrame<AuthVerifyResultPayload> {
  channel?: "model";
  type: "auth.verify.result";
}
/** auth.login.result：登录成功回执（点对点；全局命令） */
export interface AuthLoginResultEvent extends EventFrame<AuthLoginResultPayload> {
  channel?: "model";
  type: "auth.login.result";
}
/** auth.logout.result：登出回执（无数据体；点对点；全局命令） */
export interface AuthLogoutResultEvent extends EventFrame<AuthLogoutResultPayload> {
  channel?: "model";
  type: "auth.logout.result";
}
/** auth.prompt：登录交互 prompt 推送（点对点发起连接；全局命令） */
export interface AuthPromptEvent extends EventFrame<AuthPromptEventPayload> {
  channel?: "model";
  type: "auth.prompt";
}
/** auth.notify：登录交互 notify 推送（点对点发起连接；全局命令） */
export interface AuthNotifyEvent extends EventFrame<AuthNotifyEventPayload> {
  channel?: "model";
  type: "auth.notify";
}
/** auth.changed：凭据变更广播（daemon 级全局；与 broadcastWebStatusChanged 同构，订阅无关） */
export interface AuthChangedEvent extends EventFrame<AuthChangedPayload> {
  channel?: "model";
  type: "auth.changed";
}
