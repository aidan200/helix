/**
 * stt 族事件（V1 云转写批，additive；新 Channel 值 "stt"——扩展纪律：新增
 * 族 = additive，不动分发器，TR-AD-18 同构口径）。
 *
 * 单帧：stt.transcribe.result = stt.transcribe 命令的点对点结果回执
 * （TR-AD-21 模式，仅发发起连接，不经 EventStream 广播）。信封 sessionId =
 * 请求会话 id（命令信封携带时回显；省略 = SYSTEM_SESSION_ID）。
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
