/**
 * useStewardVoiceSpeechOut —— 出声面单例装配（P2 体量门 ④ 轻拆批：从
 * useStewardVoice.ts 机械迁出，构造体逐字未改）。
 *
 * StewardSpeechOut 单例构造（senders ref 转发——发送器随连接态重绑）+ 迟到
 * 兜底自愈判决（onLateFallback：单飞门控位与轮次 id 同点写）。构造点固定在
 * 组合根原位置调用——useRef 单例与逐渲染 sender 重绑语义不变。
 */
import { useRef } from "react";
import { readTtsVoicePref, readVoiceVolumePref } from "@/shared/lib/voice-pref";
import type { SpeechPlayerFactory } from "@/shared/lib/pcm-player";
import { recordSpeechDiag } from "./speech-diag";
import { StewardSpeechOut } from "./steward-speech-out";

/** 出声面单例装配的注入面（连接态发送器 + 单飞门控位/轮次 ref 由组合根持有）。 */
export interface StewardVoiceSpeechOutDeps {
  readonly sendVoiceSynthesize?: (text: string, opts?: { voice?: string; language?: string }) => boolean;
  readonly sendVoiceSynthesizeStream?: (utterId: string, text: string, opts?: { voice?: string }) => boolean;
  readonly sendVoiceSynthesizeStop?: (utterId?: string) => boolean;
  readonly createPlayer?: SpeechPlayerFactory;
  readonly speakPendingRef: { current: boolean };
  readonly speakRoundRef: { current: number };
  readonly answerRoundRef: { current: number };
}

export function useStewardVoiceSpeechOut(deps: StewardVoiceSpeechOutDeps): StewardSpeechOut {
  const {
    sendVoiceSynthesize,
    sendVoiceSynthesizeStream,
    sendVoiceSynthesizeStop,
    createPlayer,
    speakPendingRef,
    speakRoundRef,
    answerRoundRef,
  } = deps;
  // 发送面 ref 转发（speechOut 单例构造——发送器随连接态重绑，streamSenders 先例）
  const speechSendersRef = useRef({
    sendStream: sendVoiceSynthesizeStream,
    sendStopFor: (utterId: string) => sendVoiceSynthesizeStop?.(utterId) ?? false,
    sendStopAll: () => sendVoiceSynthesizeStop?.() ?? false,
    sendFallback: sendVoiceSynthesize,
  });
  speechSendersRef.current = {
    sendStream: sendVoiceSynthesizeStream,
    sendStopFor: (utterId: string) => sendVoiceSynthesizeStop?.(utterId) ?? false,
    sendStopAll: () => sendVoiceSynthesizeStop?.() ?? false,
    sendFallback: sendVoiceSynthesize,
  };
  const speechOutRef = useRef<StewardSpeechOut | null>(null);
  if (speechOutRef.current === null) {
    speechOutRef.current = new StewardSpeechOut({
      senders: {
        sendStream: (utterId, text, opts) => speechSendersRef.current.sendStream?.(utterId, text, opts) ?? false,
        sendStopFor: (utterId) => speechSendersRef.current.sendStopFor(utterId),
        sendStopAll: () => speechSendersRef.current.sendStopAll(),
        sendFallback: (text, opts) => speechSendersRef.current.sendFallback?.(text, opts) ?? false,
      },
      voiceProvider: () => readTtsVoicePref(),
      // 兜底盲区修复：结果先行判 stream 后链死自愈回退——消费端开单飞门
      //（与 answerResult fallback 判决同径：回执到达才播放，轮次校验防旧轮覆盖）
      onLateFallback: () => {
        recordSpeechDiag("fallback.late-gate", "speakPending=on");
        speakPendingRef.current = true;
        speakRoundRef.current = answerRoundRef.current;
      },
      ...(createPlayer !== undefined
        ? {
            createPlayer: () => {
              const player = createPlayer();
              player.setVolume(Math.max(0, Math.min(1, readVoiceVolumePref() / 100)));
              return player;
            },
          }
        : {}),
    });
  }
  return speechOutRef.current;
}
