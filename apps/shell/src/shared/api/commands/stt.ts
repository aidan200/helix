/**
 * shared/api/commands/stt —— stt 域（一次性转写 + 流式转写开流/音频块/收口/中止）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  SttStreamChunkCommand,
  SttStreamFinishCommand,
  SttStreamStartCommand,
  SttStreamStopCommand,
  SttTranscribeCommand,
} from "@helix/protocol";

/**
 * stt.transcribe：一次性音频转写（语音输入批 V1；回执 =
 * stt.transcribe.result 点对点两判别）。会话作用域可选：信封 sessionId
 * 携带时 daemon 组装会话词汇表（P1 源）+ 归属自查；省略 = 裸转写。
 */
export function sttTranscribeCommand(
  audio: string,
  opts?: { language?: string; provider?: string },
  sessionId?: string,
): SttTranscribeCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "stt.transcribe",
    ...(sessionId !== undefined ? { sessionId } : {}),
    payload: { audio, ...(opts?.language !== undefined ? { language: opts.language } : {}), ...(opts?.provider !== undefined ? { provider: opts.provider } : {}) },
  };
}

// ── stt.stream 族命令（V3b-1 流式转写）：开流/音频块上行/收口/中止 ──
// 回执/帧 = stt.stream.started / .interim / .final 点对点（streamId 门控）。

/** stt.stream.start：开流（语言提示可选；provider 缺省 = daemon 自动选择）。 */
export function sttStreamStartCommand(opts?: { language?: string; provider?: string }): SttStreamStartCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "stt.stream.start",
    payload: {
      ...(opts?.language !== undefined ? { language: opts.language } : {}),
      ...(opts?.provider !== undefined ? { provider: opts.provider } : {}),
    },
  };
}

/** stt.stream.chunk：音频块上行（base64 PCM 16k mono ~100ms；无 ack）。 */
export function sttStreamChunkCommand(audio: string): SttStreamChunkCommand {
  return { v: PROTOCOL_VERSION, type: "stt.stream.chunk", payload: { audio } };
}

/** stt.stream.finish：正常收口（终帧经 stt.stream.final）。 */
export function sttStreamFinishCommand(): SttStreamFinishCommand {
  return { v: PROTOCOL_VERSION, type: "stt.stream.finish", payload: {} };
}

/** stt.stream.stop：中止（不期终帧；面板卸载/废弃流）。 */
export function sttStreamStopCommand(): SttStreamStopCommand {
  return { v: PROTOCOL_VERSION, type: "stt.stream.stop", payload: {} };
}
