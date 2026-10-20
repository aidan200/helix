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
import { useCallback, useEffect, useRef, useState } from "react";
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
  setNotificationQueue,
} from "@/shared/lib/speech-floor";
import type { EventEnvelope } from "@helix/protocol";

/** ⑥ 租约源（播报-收音互斥：全局播报发言期暂停 duplex 收音上行——TTS 自声
 *  回灌不再污染转写；队列排空才释放，顺序播放边界零闪断）。 */
const SPEECH_LEASE_BROADCAST = "voice-broadcast";

/** 播报面失败事件（诊断 + 交代面）：message = 人读文案，seq = 失败序号。 */
export interface VoiceBroadcastError {
  readonly message: string;
  /** 单调失败序号：同文案连续失败也换对象身份（消费方 effect 依赖可再次交代）。 */
  readonly seq: number;
}

export interface VoiceBroadcast {
  /** 最近一次播报面失败（播放失败/自动播放被拒/订阅发送未发出）；null = 无。
   *  实态（useState）——旧实现写 ref 无重渲，唯一调用方又丢弃返回值，是死面。 */
  readonly error: VoiceBroadcastError | null;
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
  const [error, setError] = useState<VoiceBroadcastError | null>(null);
  const errSeqRef = useRef(0);
  /** 失败入账（诊断 + 交代面）：序号单调递增——同文案连发也能被消费方再次弹出。 */
  const fail = useCallback((message: string): void => {
    errSeqRef.current += 1;
    setError({ message, seq: errSeqRef.current });
  }, []);

  // ── 订阅闸门：连接就绪 + 偏好开 → subscribe（音色偏好随发）；偏好关 →
  //    unsubscribe（幂等；daemon 断连自动清位，重连由 conn 依赖重放）。
  //    命令面缺席（测试 mock/未接 Provider 形态）防御跳过。──
  const conn = topology?.active?.conn;
  useEffect(() => {
    if (conn !== "connected") return;
    if (typeof sendVoiceSubscribe !== "function" || typeof sendVoiceUnsubscribe !== "function") return;
    // send 返回值必消费（TR-84：=== false 严格判 = 断线窗口帧未发出）——订阅
    // 未发出则播报面整体不生效，经 error 面交代（不再静默等到下次重连）
    if (readVoiceBroadcastPref()) {
      if (sendVoiceSubscribe(readTtsVoicePref()) === false) fail(t("chat.modelsConfig.sendFailToast"));
    } else if (sendVoiceUnsubscribe() === false) {
      fail(t("chat.modelsConfig.sendFailToast"));
    }
  }, [conn, sendVoiceSubscribe, sendVoiceUnsubscribe, fail, t]);

  // ── 播放面：voice.broadcast → seq 去重保序 → 顺序播放（① 对话发言期延后）──
  const lastSeqRef = useRef(0);  const pendingRef = useRef<BroadcastPayload[]>([]);
  const playingRef = useRef(false);
  /** 当前在播 Audio（① 对话收编/全轨停止的 pause 面）。 */
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const playNextRef = useRef<() => void>(() => undefined);
  /** 队列深度入账（TTS 队列计数双轨收口）：排队 + 在播 → 镜像推（同深去重）。 */
  const syncQueueDepth = (): void => {
    setNotificationQueue(pendingRef.current.length + (playingRef.current ? 1 : 0));
  };

  // ── seq 高水位世代复位：daemon 广播 seq 是进程级计数（重启归零），
  //    客户端 lastSeqRef 高水位不跨连接世代——conn 离开 connected 即复位，
  //    否则重连后新 seq 从 1 起步全部命中「<= 高水位」被当重复静默丢弃，
  //    直到 seq 追平重启前高水位才恢复（高水位越高丢得越久）。同世代内
  //    去重保护不变（重复/回退帧照丢）。──
  useEffect(() => {
    if (conn === "connected") return;
    lastSeqRef.current = 0;
  }, [conn]);

  useEffect(() => {
    if (subscribeVoiceFrames === undefined) return;
    return subscribeVoiceFrames((event: EventEnvelope) => {
      if (event.type !== "voice.broadcast") return;
      const payload = event.payload as unknown as BroadcastPayload;
      // seq 去重（单调递增；重复/回退丢弃）
      if (typeof payload.seq !== "number" || payload.seq <= lastSeqRef.current) return;
      lastSeqRef.current = payload.seq;
      pendingRef.current.push(payload);
      syncQueueDepth();
      playNextRef.current();
    });
  }, [subscribeVoiceFrames]);

  const playNext = (): void => {
    if (playingRef.current) return;
    // ① 对话发言期（对话 > 通知）+ 麦克占用（收音/转写期——用户说话不叠播报）
    // 延后入队——不立即播不打断对话，对话收口/麦克释放后串行放行
    //（队列保序；延前期不占播报租约）
    if (dialogueSpeechActive() || micOccupied()) {
      syncQueueDepth(); // 延后驻留：深度 = 排队数（角标可见）
      return;
    }
    const next = pendingRef.current.shift();
    if (next === undefined) {
      endSpeechLease(SPEECH_LEASE_BROADCAST); // ⑥ 队列排空 → 发言期收口（收音恢复）
      endNotificationPlayback(); // 占用释放（排空 = 播报不在场）
      syncQueueDepth(); // 排空归零
      return;
    }
    playingRef.current = true;
    syncQueueDepth(); // 在播 +1 入账
    beginSpeechLease(SPEECH_LEASE_BROADCAST); // ⑥ 发言期登记（排空/卸载释放）
    beginNotificationPlayback(); // 占用镜像：在播 → barge-in 门武装面在场
    try {
      const audio = new Audio(next.audio);
      audio.volume = Math.max(0, Math.min(1, readVoiceVolumePref() / 100));
      currentAudioRef.current = audio;
      // 完成回调统一世代闸（中危 F3a）：非当前代（currentAudioRef 已换新或被
      // stopAndClear 收编）的迟到回调直接丢弃——同一坏帧 error + play.reject
      // 双触发时第二次回调不得把在播新条目的 playingRef 拍成 false 并再续一链
      //（否则两音频并发双播、顺序播放不变量破坏）；stopAndClear 的 pause 使
      // play() promise 迟到 reject 同理不拍飞在播标志。
      audio.onended = () => {
        if (currentAudioRef.current !== audio) return;
        currentAudioRef.current = null;
        playingRef.current = false;
        playNextRef.current();
      };
      audio.onerror = () => {
        if (currentAudioRef.current !== audio) return;
        currentAudioRef.current = null;
        fail(t("chat.voice.broadcast.playFail"));
        playingRef.current = false;
        playNextRef.current();
      };
      void audio.play().catch(() => {
        // 自动播放策略等拒绝：跳过该条（顺序保障继续）
        if (currentAudioRef.current !== audio) return;
        currentAudioRef.current = null;
        fail(t("chat.voice.broadcast.playBlocked"));
        playingRef.current = false;
        playNextRef.current();
      });
    } catch {
      currentAudioRef.current = null;
      fail(t("chat.voice.broadcast.playFail"));
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
        syncQueueDepth(); // 清队列即归零（角标同步收位）
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

  return { error };
}
