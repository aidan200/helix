/**
 * useStewardVoice —— 管家语音模式组合钩子（V3a「跟管家说话」闭环）。
 *
 * 组合三件（纯逻辑面全在 steward-voice-machine.ts——AG-14 分离）：
 * - useSteward（同 slice）：ask/confirm/feed/config 全面透传——面板数据面
 *   单实例单点（TR-169 族防自激：本钩子不再开第二份订阅闸门 effect）；
 * - shared/lib/useVoiceInput（V3a 下移，DI 注入）：录音 + VAD + 转写——
 *   转写回执单飞门控在他消费面（Composer）与本面互不串台；
 * - TTS 朗读层（本文件内联）：steward.ask.result answer 终态 ×
 *   shouldSpeakReply money 闸 → mdToSpeechText → voice.synthesize 点对点
 *   （设置页试听同款，协议零新增）→ 回执 ok 面板 Audio 播放；静音钮
 *   stopSpeaking 一键停读；面板卸载（Dock 关）即停。
 *
 * 语音链：点击 mic（idle→listening）→ VAD 静音 ~1.8s/点击强制停 →
 * 转写（transcribing）→ onTranscript 一次性喂 ask（asking，流式回答）→
 * answer 终态 → 朗读（speaking）→ 播毕回 idle。
 *
 * 异常回退（纯面 planTranscript）：ask 发送失败（未连接）→ 转写文本回填
 * voiceDraft（面板采纳进输入框——文本态可重试，零静默丢话）；转写失败 →
 * useVoiceInput error 面（面板 toast，Composer 同构）。
 *
 * 双模（mode）：面板打开默认 voice；mic 不可用（unsupported）自动回退
 * text。切 text = 停朗读 + 在录即强制停（转写链照常走完，answer 不朗读
 * ——money 闸按 result 时点模式判）。LISTEN_SURFACE 多听众扇出是官方
 * 形态（Set fan-out）：本钩子与 useSteward 各自订阅 steward 帧，各取所需。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { useVoiceInput } from "@/shared/lib/useVoiceInput";
import { readTtsVoicePref, readVoiceVolumePref, readStewardSpeakReplyPref } from "@/shared/lib/voice-pref";
import type { EventEnvelope } from "@helix/protocol";
import { useSteward, type StewardMessage, type StewardPendingAction } from "./useSteward";
import {
  deriveStewardVoicePhase,
  shouldSpeakReply,
  mdToSpeechText,
  planTranscript,
  type StewardInputMode,
  type StewardVoicePhase,
} from "./steward-voice-machine";

export interface UseStewardVoice {
  // ── useSteward 整面透传（面板数据面不二开）──
  readonly messages: readonly StewardMessage[];
  readonly streamingText: string | null;
  readonly pending: StewardPendingAction | null;
  readonly feed: ReturnType<typeof useSteward>["feed"];
  readonly askInFlight: boolean;
  readonly config: ReturnType<typeof useSteward>["config"];
  ask(text: string): boolean;
  confirmPending(): boolean;
  dismissPending(): void;
  // ── 双模（互斥；打开默认 voice）──
  readonly mode: StewardInputMode;
  setMode(mode: StewardInputMode): void;
  // ── 语音面 ──
  /** 面板唯一阶段事实源（idle/listening/transcribing/asking/speaking/unsupported）。 */
  readonly phase: StewardVoicePhase;
  /** 实时电平 0..1（listening 波形可视化数据源；他态恒 0）。 */
  readonly level: number;
  /** TTS 朗读中（speaking 态同义布尔——静音钮显隐）。 */
  readonly speaking: boolean;
  /** 转写/录音侧最近失败原因（toast 消费；null = 无）。 */
  readonly voiceError: string | null;
  /** ask 发送失败的转写文本（面板采纳进输入框后 clearVoiceDraft 清位）。 */
  readonly voiceDraft: string | null;
  /** 点击 mic 开始说话（新一轮：先停上轮朗读）。 */
  startListening(): Promise<void>;
  /** 录音中点击 = 强制停（转写链照常）。 */
  stopListening(): void;
  /** 静音钮：一键停读（在播音频即停；无播报 no-op）。 */
  stopSpeaking(): void;
  /** 面板采纳转写回填后清位。 */
  clearVoiceDraft(): void;
}

export function useStewardVoice(open: boolean): UseStewardVoice {
  const { sendSttTranscribe, subscribeSttFrames, sendVoiceSynthesize, subscribeVoiceFrames, subscribeStewardFrames } =
    useSession() as {
      sendSttTranscribe?: (audio: string, opts?: { language?: string; provider?: string }) => boolean;
      subscribeSttFrames?: (listener: (e: EventEnvelope) => void) => () => void;
      sendVoiceSynthesize?: (text: string, opts?: { voice?: string; language?: string }) => boolean;
      subscribeVoiceFrames?: (listener: (e: EventEnvelope) => void) => () => void;
      subscribeStewardFrames?: (listener: (e: EventEnvelope) => void) => () => void;
    };
  const steward = useSteward(open);

  // ── 双模（打开默认语音模式——brief 口径；unsupported 自动回退文本态）──
  const [mode, setModeState] = useState<StewardInputMode>("voice");

  // ── TTS 朗读层（点对点合成 + 面板播放 + 静音停读）──
  const [speaking, setSpeaking] = useState(false);
  const speakPendingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopSpeaking = useCallback(() => {
    speakPendingRef.current = false;
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio !== null) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }
    setSpeaking(false);
  }, []);

  // 面板卸载（Dock 关/路由外弹层退场）即停读——不留幽灵音频
  useEffect(
    () => () => {
      speakPendingRef.current = false;
      const audio = audioRef.current;
      audioRef.current = null;
      if (audio !== null) {
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
      }
    },
    [],
  );

  // 回复终态 → 朗读闸（money 纪律：语音模式 × 偏好开 × answer；纯代码回复
  // 剥离后空文本零合成）。模式按 result 时点读（ref 免 listener 重绑）。
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    if (subscribeStewardFrames === undefined) return;
    return subscribeStewardFrames((event: EventEnvelope) => {
      if (event.type !== "steward.ask.result") return;
      const payload = event.payload as { status?: unknown; text?: unknown };
      if (!shouldSpeakReply({ mode: modeRef.current, speakEnabled: readStewardSpeakReplyPref(), askResult: { status: String(payload.status ?? "") } })) {
        return;
      }
      const speech = mdToSpeechText(typeof payload.text === "string" ? payload.text : "");
      if (speech === "") return; // 纯代码块回复：零合成零花费
      if (typeof sendVoiceSynthesize !== "function") return;
      const sent = sendVoiceSynthesize(speech, { voice: readTtsVoicePref() });
      if (sent) speakPendingRef.current = true; // 回执单飞门控位
    });
  }, [subscribeStewardFrames, sendVoiceSynthesize]);

  // 合成回执 → 播放（单飞门控：仅本面 pending 消费——设置页试听回执不串台；
  // useVoiceBroadcast 顺序播放是全局订阅面，与本点对点面互不相干）
  useEffect(() => {
    if (subscribeVoiceFrames === undefined) return;
    return subscribeVoiceFrames((event: EventEnvelope) => {
      if (event.type !== "voice.synthesize.result") return;
      if (!speakPendingRef.current) return;
      speakPendingRef.current = false;
      const payload = event.payload as { status?: unknown; audio?: unknown };
      if (payload.status !== "ok" || typeof payload.audio !== "string") {
        setSpeaking(false);
        return;
      }
      try {
        const audio = new Audio(payload.audio);
        audio.volume = Math.max(0, Math.min(1, readVoiceVolumePref() / 100));
        audioRef.current = audio;
        setSpeaking(true);
        audio.onended = () => {
          audioRef.current = null;
          setSpeaking(false);
        };
        audio.onerror = () => {
          audioRef.current = null;
          setSpeaking(false);
        };
        void audio.play().catch(() => {
          // 自动播放策略拒绝等：跳过（不重试不打扰——面板交互态在场，
          // 下轮用户点击后天然解锁）
          audioRef.current = null;
          setSpeaking(false);
        });
      } catch {
        setSpeaking(false);
      }
    });
  }, [subscribeVoiceFrames]);

  // ── 录音 + 转写 → ask（转写文本一次性喂 ask；失败回填草稿可重试）──
  const [voiceDraft, setVoiceDraft] = useState<string | null>(null);
  const askRef = useRef(steward.ask);
  askRef.current = steward.ask;
  const handleTranscript = useCallback((text: string) => {
    const sent = askRef.current(text);
    const plan = planTranscript(text, sent);
    if (plan.kind === "fallback") setVoiceDraft(plan.draft);
  }, []);
  const voice = useVoiceInput(handleTranscript, { sendSttTranscribe, subscribeSttFrames });

  // 新一轮说话 = 停上轮朗读（新意图权威）
  const startListening = useCallback(async () => {
    stopSpeaking();
    await voice.start();
  }, [stopSpeaking, voice.start]);

  const stopListening = useCallback(() => {
    voice.stop();
  }, [voice.stop]);

  // unsupported 自动回退文本态（mic 环境不可用——语音模式不可达）
  const phase = deriveStewardVoicePhase({ voiceState: voice.state, askInFlight: steward.askInFlight, speaking });
  useEffect(() => {
    if (phase === "unsupported") setModeState("text");
  }, [phase]);

  // 切模式：进 text = 停朗读 + 在录强制停（转写链照常走完；answer 不再朗读）
  const setMode = useCallback(
    (next: StewardInputMode) => {
      setModeState(next);
      if (next === "text") {
        stopSpeaking();
        stopListening();
      }
    },
    [stopSpeaking, stopListening],
  );

  return {
    ...steward,
    mode,
    setMode,
    phase,
    level: voice.level,
    speaking,
    voiceError: voice.error,
    voiceDraft,
    startListening,
    stopListening,
    stopSpeaking,
    clearVoiceDraft: useCallback(() => setVoiceDraft(null), []),
  };
}
