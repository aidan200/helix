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
 * ① 发言协调（双声重叠修复批）：本面 = 通知播报面（c），对话（a 流式/b 回执）
 * 优先——对话发言期到达的帧延后入队（不立即播，不打断对话），对话收口后
 * speech-floor resume 串行放行；对话起播/全轨停止时被 stopAndClear 收编
 * （在播 pause + 队列清空——弃播不续，最新对话优先）。
 *
 * 挂载点：App 根（全局单份——播放是连接级关注，与会话无关）。
 */
import { useEffect, useRef } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { readTtsVoicePref, readVoiceBroadcastPref, readVoiceVolumePref } from "@/shared/lib/voice-pref";
import { beginSpeechLease, endSpeechLease } from "@/shared/lib/speech-mutex";
import {
  beginNotificationPlayback,
  dialogueSpeechActive,
  endNotificationPlayback,
  micOccupied,
  registerNotificationSpeech,
} from "@/shared/lib/speech-floor";
import type { EventEnvelope } from "@helix/protocol";

/** ⑥ 租约源（播报-收音互斥：全局播报发言期暂停 duplex 收音上行——TTS 自声
 *  回灌不再污染转写；队列排空才释放，顺序播放边界零闪断）。 */
const SPEECH_LEASE_BROADCAST = "voice-broadcast";

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

  // ── 播放面：voice.broadcast → seq 去重保序 → 顺序播放（① 对话发言期延后）──
  const lastSeqRef = useRef(0);
  const pendingRef = useRef<BroadcastPayload[]>([]);
  const playingRef = useRef(false);
  /** 当前在播 Audio（① 对话收编/全轨停止的 pause 面）。 */
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
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
    // ① 对话发言期（对话 > 通知）+ 麦克占用（收音/转写期——用户说话不叠播报）
    // 延后入队——不立即播不打断对话，对话收口/麦克释放后串行放行
    //（队列保序；延前期不占播报租约）
    if (dialogueSpeechActive() || micOccupied()) return;
    const next = pendingRef.current.shift();
    if (next === undefined) {
      endSpeechLease(SPEECH_LEASE_BROADCAST); // ⑥ 队列排空 → 发言期收口（收音恢复）
      endNotificationPlayback(); // 占用释放（排空 = 播报不在场）
      return;
    }
    playingRef.current = true;
    beginSpeechLease(SPEECH_LEASE_BROADCAST); // ⑥ 发言期登记（排空/卸载释放）
    beginNotificationPlayback(); // 占用镜像：在播 → barge-in 门武装面在场
    try {
      const audio = new Audio(next.audio);
      audio.volume = Math.max(0, Math.min(1, readVoiceVolumePref() / 100));
      currentAudioRef.current = audio;
      audio.onended = () => {
        if (currentAudioRef.current === audio) currentAudioRef.current = null;
        playingRef.current = false;
        playNextRef.current();
      };
      audio.onerror = () => {
        if (currentAudioRef.current === audio) currentAudioRef.current = null;
        errorRef.current = tRef.current("chat.voice.broadcast.playFail");
        playingRef.current = false;
        playNextRef.current();
      };
      void audio.play().catch(() => {
        // 自动播放策略等拒绝：跳过该条（顺序保障继续）
        if (currentAudioRef.current === audio) currentAudioRef.current = null;
        errorRef.current = tRef.current("chat.voice.broadcast.playBlocked");
        playingRef.current = false;
        playNextRef.current();
      });
    } catch {
      currentAudioRef.current = null;
      errorRef.current = tRef.current("chat.voice.broadcast.playFail");
      playingRef.current = false;
      playNextRef.current();
    }
  };
  playNextRef.current = playNext;

  // ① 发言协调登记（speech-floor 通知面控制）：对话起播/全轨停止 → 停在播 +
  //    清队列（弃播不续——最新对话优先）；对话收口 → 串行放行延后队列。
  //    卸载注销（不留幽灵控制）；回调全走 ref（生命周期与渲染无关）。
  useEffect(() => {
    registerNotificationSpeech({
      stopAndClear: () => {
        pendingRef.current = [];
        const audio = currentAudioRef.current;
        currentAudioRef.current = null;
        playingRef.current = false;
        if (audio !== null) {
          audio.onended = null; // 弃播不续：收口回调零续链
          audio.onerror = null;
          audio.pause();
        }
        endSpeechLease(SPEECH_LEASE_BROADCAST); // ⑥ 停播收位（幂等——未占时 no-op）
        endNotificationPlayback(); // 占用释放（门武装面同步收位）
      },
      resume: () => {
        playNextRef.current();
      },
    });
    return () => registerNotificationSpeech(null);
  }, []);

  // ⑥ 卸载收位：不留幽灵租约（否则后续收音永久暂停）
  useEffect(() => () => endSpeechLease(SPEECH_LEASE_BROADCAST), []);

  return { error: errorRef.current };
}
