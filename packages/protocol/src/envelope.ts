/**
 * 帧信封（契约 A §1；目录文档见同包 PROTOCOL.md；v0.2 登记：iter-20260816-6q6f T1.2）。
 *
 * v0.2 起帧信封分型：C→S 命令信封（CommandFrame）与 S→C 事件信封（EventFrame）。
 * 具体命令/事件信封（commands.ts / events.ts）以 `type`（+事件侧 `channel`）
 * 字面量细分构成判别式联合，两端 switch 窄化可用。
 *
 * 兼容红线（契约 A §5，信封兼容读）：新增字段（sessionId / channel）在类型层
 * 全部可选——v0/v0.1 形态帧（不携带新字段、v 位为 0）在新类型下零修改合法；
 * v0.2 daemon 运行时对 S→C 事件必发 sessionId/channel（T2.x 落地），payload
 * 语义与 v0/v0.1 完全一致（AD-3 取代边界）。
 */

/** 协议版本位。v0.11 帧 `v` 恒为 "0.11"；handshake 以此协商（旧客户端 fail-fast 拒绝）。 */
export const PROTOCOL_VERSION = "0.11" as const;

/**
 * 帧版本位取值域："0.11" = 当前批（v0.11）帧；`0` = v0/v0.1 历史帧（v0.1 未
 * bump 版本位，全部历史帧与既有测试/剧本字面量为 0——信封兼容读的类型面）。
 * v0.10→v0.11 为单仓同发一步替换（Q-1c：版本位是批次集合标记非协商位），
 * 仓内无 v0.10 帧存量。
 * handshake 的 HelloPayload.protocolVersion 不取联合（严格 "0.11" 单值）。
 */
export type FrameVersion = 0 | typeof PROTOCOL_VERSION;

/**
 * 会话无关系统级事件的 sessionId 占位（契约 A §3）。
 * connection.*（notification 通道）事件归属系统而非具体会话，v0.2 daemon
 * 下发时以本常量填充信封 sessionId（T2.x 落地）。
 */
export const SYSTEM_SESSION_ID = "__system__" as const;

/**
 * 事件类型学通道（契约 A §2；八族数据/会话通道 + notification 系统通道）。
 *
 * chat / agent / thinking / usage / compaction 为 v0/v0.1 既有五族归位；
 * session / model 为 v0.2 新增两族；trace 为 v0.4 新增族（trace.query.result
 * 点对点结果帧，iter-20260819-erio T2.1）；web 为 v0.7 新增族（T4 联网
 * 状态图标：web.status/web.stop 点对点结果帧 + web.status.changed 广播）；
 * kg 为 kg 批新增族（iter-20260825-11fo T5.3：P-1 六命令的点对点结果帧
 * 回执；O-6 轮询裁决零推送事件，本族无广播事件）；
 * interaction 为占位族（仅类型定义，
 * 无事件挂靠）；notification 承载会话无关系统事件（connection.*，
 * sessionId = SYSTEM_SESSION_ID）。每事件所属 channel 在 events.ts 以
 * 判别字面量登记（EVENT_CHANNELS 为运行时目录，daemon 下发侧消费）。
 * 扩展纪律：新增族 = additive，不动分发器（TR-AD-18 同构口径）。
 */
export type Channel =
  | "chat"
  | "agent"
  | "thinking"
  | "usage"
  | "compaction"
  | "session"
  | "model"
  | "trace"
  | "web"
  | "kg"
  | "workspace"
  | "interaction"
  | "notification";

/**
 * workspace 路由（AD-7 预留）。
 *
 * ⚠️ 当前为预留语义，无路由实现：daemon 全局单例、workspace 是其内部分组
 * 概念，多窗口/workspace 实现留 M3+。仅类型与信封字段位存在，
 * 不含任何 workspaceId 校验/分发行为（见 PROTOCOL.md §3）。
 */
export interface WorkspaceRoute {
  workspaceId?: string;
}

/**
 * C→S 命令信封基型（契约 A §1.1）。具体命令信封以 `type` 字面量收窄并
 * 实例化 `payload`（commands.ts），联合后即判别式联合。
 */
export interface CommandFrame<T = unknown> {
  /** 协议版本位（FrameVersion：当前批帧 "0.11"；0 = v0/v0.1 历史帧兼容读） */
  v: FrameVersion;
  /** 消息目录名（如 "chat.send" / "session.loadHistory"） */
  type: string;
  /** 消息载荷，形状由 type 决定 */
  payload: T;
  /**
   * 会话路由位（v0.2 新增，AD-4）：**会话作用域命令必填**（chat.* /
   * session.loadHistory / session.delete / session.subscribe / model.set /
   * model.get——daemon 按此路由到目标会话）；全局命令（session.list /
   * model.set_default / model.get_default / auth.*）省略。类型层可选
   * （v0/v0.1 命令帧不带仍合法），必填纪律由 v0.2 客户端保证。
   */
  sessionId?: string;
  /** 实例归属预留位：命令侧不消费（agentId 在 payload 内；PROTOCOL-CHANGELOG.md §10.1） */
  instanceId?: string;
  /** workspace 路由预留字段：可选；v0.2 仍不消费 */
  workspace?: WorkspaceRoute;
}

/**
 * S→C 事件信封基型（v0.2 统一事件信封，契约 A §1.2；AD-3/AD-4）。
 * 统一信封即帧信封本身（帧 = 信封）：前端 dispatcher 按 `sessionId` 路由 →
 * 按 `channel` 分族 → 按 `type` 交消费者注册表。
 */
export interface EventFrame<T = unknown> {
  /** 协议版本位（FrameVersion：当前批帧 "0.11"；0 = v0/v0.1 历史帧兼容读） */
  v: FrameVersion;
  /**
   * 事件归属会话（v0.2 新增，AD-4）：S→C 运行时必发——会话无关系统事件
   * （connection.*）以 SYSTEM_SESSION_ID 占位。类型层可选（信封兼容红线：
   * v0/v0.1 帧不带仍合法，消费端缺省 = 单会话语义）；v0.2 daemon 下发
   * 侧必填纪律由 T2.x 落地。
   */
  sessionId?: string;
  /**
   * 实例归属（v0.1 起）：可选。**T10 起写侧全实例显式携带**（main 同为
   * `agent-<唯一串>`，PROTOCOL-CHANGELOG.md §10.1/§17.11）；**缺省 = legacy 主实例
   * （读侧推断，兼容历史事件/历史快照；写侧不再产出）**。
   * payload 兼容红线优先（v0.1 通道族 payload 内嵌 instanceId 并存保留），
   * 信封位为路由权威（契约 A §1.2）。
   */
  instanceId?: string;
  /**
   * 事件类型学通道（v0.2 新增，AD-3 八族+系统通道）：每事件在 events.ts
   * 以字面量登记所属族（判别字段）。类型层可选（信封兼容红线）；v0.2
   * daemon 下发侧必发（EVENT_CHANNELS 单点登记，T2.x 消费）。
   */
  channel?: Channel;
  /** 消息目录名（如 "chat.stream.delta" / "session.list_changed"） */
  type: string;
  /** 消息载荷，形状由 type 决定；语义与 v0/v0.1 完全一致（AD-3 取代边界） */
  payload: T;
}
