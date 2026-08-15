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

/** 命令信封联合（判别式：type 字段窄化） */
export type CommandEnvelope =
  | ChatSendCommand
  | ChatSteerCommand
  | ChatAbortCommand
  | SessionSubscribeCommand
  | SessionUnsubscribeCommand;

/** 命令目录常量（运行时可用；与 CommandEnvelope 联合由测试双向一致性守护） */
export const COMMAND_TYPES = [
  "chat.send",
  "chat.steer",
  "chat.abort",
  "session.subscribe",
  "session.unsubscribe",
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];
