/**
 * 命令目录（C→S，契约 §4；architecture.md §6.3）。
 *
 * 共 5 个命令；`CommandEnvelope` 为判别式联合，daemon 侧 switch(cmd.type)
 * 分发至 ChatPort / SessionPort（接线在 T1.6）。未知 type / payload 不符的
 * 错误回执见契约 §4 末（command.unknown / command.invalid_payload）。
 */
import type { Envelope } from "./envelope";

/** chat.send 载荷：发送用户消息（新输入，ChatPort.sendMessage） */
export interface ChatSendPayload {
  text: string;
}

/** chat.steer 载荷：生成中注入消息（ChatPort.steer → SteerQueue.enqueue） */
export interface ChatSteerPayload {
  text: string;
}

/** 无载荷命令（chat.abort / session.subscribe / session.unsubscribe）的空 payload */
export type EmptyPayload = Record<string, never>;

export interface ChatSendCommand extends Envelope<ChatSendPayload> {
  type: "chat.send";
}
export interface ChatSteerCommand extends Envelope<ChatSteerPayload> {
  type: "chat.steer";
}
/** 中断当前生成（ChatPort.abort） */
export interface ChatAbortCommand extends Envelope<EmptyPayload> {
  type: "chat.abort";
}
/** 订阅会话事件流（v0 主会话默认订阅，仅保通路语义） */
export interface SessionSubscribeCommand extends Envelope<EmptyPayload> {
  type: "session.subscribe";
}
/** 退订会话事件流（同上，v0 仅保通路语义） */
export interface SessionUnsubscribeCommand extends Envelope<EmptyPayload> {
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
export interface AgentKillCommand extends Envelope<AgentKillPayload> {
  type: "agent.kill";
}
/** 订阅实例事件流（v0.1 通路语义：订阅表 + 全广播，见 PROTOCOL.md §10.6） */
export interface AgentSubscribeCommand extends Envelope<AgentSubscribePayload> {
  type: "agent.subscribe";
}
/** 退订实例事件流（v0.1 通路语义） */
export interface AgentUnsubscribeCommand extends Envelope<AgentUnsubscribePayload> {
  type: "agent.unsubscribe";
}

/** 命令信封联合（判别式：type 字段窄化；v0.1：5 → 8） */
export type CommandEnvelope =
  | ChatSendCommand
  | ChatSteerCommand
  | ChatAbortCommand
  | SessionSubscribeCommand
  | SessionUnsubscribeCommand
  | AgentKillCommand
  | AgentSubscribeCommand
  | AgentUnsubscribeCommand;

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
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];
