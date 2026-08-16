/**
 * 统一信封与 workspace 路由预留（契约 §3；architecture.md §6.3/§6.4）。
 *
 * v0 全部 C→S / S→C 消息共用一个信封形状；具体命令/事件信封
 * （commands.ts / events.ts / handshake.ts）以 `type` 字面量细分，
 * 构成判别式联合，两端 switch 窄化可用（AD-9：版本位内建）。
 */

/** 协议版本位。v0 全部信封 `v` 恒为 0；升级协议时 bump 此常量并扩类型。 */
export const PROTOCOL_VERSION = 0 as const;

/**
 * workspace 路由（AD-7 预留）。
 *
 * ⚠️ 当前为预留语义，无路由实现：daemon 全局单例、workspace 是其内部分组
 * 概念，多窗口/workspace 实现留 M3+。本迭代仅类型与信封字段位存在，
 * 不含任何 workspaceId 校验/分发行为（见 PROTOCOL.md §3）。
 */
export interface WorkspaceRoute {
  workspaceId?: string;
}

/**
 * 统一信封。`type` 在基类型上为 string；各具体命令/事件信封接口以
 * 字面量收窄 `type` 并实例化 `payload`，联合后即判别式联合。
 */
export interface Envelope<T = unknown> {
  /** 协议版本位，v0 恒为 0 */
  v: typeof PROTOCOL_VERSION;
  /** 消息目录名（如 "chat.send" / "chat.stream.delta"） */
  type: string;
  /** 消息载荷，形状由 type 决定 */
  payload: T;
  /** workspace 路由预留字段：可选；v0 无路由语义，通常不携带 */
  workspace?: WorkspaceRoute;
  /**
   * 实例归属（v0.1 新增，AD-3）：可选；**缺省 = 主实例（"main"）**。
   * 仅事件侧使用——全部 S→C 事件广播携带，前端按 id 分流投影
   * （主线进消息流；SubAgent 增量只更新卡片 streaming 行）。
   * 命令不携带实例维度（见 PROTOCOL.md §10.1）。
   */
  instanceId?: string;
}
