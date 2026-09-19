/**
 * stt 族事件（V1 云转写批 + V3b-1 流式转写批，additive；新 Channel 值
 * "stt"——扩展纪律：新增族 = additive，不动分发器，TR-AD-18 同构口径）。
 *
 * 单帧：stt.transcribe.result = stt.transcribe 命令的点对点结果回执
 * （TR-AD-21 模式，仅发发起连接，不经 EventStream 广播）。信封 sessionId =
 * 请求会话 id（命令信封携带时回显；省略 = SYSTEM_SESSION_ID）。
 *
 * 流式三帧（V3b-1）：stt.stream.started（开流回执两判别）/
 * stt.stream.interim（实时转写中间帧——text 已确认前缀 + stash 易变后缀
 * + prior 已完结句串联）/ stt.stream.final（终帧两判别——ok = 终帧全文
 * 直接喂下游，error = 流失败 shell 回落非流式链路）。全点对点仅发发起
 * 连接；同流帧按到达序下发（streamId = 单飞门控判别位，丢弃他流/旧流帧）。
 */
import type { EventFrame } from "../envelope";

/**
 * stt.transcribe.result payload：两判别——ok = 转写文本回填草稿；
 * error = 业务失败（provider 不可达/key 未配/载荷无法解码等，reason 含
 * 引导说明；非协议面错误——payload/命令级错误仍走 commandError 通道）。
 */
export type SttTranscribeResultPayload =
  | {
      status: "ok";
      /** 转写文本（草稿回填源；用户确认后发送）。 */
      text: string;
      /** 实际执行 provider id（如 "dashscope" / "siliconflow"——设置页排查用）。 */
      provider: string;
      /** 语言回显（provider 检测结果；不可得时缺席）。 */
      language?: string;
    }
  | {
      status: "error";
      /** 失败原因（含引导，如 key 未配时指向设置页录入路径）。 */
      reason: string;
    };

/** stt.transcribe.result：转写结果点对点回执（channel = "stt" 新族）。 */
export interface SttTranscribeResultEvent extends EventFrame<SttTranscribeResultPayload> {
  channel?: "stt";
  type: "stt.transcribe.result";
}

/**
 * stt.stream.started payload：两判别——ok = 上游流就绪（streamId 后续帧
 * 携带；daemon 在上游 session 确认后才回 ok——此后 chunk 即刻透传）；
 * error = 开流失败（key 未配/provider 不支持流式/上游握手失败——shell
 * 静默回落非流式链路）。
 */
export type SttStreamStartedPayload =
  | {
      status: "ok";
      /** 流 id（daemon 生成；interim/final 帧回携——单飞门控判别位）。 */
      streamId: string;
      /** 实际执行 provider id（如 "dashscope"）。 */
      provider: string;
      /** 上游流式模型名（如 "qwen3-asr-flash-realtime"——排查面）。 */
      model: string;
    }
  | {
      status: "error";
      /** 失败原因（含引导；无 streamId——流未建立）。 */
      reason: string;
    };

/** stt.stream.started：开流回执（点对点；channel = "stt"）。 */
export interface SttStreamStartedEvent extends EventFrame<SttStreamStartedPayload> {
  channel?: "stt";
  type: "stt.stream.started";
}

/**
 * stt.stream.interim payload：实时转写中间帧（上游高频帧透传）。
 * 显示文本 = prior + text + stash（已完结句串联 + 当前句已确认前缀 +
 * 易变后缀）；text 与 stash 均可能为空串（句首/确认中）。
 */
export interface SttStreamInterimPayload {
  /** 流 id（单飞门控判别位）。 */
  streamId: string;
  /** 已完结句串联（上游逐句 completed 文本依序拼接；首句前为空串）。 */
  prior: string;
  /** 当前句已确认前缀（上游 text 字段——不会再变更）。 */
  text: string;
  /** 当前句易变后缀（上游 stash 字段——可能被后续帧修正）。 */
  stash: string;
}

/** stt.stream.interim：实时转写中间帧（点对点；仅 listening 态有意义）。 */
export interface SttStreamInterimEvent extends EventFrame<SttStreamInterimPayload> {
  channel?: "stt";
  type: "stt.stream.interim";
}

/**
 * stt.stream.final payload：两判别——ok = 终帧全文（= 全部 completed 句
 * 串联；可能为空串——全程静音/无有效语音，shell 按丢弃处理）；error =
 * 流失败（上游断开/超时——shell 回落非流式链路重转写）。final 到达即流
 * 关闭（后续无帧）。
 */
export type SttStreamFinalPayload =
  | {
      status: "ok";
      streamId: string;
      /** 终帧全文（多句串联）。 */
      text: string;
      provider: string;
    }
  | {
      status: "error";
      streamId: string;
      reason: string;
    };

/** stt.stream.final：终帧（点对点；final 后流关闭）。 */
export interface SttStreamFinalEvent extends EventFrame<SttStreamFinalPayload> {
  channel?: "stt";
  type: "stt.stream.final";
}
