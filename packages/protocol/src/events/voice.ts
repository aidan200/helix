/**
 * voice 族事件（V2 TTS 播报批，additive；新 Channel 值 "voice"——扩展纪律：
 * 新增族 = additive，不动分发器，"stt" 族先例同构口径）。
 *
 * 两帧：
 * - voice.broadcast = 播报广播（daemon→已订阅连接；系统级语义但按连接级
 *   voice 订阅表过滤投递——task.changed 路由先例同构）；
 * - voice.synthesize.result = voice.synthesize 命令的点对点结果回执
 *   （TR-AD-21 模式，仅发发起连接，不经 EventStream 广播）。
 */
import type { EventFrame } from "../envelope";

/** 触发播报的领域事件判别（V2 播报集合 = 终态族；开始类默认不播——噪声控制）。 */
export type VoiceBroadcastKind = "agent.completed" | "agent.failed" | "agent.killed";

/** voice.broadcast payload：合成产物广播（一帧一播报）。 */
export interface VoiceBroadcastPayload {
  /** 触发事件类型（V2 播报集合三值）。 */
  kind: VoiceBroadcastKind;
  /** 触发实例 id（agent-<串>）。 */
  agentId: string;
  /** 播报文本（模板直出产物——closure 摘要已截断；含溢出合并提示）。 */
  text: string;
  /** 合成音频：base64 data URL（`data:audio/wav;base64,…`——与图片附件/STT 上行同构线格式）。 */
  audio: string;
  /** 实际执行 TTS provider id（如 "dashscope"——设置页排查用）。 */
  provider: string;
  /** 实际音色（合成回显）。 */
  voice?: string;
  /** 连接内单调顺序号（1 起；shell 侧顺序保障/丢帧检测面）。 */
  seq: number;
  /** 溢出合并提示（队列满丢最旧的条数；>0 时 text 已附「另有 N 条已跳过」）。 */
  droppedCount?: number;
}

/** voice.broadcast：播报广播帧（channel = "voice" 新族；仅发已订阅连接）。 */
export interface VoiceBroadcastEvent extends EventFrame<VoiceBroadcastPayload> {
  channel?: "voice";
  type: "voice.broadcast";
}

/**
 * voice.synthesize.result payload：两判别——ok = 音频回执（设置页试听播放）；
 * error = 业务失败（key 未配/provider 不可达/文本非法等，reason 含引导）。
 */
export type VoiceSynthesizeResultPayload =
  | {
      status: "ok";
      /** 合成音频：base64 data URL。 */
      audio: string;
      /** 实际执行 provider id。 */
      provider: string;
      /** 实际音色（请求回显或 daemon 默认）。 */
      voice?: string;
    }
  | {
      status: "error";
      /** 失败原因（含引导，如 key 未配时指向设置页录入路径）。 */
      reason: string;
    };

/** voice.synthesize.result：一次性合成点对点回执（channel = "voice"）。 */
export interface VoiceSynthesizeResultEvent extends EventFrame<VoiceSynthesizeResultPayload> {
  channel?: "voice";
  type: "voice.synthesize.result";
}
