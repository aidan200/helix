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

/**
 * 管家工作记忆记录（A1 工作记忆批，additive）——完整记录形态：
 * thinking / toolCall / toolResult / user / assistant 全形态（用户裁决：
 * 全精度进 LLM 上下文与工作记忆；屏幕完整显示，耳朵只听 assistant 结论）。
 *
 * 同源链路：KV steward_dialog（daemon）↔ steward.history.result 回执 ↔
 * 面板 UI 渲染 ↔ LLM 窗口重建——UI 显示的 = LLM 记得的（消灭撒谎错位）。
 * - assistant.thinking 携 signature（provider 不透明回传凭据——Anthropic 式
 *   最严约束：多轮 thinking 块须携签名回传）；
 * - toolCall/toolResult 按 id 配对（UI 工具行 pending → ✓ 两态）。
 */
export type StewardHistoryRecord =
  | {
      kind: "user";
      /** 用户输入全文。 */
      text: string;
      /** 落笔时间戳（ms；TTL/排序面）。 */
      at: number;
    }
  | {
      kind: "assistant";
      /** 回答文本（可缺席——纯工具轮/纯思考轮）。 */
      text?: string;
      /** 本轮 thinking 块（全精度；signature = provider 回传凭据）。 */
      thinking?: { text: string; signature?: string };
      /** 本轮工具调用（可缺席——纯文本轮）。 */
      toolCall?: { id: string; name: string; args: Record<string, unknown> };
      at: number;
    }
  | {
      kind: "toolResult";
      /** 配对工具调用 id。 */
      toolCallId: string;
      /** 工具名（回显面）。 */
      name: string;
      /** 工具结果文本（LLM 回灌原文）。 */
      text: string;
      at: number;
    };

/** steward.history.result payload：工作记忆回放（records 全形态数组；
 *  clear 后回空数组）。 */
export interface StewardHistoryResultPayload {
  /** 完整记录（时序；daemon KV 同源镜像）。 */
  records: readonly StewardHistoryRecord[];
}

/** steward.history.result：工作记忆读/清回执（channel = "steward"；点对点）。 */
export interface StewardHistoryResultEvent extends EventFrame<StewardHistoryResultPayload> {
  channel?: "steward";
  type: "steward.history.result";
}

/** steward.tool payload（A1 过程可见批，additive）：工具执行两相帧——
 *  start（name + 参数摘要）/ end（结果摘要）；单次 ask 内 seq 单调（1 起）
 *  与 ask.delta 同口径，仅发发起 ask 的连接（点对点）。 */
export type StewardToolPayload =
  | {
      phase: "start";
      /** 工具名（如 list_tasks）。 */
      name: string;
      /** 参数摘要（JSON 短串；防御性截断）。 */
      argsSummary: string;
      seq: number;
    }
  | {
      phase: "end";
      /** 工具名（与 start 帧配对）。 */
      name: string;
      /** 结果摘要（截断短串——展开详情的摘要面）。 */
      resultSummary: string;
      seq: number;
    };

/** steward.tool：工具过程帧（channel = "steward"；点对点——屏幕通道）。 */
export interface StewardToolEvent extends EventFrame<StewardToolPayload> {
  channel?: "steward";
  type: "steward.tool";
}

/** steward.thinking payload（A1 过程可见批，additive）：thinking 段级帧——
 *  一个完成态 thinking 块一帧（探明定案：折叠显示用段级粒度，token 级
 *  delta 高频帧无增益）；仅发发起 ask 的连接（点对点）。 */
export interface StewardThinkingPayload {
  /** 完整 thinking 块文本（段级全量——非增量）。 */
  text: string;
  seq: number;
}

/** steward.thinking：thinking 过程帧（channel = "steward"；点对点——屏幕通道）。 */
export interface StewardThinkingEvent extends EventFrame<StewardThinkingPayload> {
  channel?: "steward";
  type: "steward.thinking";
}
