/**
 * 命令目录（C→S，契约 §4 + 契约 B §1 / 契约 C §1；architecture.md §6.3）。
 *
 * 共 21 个命令：v0 5 + v0.1 3 + v0.2 新增 13（session 族 3 / model 族 6 /
 * auth 族 4）。`CommandEnvelope` 为判别式联合，daemon 侧 switch(cmd.type)
 * 分发。会话作用域命令的信封 sessionId 必填（AD-4 路由位，类型层可选、
 * 客户端纪律保证）；全局命令（session.list / model.set_default /
 * model.get_default / model.catalog* / auth.*）省略。未知 type / payload
 * 不符的错误回执见 §7（command.unknown / command.invalid_payload；
 * v0.2 已登记未实现命令 → command.unimplemented，T2.x 前占位回执）。
 */
import type { CommandFrame } from "./envelope";
import type { AuthProviderInfo } from "./types/auth";
import type { CatalogModel } from "./types/model";
import type { EntryDto, SessionMeta } from "./types/session";

/** chat.send 载荷：发送用户消息（新输入，ChatPort.sendMessage） */
export interface ChatSendPayload {
  text: string;
}

/** chat.steer 载荷：生成中注入消息（ChatPort.steer → SteerQueue.enqueue） */
export interface ChatSteerPayload {
  text: string;
}

/** 无载荷命令的空 payload */
export type EmptyPayload = Record<string, never>;

export interface ChatSendCommand extends CommandFrame<ChatSendPayload> {
  type: "chat.send";
}
export interface ChatSteerCommand extends CommandFrame<ChatSteerPayload> {
  type: "chat.steer";
}
/** 中断当前生成（ChatPort.abort） */
export interface ChatAbortCommand extends CommandFrame<EmptyPayload> {
  type: "chat.abort";
}
/**
 * 订阅会话事件流。v0.2 升级语义（契约 B §1.2，AD-4）：从「连接级全量广播
 * 开关」升级为「按会话订阅」——**信封 sessionId 必填**，连接订阅某会话后
 * 只收该会话（+系统级）事件帧；payload 保持空（路由位在信封）。
 */
export interface SessionSubscribeCommand extends CommandFrame<EmptyPayload> {
  type: "session.subscribe";
}
/** 退订会话事件流（v0 通路语义保留；per-session 语义随 T2.1 定稿） */
export interface SessionUnsubscribeCommand extends CommandFrame<EmptyPayload> {
  type: "session.unsubscribe";
}

// ── v0.1 新增（契约 protocol-v0.1.md §4；AD-7 手动终止权在用户） ──

/** agent.kill 载荷：用户终止实例（抽屉 kill 两步确认后发送） */
export interface AgentKillPayload {
  agentId: string;
}
/** agent.subscribe 载荷：订阅实例全流（v0.1 通路语义，不做事件过滤） */
export interface AgentSubscribePayload {
  agentId: string;
}
/** agent.unsubscribe 载荷：退订实例全流（同上） */
export interface AgentUnsubscribePayload {
  agentId: string;
}

/** 用户终止实例；正常路径回执 agent.killed 事件（单一终态） */
export interface AgentKillCommand extends CommandFrame<AgentKillPayload> {
  type: "agent.kill";
}
/** 订阅实例事件流（v0.1 通路语义：订阅表 + 全广播，见 PROTOCOL.md §10.6） */
export interface AgentSubscribeCommand extends CommandFrame<AgentSubscribePayload> {
  type: "agent.subscribe";
}
/** 退订实例事件流（v0.1 通路语义） */
export interface AgentUnsubscribeCommand extends CommandFrame<AgentUnsubscribePayload> {
  type: "agent.unsubscribe";
}

// ── v0.2 新增：session 族（契约 B §1；AD-1 / AD-4） ──

/** 会话清单条目响应（session.list 结果载荷；SessionMeta 同源） */
export interface SessionListResult {
  /** 按 lastActivityAt 降序 */
  sessions: SessionMeta[];
}

/** session.list 载荷：全局命令（信封 sessionId 省略） */
export interface SessionListCommand extends CommandFrame<EmptyPayload> {
  type: "session.list";
}

/**
 * session.loadHistory 载荷（AD-1 分页回溯）：信封 sessionId 必填；
 * 返回 beforeEntryId 之前的更早历史（时间升序）。
 */
export interface SessionLoadHistoryPayload {
  /** 游标：当前最早 entry id；首页 = 尾窗最早 entry id（快照 DTO 下发） */
  beforeEntryId: string;
  /** 缺省 50（G-1 分页大小），上限 200（防滥用） */
  limit?: number;
}

/** session.loadHistory 结果载荷 */
export interface SessionLoadHistoryResult {
  entries: EntryDto[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface SessionLoadHistoryCommand
  extends CommandFrame<SessionLoadHistoryPayload> {
  type: "session.loadHistory";
}

/**
 * session.delete 载荷（Q-4④）：信封 sessionId 必填；payload 空（路由位在
 * 信封）。daemon 顺序硬约束：取消全部执行完成 → 删库 → 注册表移除 →
 * 广播 session.list_changed（T2.2 落地）。
 */
export interface SessionDeleteCommand extends CommandFrame<EmptyPayload> {
  type: "session.delete";
}

// ── v0.2 新增：model 族（契约 C §1；AD-2，G-6 定名） ──

/** model.set 结果载荷（即时 ack；model.changed 随后广播） */
export interface ModelSetResult {
  accepted: true;
  effective: "next-turn";
  previous: string;
}

/** model.set 载荷：运行期切换（P-3，F(3.3).2）——信封 sessionId 必填（per-session），下一 turn 生效 */
export interface ModelSetPayload {
  /** "provider/model-id" 完整 id */
  model: string;
}
export interface ModelSetCommand extends CommandFrame<ModelSetPayload> {
  type: "model.set";
}

/** model.get 结果载荷 */
export interface ModelGetResult {
  model: string;
  isDefault: boolean;
  defaultModel: string;
}

/** model.get 载荷：信封 sessionId 必填（per-session） */
export interface ModelGetCommand extends CommandFrame<EmptyPayload> {
  type: "model.get";
}

/** 目录结果载荷（model.catalog / model.catalog_refresh 共用） */
export interface ModelCatalogResult {
  models: CatalogModel[];
  refreshedAt: number;
  source: "cache" | "builtin" | "remote";
}

/** model.catalog 载荷：全局命令（4h 缓存口径，T2.3 落地） */
export interface ModelCatalogCommand extends CommandFrame<EmptyPayload> {
  type: "model.catalog";
}

/** model.catalog_refresh 载荷：绕过 4h 缓存强制拉 pi.dev（失败降级 builtin，响应含说明） */
export interface ModelCatalogRefreshCommand extends CommandFrame<EmptyPayload> {
  type: "model.catalog_refresh";
}

/** model.set_default 结果载荷 */
export interface ModelSetDefaultResult {
  previous: string;
}

/** model.set_default 载荷：全局默认值（无信封 sessionId；SQLite 读面，T2.3 落地） */
export interface ModelSetDefaultPayload {
  model: string;
}
export interface ModelSetDefaultCommand extends CommandFrame<ModelSetDefaultPayload> {
  type: "model.set_default";
}

/** model.get_default 结果载荷 */
export interface ModelGetDefaultResult {
  model: string;
}

/** model.get_default 载荷：全局命令 */
export interface ModelGetDefaultCommand extends CommandFrame<EmptyPayload> {
  type: "model.get_default";
}

// ── v0.2 新增：auth 管理族（契约 C §1.3；G-6 定名） ──

/** auth.list 结果载荷 */
export interface AuthListResult {
  providers: AuthProviderInfo[];
}

/** auth.list 载荷：全局命令 */
export interface AuthListCommand extends CommandFrame<EmptyPayload> {
  type: "auth.list";
}

/** auth.set_key 结果载荷 */
export interface AuthSetKeyResult {
  keyMasked: string;
}

/** auth.set_key 载荷：daemon 写 ~/.helix/auth.json（0600 + 文件锁）；空 apiKey = 协议层 error */
export interface AuthSetKeyPayload {
  providerId: string;
  apiKey: string;
}
export interface AuthSetKeyCommand extends CommandFrame<AuthSetKeyPayload> {
  type: "auth.set_key";
}

/** auth.delete_key 载荷 */
export interface AuthDeleteKeyPayload {
  providerId: string;
}
export interface AuthDeleteKeyCommand extends CommandFrame<AuthDeleteKeyPayload> {
  type: "auth.delete_key";
}

/** auth.verify 结果载荷：不缓存，每次真实请求（provider 最小请求探活） */
export type AuthVerifyResult =
  | { status: "ok"; latencyMs: number }
  | { status: "fail"; reason: string };

/** auth.verify 载荷 */
export interface AuthVerifyPayload {
  providerId: string;
}
export interface AuthVerifyCommand extends CommandFrame<AuthVerifyPayload> {
  type: "auth.verify";
}

/** 命令信封联合（判别式：type 字段窄化；v0.2：8 → 21） */
export type CommandEnvelope =
  | ChatSendCommand
  | ChatSteerCommand
  | ChatAbortCommand
  | SessionSubscribeCommand
  | SessionUnsubscribeCommand
  | AgentKillCommand
  | AgentSubscribeCommand
  | AgentUnsubscribeCommand
  | SessionListCommand
  | SessionLoadHistoryCommand
  | SessionDeleteCommand
  | ModelSetCommand
  | ModelGetCommand
  | ModelCatalogCommand
  | ModelCatalogRefreshCommand
  | ModelSetDefaultCommand
  | ModelGetDefaultCommand
  | AuthListCommand
  | AuthSetKeyCommand
  | AuthDeleteKeyCommand
  | AuthVerifyCommand;

/** 命令目录常量（运行时可用；与 CommandEnvelope 联合由测试双向一致性守护） */
export const COMMAND_TYPES = [
  "chat.send",
  "chat.steer",
  "chat.abort",
  "session.subscribe",
  "session.unsubscribe",
  "agent.kill",
  "agent.subscribe",
  "agent.unsubscribe",
  "session.list",
  "session.loadHistory",
  "session.delete",
  "model.set",
  "model.get",
  "model.catalog",
  "model.catalog_refresh",
  "model.set_default",
  "model.get_default",
  "auth.list",
  "auth.set_key",
  "auth.delete_key",
  "auth.verify",
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];
