/**
 * shared/api/commands/voice —— voice 域（试听合成、播报订阅闸门、单句流式合成与中止）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  VoiceSubscribeCommand,
  VoiceSynthesizeCommand,
  VoiceSynthesizeStopCommand,
  VoiceSynthesizeStreamCommand,
  VoiceUnsubscribeCommand,
} from "@helix/protocol";

// ── voice 族命令（语音播报批 V2 TTS）：试听合成 + 连接级订阅闸门 ────
// 回执 = voice.synthesize.result 点对点；广播经 voice.broadcast
//（仅已订阅连接收）。偏好存 localStorage（voice-pref.ts，V1 STT 同构）。

/** voice.synthesize：一次性合成（设置页试听；全局命令）。 */
export function voiceSynthesizeCommand(text: string, opts?: { voice?: string; language?: string }): VoiceSynthesizeCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "voice.synthesize",
    payload: { text, ...(opts?.voice !== undefined ? { voice: opts.voice } : {}), ...(opts?.language !== undefined ? { language: opts.language } : {}) },
  };
}

/** voice.subscribe：播报订阅（音色偏好随命令携带；全局命令）。 */
export function voiceSubscribeCommand(voice?: string): VoiceSubscribeCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "voice.subscribe",
    payload: { ...(voice !== undefined ? { voice } : {}) },
  };
}

/** voice.unsubscribe：播报退订（断连自动等效；全局命令）。 */
export function voiceUnsubscribeCommand(): VoiceUnsubscribeCommand {
  return { v: PROTOCOL_VERSION, type: "voice.unsubscribe", payload: {} };
}

// ── 流式 TTS 批（V3b-2 接线：管家回答边出边合成边播；帧回推 chunk/done/error
//    无命令回执——回退链第一级失败面）──

/** voice.synthesize.stream：单句流式合成（全局命令；utterId 连接内唯一单调）。 */
export function voiceSynthesizeStreamCommand(utterId: string, text: string, opts?: { voice?: string }): VoiceSynthesizeStreamCommand {
  return {
    v: PROTOCOL_VERSION,
    type: "voice.synthesize.stream",
    payload: { utterId, text, ...(opts?.voice !== undefined ? { voice: opts.voice } : {}) },
  };
}

/** voice.synthesize.stop：中正在途流式合成（utterId 省略 = 全部在途句）。 */
export function voiceSynthesizeStopCommand(utterId?: string): VoiceSynthesizeStopCommand {
  return { v: PROTOCOL_VERSION, type: "voice.synthesize.stop", payload: { ...(utterId !== undefined ? { utterId } : {}) } };
}
