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
  /**
   * daemon 新鲜度自检（stale-indicator 批，additive；PROTOCOL-CHANGELOG.md
   * §17.15）：握手时 daemon 自报进程启动时刻与源码新鲜度——stale = true
   * 表示 daemon 源码 mtime 晚于进程启动（daemon 在跑旧代码，前端连接状态区
   * 显示「建议重启」琥珀 chip）。缺省 = 未携带（旧 daemon / 打包态源码目录
   * 不存在——读侧按新鲜处理，行为不变）。
   */
  daemonFreshness?: DaemonFreshnessDto;
}

/**
 * daemon 源码新鲜度（stale-indicator 批，additive；connection.welcome 携带）：
 * daemon 握手时对 apps/daemon/src + packages/protocol/src 的 mtime 自检结论。
 * 扫描只在握手时同步算一次（几百文件 stat 量级）；不做 watch / 轮询。
 */
export interface DaemonFreshnessDto {
  /** daemon 进程启动时刻（epoch ms；前端设置页人话时间显示源） */
  startedAt: number;
  /** true = 源码 mtime 晚于进程启动（daemon 代码已更新，建议重启） */
  stale: boolean;
}

/** connection.error：握手拒绝 / 命令错误回执（notification 通道） */
export interface ConnectionErrorPayload {
  code: ErrorCode;
  /**
   * 人读错误说明。**命令类错误的 message 带机器可解析尾缀「（命令 <type>）」**
   * （TR-145 契约）：daemon WsServerAdapter.commandError 单点拼接，shell 侧
   * 按该尾缀做跨命令归因过滤（如 TracePage 只认本族错误帧；无尾缀帧容忍为
   * 旧 daemon）。改尾缀格式/语言/去掉尾缀 = 破坏该归因且无编译期信号——
   * 必须同步 shell 归因正则（两端同动）。
   */
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
