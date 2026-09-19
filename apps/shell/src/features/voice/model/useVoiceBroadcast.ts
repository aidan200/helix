/**
 * useVoiceBroadcast —— V2 TTS 播报播放钩子（语音播报批 V2）。
 *
 * 链路（设计 §5.3 ①②层消费端）：连接就绪（conn=connected）+ 偏好开
 * （localStorage helix.voice.broadcast，默认 off——不偷偷发音频花钱）→ 发
 * voice.subscribe {voice}（daemon 连接级闸门登记 + 音色偏好上报；断连
 * daemon 自动清位，重连由本 effect 连接态依赖重放——session.subscribe
 * 重放图先例）；voice.broadcast 帧（仅已订阅连接收）→ seq 去重保序
 * （重复/回退帧丢弃）→ new Audio(data URL) 顺序播放（音量 =
 * helix.voice.volume 偏好；onended 驱动逐条）。
 *
 * 挂载点：App 根（全局单份——播放是连接级关注，与会话无关）。
 */
import { useEffect, useRef } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { readTtsVoicePref, readVoiceBroadcastPref, readVoiceVolumePref } from "@/shared/lib/voice-pref";
import type { EventEnvelope } from "@helix/protocol";

export interface VoiceBroadcast {
  /** 最近一次播放失败原因（诊断面；null = 无）。 */
  readonly error: string | null;
}

interface BroadcastPayload {
  seq: number;
  audio: string;
}

export function useVoiceBroadcast(): VoiceBroadcast {
  const { t } = useI18n();
  const { topology, sendVoiceSubscribe, sendVoiceUnsubscribe, subscribeVoiceFrames } = useSession() as {
    topology?: { active?: { conn?: string } };
    sendVoiceSubscribe?: (voice?: string) => boolean;
    sendVoiceUnsubscribe?: () => boolean;
    subscribeVoiceFrames?: (listener: (e: EventEnvelope) => void) => () => void;
  };
  const errorRef = useRef<string | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  // ── 订阅闸门：连接就绪 + 偏好开 → subscribe（音色偏好随发）；偏好关 →
  //    unsubscribe（幂等；daemon 断连自动清位，重连由 conn 依赖重放）。
  //    命令面缺席（测试 mock/未接 Provider 形态）防御跳过。──
  const conn = topology?.active?.conn;
  useEffect(() => {
    if (conn !== "connected") return;
    if (typeof sendVoiceSubscribe !== "function" || typeof sendVoiceUnsubscribe !== "function") return;
    if (readVoiceBroadcastPref()) {
      sendVoiceSubscribe(readTtsVoicePref());
    } else {
      sendVoiceUnsubscribe();
    }
  }, [conn, sendVoiceSubscribe, sendVoiceUnsubscribe]);

  // ── 播放面：voice.broadcast → seq 去重保序 → 顺序播放 ──
  const lastSeqRef = useRef(0);
  const pendingRef = useRef<BroadcastPayload[]>([]);
  const playingRef = useRef(false);
  const playNextRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (subscribeVoiceFrames === undefined) return;
    return subscribeVoiceFrames((event: EventEnvelope) => {
      if (event.type !== "voice.broadcast") return;
      const payload = event.payload as unknown as BroadcastPayload;
      // seq 去重（单调递增；重复/回退丢弃）
      if (typeof payload.seq !== "number" || payload.seq <= lastSeqRef.current) return;
      lastSeqRef.current = payload.seq;
      pendingRef.current.push(payload);
      playNextRef.current();
    });
  }, [subscribeVoiceFrames]);

  const playNext = (): void => {
    if (playingRef.current) return;
    const next = pendingRef.current.shift();
    if (next === undefined) return;
    playingRef.current = true;
    try {
      const audio = new Audio(next.audio);
      audio.volume = Math.max(0, Math.min(1, readVoiceVolumePref() / 100));
      audio.onended = () => {
        playingRef.current = false;
        playNextRef.current();
      };
      audio.onerror = () => {
        errorRef.current = tRef.current("chat.voice.broadcast.playFail");
        playingRef.current = false;
        playNextRef.current();
      };
      void audio.play().catch(() => {
        // 自动播放策略等拒绝：跳过该条（顺序保障继续）
        errorRef.current = tRef.current("chat.voice.broadcast.playBlocked");
        playingRef.current = false;
        playNextRef.current();
      });
    } catch {
      errorRef.current = tRef.current("chat.voice.broadcast.playFail");
      playingRef.current = false;
      playNextRef.current();
    }
  };
  playNextRef.current = playNext;

  return { error: errorRef.current };
}
