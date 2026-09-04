import type { EventFrame } from "../envelope";
import type { AgentStateDto } from "../types/agent";
import type { ErrorCode } from "../types/error";

// ── payload ──────────────────────────────────────────────────

/** connection.welcome：握手通过回执（notification 通道，sessionId = SYSTEM_SESSION_ID） */
export interface ConnectionWelcomePayload {
  sessionId: string;
  model: string;
  agentState: AgentStateDto;
  /**
   * 草稿标记（T4，additive，TR-AD-23①）：true = 当前会话是零条目内存草稿
   * （未落盘、不进清单）；握手不 attach 不推快照，前端按草稿态显示；
   * 缺省/旧客户端忽略本字段行为不变（现状握手：attach + 立即快照）。
   */
  draft?: boolean;
  /**
   * 当前模式面（P1 会话模式框架 T2，additive；PROTOCOL-CHANGELOG.md §18）：daemon
   * 当前会话的模式——草稿握手 = 草稿暂存模式（前端 header 模式选择器
   * 恢复基准）；已建会话握手 = session.mode 定格值。与 draft 字段同构
   * （同为「当前会话」投影）；缺省 = 未携带（旧 daemon 兼容，读侧按
   * "default" 兜底）。
   */
  mode?: string;
}

/** connection.error：握手拒绝 / 命令错误回执（notification 通道） */
export interface ConnectionErrorPayload {
  code: ErrorCode;
  message: string;
}

// ── 信封（判别式联合成员；channel 字面量 = 事件类型学登记，契约 A §2） ──

export interface ConnectionWelcomeEvent
  extends EventFrame<ConnectionWelcomePayload> {
  /** notification：会话无关系统事件（信封 sessionId = SYSTEM_SESSION_ID） */
  channel?: "notification";
  type: "connection.welcome";
}
export interface ConnectionErrorEvent extends EventFrame<ConnectionErrorPayload> {
  /** notification：会话无关系统事件（信封 sessionId = SYSTEM_SESSION_ID） */
  channel?: "notification";
  type: "connection.error";
}
