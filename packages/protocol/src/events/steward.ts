/**
 * steward 族事件（V2.5 文本管家批，additive；新 Channel 值 "steward"——
 * 扩展纪律：新增族 = additive，不动分发器，"voice" 族先例同构口径）。
 *
 * 四帧（§5.3 ①②层口径：feed 文本行模板直出不进 LLM）：
 * - steward.ask.delta = steward.ask 流式增量帧（V2.5 体验批 additive：
 *   文本生成段逐 chunk 下发，前端聚合——终态以 steward.ask.result 为权威
 *   覆盖；工具执行段静默不发）；
 * - steward.ask.result = steward.ask 点对点回执（三判别：answer 直答 /
 *   confirm_required 确认闸请求 / error 业务失败）；
 * - steward.confirm.result = steward.confirm 点对点回执（ok/error）；
 * - steward.feed = 事件 feed 文本行广播（daemon→已订阅连接——agent 生命
 *   周期事件模板直出，复用事件流零新事件源）；
 * - steward.config.result = 设置读写回执（enabled + model 现态）。
 */
import type { EventFrame } from "../envelope";

/** steward.ask.result payload：三判别——answer = 直答文本；confirm_required =
 *  确认闸请求（写注入唯一原语 propose_send 的回执形态，未确认零执行）；
 *  error = 业务失败（开关关/模型未配/key 缺失/循环超限等，reason 含引导）。 */
export type StewardAskResultPayload =
  | {
      status: "answer";
      /** 管家回答文本（快问快答直答产物）。 */
      text: string;
    }
  | {
      status: "confirm_required";
      /** 待确认动作 id（steward.confirm 消费；一次性）。 */
      actionId: string;
      /** 递话目标实例（agent-<串>）。 */
      agentId: string;
      /** 递话内容（注入前用户可全文过目——确认闸透明性）。 */
      message: string;
    }
  | {
      status: "error";
      /** 失败原因（含引导，如开关关时指向设置页开启路径）。 */
      reason: string;
    };

/** steward.ask.result：管家对话回执（channel = "steward"）。 */
export interface StewardAskResultEvent extends EventFrame<StewardAskResultPayload> {
  channel?: "steward";
  type: "steward.ask.result";
}

/** steward.ask.delta payload：流式增量帧（V2.5 体验批 additive）。语义 =
 *  增量 delta + 前端聚合（与主聊天 chat.stream.delta 同构——非累计文本，
 *  帧序即到达序，WS 有序传输下前端直接拼接）；终态以 steward.ask.result
 *  为权威（answer.text 全量覆盖聚合缓冲，delta 不落盘不持久化）。 */
export interface StewardAskDeltaPayload {
  /** 本帧增量文本（非累计——前端聚合）。 */
  delta: string;
  /** 单次 ask 内单调顺序号（1 起；排序/丢帧检测面，不携带 messageId——
   *  管家面板单飞在途（askInFlight 互斥），无多轮并发歧义）。 */
  seq: number;
}

/** steward.ask.delta：管家回答流式增量帧（channel = "steward"；仅文本
 *  生成段逐 chunk 下发，工具执行段静默不发；点对点发发起 ask 的连接）。 */
export interface StewardAskDeltaEvent extends EventFrame<StewardAskDeltaPayload> {
  channel?: "steward";
  type: "steward.ask.delta";
}

/** steward.confirm.result payload：两判别——ok = 已执行（detail 含投递结果
 *  说明）；error = 业务失败（actionId 未知/已消费或注入通道拒绝）。 */
export type StewardConfirmResultPayload =
  | {
      status: "ok";
      /** 递话目标实例回显。 */
      agentId: string;
      /** 注入通道回执说明（SendOutcome.detail——已投递/拒绝原因）。 */
      detail: string;
    }
  | {
      status: "error";
      /** 失败原因。 */
      reason: string;
    };

/** steward.confirm.result：确认闸执行回执（channel = "steward"）。 */
export interface StewardConfirmResultEvent extends EventFrame<StewardConfirmResultPayload> {
  channel?: "steward";
  type: "steward.confirm.result";
}

/** 触发 feed 行的领域事件判别（agent 生命周期事件流子集）。 */
export type StewardFeedKind =
  | "agent.spawned"
  | "agent.completed"
  | "agent.failed"
  | "agent.killed"
  | "agent.parked"
  | "agent.resumed";

/** steward.feed payload：事件 feed 文本行（一帧一行；模板直出不进 LLM）。 */
export interface StewardFeedPayload {
  /** 触发事件类型（agent 生命周期子集）。 */
  kind: StewardFeedKind;
  /** 触发实例 id（agent-<串>）。 */
  agentId: string;
  /** feed 文本行（中文模板直出；closure 摘要已截断）。 */
  text: string;
  /** 连接内单调顺序号（1 起；shell 侧顺序保障/丢帧检测面）。 */
  seq: number;
}

/** steward.feed：feed 文本行广播帧（channel = "steward"；仅发已订阅连接）。 */
export interface StewardFeedEvent extends EventFrame<StewardFeedPayload> {
  channel?: "steward";
  type: "steward.feed";
}

/** steward.config.result payload：设置现态（读/写共用回执形态）。 */
export interface StewardConfigResultPayload {
  /** 管家开关现态（默认 false）。 */
  enabled: boolean;
  /** 模型槽位现值（"provider/model-id"；未设置 = daemon 默认 flash 级模型）。 */
  model: string;
}

/** steward.config.result：设置读写回执（channel = "steward"；点对点）。 */
export interface StewardConfigResultEvent extends EventFrame<StewardConfigResultPayload> {
  channel?: "steward";
  type: "steward.config.result";
}
