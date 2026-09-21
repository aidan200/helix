/**
 * useStewardVoice —— 管家语音模式组合钩子（V3a「跟管家说话」闭环 + V3b-1
 * 流式转写面）。
 *
 * 组合四件（纯逻辑面全在 steward-voice-machine.ts——AG-14 分离）：
 * - useSteward（同 slice）：ask/confirm/feed/config 全面透传——面板数据面
 *   单实例单点（TR-169 族防自激：本钩子不再开第二份订阅闸门 effect）；
 * - shared/lib/useVoiceInput（V3a 下移，DI 注入）：录音 + VAD + 转写——
 *   转写回执单飞门控在他消费面（Composer）与本面互不串台；
 * - 流式转写层（V3b-1，本文件）：stt.stream 四命令接流（开流→PCM 块上行
 *   →interim 实时上屏→finish→final 即刻喂 ask）；WS 失败/超时/终帧 error
 *   → 自动回落非流式链路（V3a 行为等价——失败静默降级，面板一处不显眼
 *   提示，不弹错误卡）；streamId 单飞门控（他流/旧流帧丢弃）；
 * - TTS 朗读层（V3b-2 流式优先 + 回退链，编排体 = steward-speech-out.ts）：
 *   steward.ask.delta 增量喂 SentenceBuffer 切句 → 逐句 voice.synthesize.stream
 *   （utterId 单调）→ chunk 帧入 SpeechPlayer 播放队列（Web Audio 无缝调度
 *   ——上一句播放中下一句已在合成）；流式失败（error 帧且零出声/首帧超时/
 *   发送失败/播放面不可用）→ answer 终态一次性 voice.synthesize 整段回退
 *   （V3a 现行为）→ 再失败只丢句不断对话；静音钮 stopSpeaking →
 *   voice.synthesize.stop + 播放队列清空 + 分句缓冲 reset；面板卸载（Dock
 *   关）即停。money 闸：语音模式 × 偏好开在 delta/result 两时点判。
 *
 * 语音链（V3b-1）：点击 mic（idle→listening；同步发 stt.stream.start）→
 * 边说边转写（interim 淡色浮字实时上屏）→ VAD 静音 ~1.8s/点击强制停 →
 * stt.stream.finish → final（实测 ~250-400ms）→ onTranscript 一次性喂 ask
 *（asking，流式回答）→ answer 终态 → 朗读（speaking）→ 播毕回 idle。
 * 开流失败/终帧超时/error → transcribeNow 回落（blob 上传整段转写，
 * V3a 同构——零静默丢话）。
 *
 * 异常回退（纯面 planTranscript）：ask 发送失败（未连接）→ 转写文本回填
 * voiceDraft（面板采纳进输入框——文本态可重试，零静默丢话）；转写失败 →
 * useVoiceInput error 面（面板 toast，Composer 同构）。
 *
 * 双模（mode）：面板打开默认 voice；mic 不可用（unsupported）自动回退
 * text。切 text = 停朗读 + 在录即强制停（转写链照常走完，answer 不朗读
 * ——money 闸按 result 时点模式判）。LISTEN_SURFACE 多听众扇出是官方
 * 形态（Set fan-out）：本钩子与 useSteward/useVoiceInput 各自订阅 stt
 * 帧，各取所需（流式帧本面消费、回执面 useVoiceInput 消费）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { useVoiceInput } from "@/shared/lib/useVoiceInput";
import type { RmsMeterFactory } from "@/shared/lib/rms-meter";
import type { PcmPumpFactory } from "@/shared/lib/pcm-pump";
import { pcmFrameToBase64 } from "@/shared/lib/pcm-pump";
import type { SpeechPlayerFactory } from "@/shared/lib/pcm-player";
import { readSttProviderPref } from "@/shared/lib/stt-provider-pref";
import { readTtsVoicePref, readVoiceVolumePref, readStewardSpeakReplyPref } from "@/shared/lib/voice-pref";
import type { EventEnvelope } from "@helix/protocol";
import { useSteward, type StewardPanelItem, type StewardPendingAction } from "./useSteward";
import { StewardSpeechOut } from "./steward-speech-out";
import {
  deriveStewardVoicePhase,
  shouldSpeakReply,
  mdToSpeechText,
  planTranscript,
  type StewardInputMode,
  type StewardVoicePhase,
} from "./steward-voice-machine";

/** 终帧等待上限（ms）：超时自动回落非流式（V3a 行为等价）。 */
export const STREAM_FINAL_TIMEOUT_MS = 4_000;

/** useStewardVoice 注入面（测试缝：设备面/时钟面可注入——生产调用方缺省）。 */
export interface UseStewardVoiceOptions {
  /** RMS meter 工厂（透传 useVoiceInput；测试注入 fake）。 */
  readonly createMeter?: RmsMeterFactory;
  /** PCM 泵工厂（透传 useVoiceInput；测试注入 fake）。 */
  readonly createPump?: PcmPumpFactory;
  /** 终帧等待上限 ms（缺省 STREAM_FINAL_TIMEOUT_MS；测试注入短窗）。 */
  readonly streamFinalTimeoutMs?: number;
  /** 流式朗读播放器工厂（缺省 Web Audio；测试注入 fake——jsdom 无音频设备）。 */
  readonly createPlayer?: SpeechPlayerFactory;
}

export interface UseStewardVoice {
  // ── useSteward 整面透传（面板数据面不二开；A1：messages → items 过程条目）──
  readonly items: readonly StewardPanelItem[];
  readonly streamingText: string | null;
  readonly pending: StewardPendingAction | null;
  readonly feed: ReturnType<typeof useSteward>["feed"];
  readonly askInFlight: boolean;
  readonly config: ReturnType<typeof useSteward>["config"];
  ask(text: string): boolean;
  confirmPending(): boolean;
  dismissPending(): void;
  newDialog(): boolean;
  // ── 双模（互斥；打开默认 voice）──
  readonly mode: StewardInputMode;
  setMode(mode: StewardInputMode): void;
  // ── 语音面 ──
  /** 面板唯一阶段事实源（idle/listening/transcribing/asking/speaking/unsupported）。 */
  readonly phase: StewardVoicePhase;
  /** 实时电平 0..1（listening 波形可视化数据源；他态恒 0）。 */
  readonly level: number;
  /** 流式 interim 文本（listening/transcribing 态实时上屏；prior+text+stash
   *  拼接态；final 到达替换、出态清空；null = 无）。 */
  readonly interim: string | null;
  /** 流式链已降级（开流失败/终帧超时/error——本轮回落非流式；不弹错误卡，
   *  面板一处不显眼提示消费）。 */
  readonly streamDegraded: boolean;
  /** TTS 朗读中（speaking 态同义布尔——静音钮显隐）。 */
  readonly speaking: boolean;
  /** 转写/录音侧最近失败原因（toast 消费；null = 无）。 */
  readonly voiceError: string | null;
  /** ask 发送失败的转写文本（面板采纳进输入框后 clearVoiceDraft 清位）。 */
  readonly voiceDraft: string | null;
  /** 点击 mic 开始说话（新一轮：先停上轮朗读；流式开流同步发出）。 */
  startListening(): Promise<void>;
  /** 录音中点击 = 强制停（转写链照常：流式 finish 或回落非流式）。 */
  stopListening(): void;
  /** 静音钮：一键停读（在播音频即停；无播报 no-op）。 */
  stopSpeaking(): void;
  /** 面板采纳转写回填后清位。 */
  clearVoiceDraft(): void;
}

export function useStewardVoice(open: boolean, options?: UseStewardVoiceOptions): UseStewardVoice {
  const {
    sendSttTranscribe,
    sendSttStreamStart,
    sendSttStreamChunk,
    sendSttStreamFinish,
    sendSttStreamStop,
    subscribeSttFrames,
    sendVoiceSynthesize,
    sendVoiceSynthesizeStream,
    sendVoiceSynthesizeStop,
    subscribeVoiceFrames,
    subscribeStewardFrames,
  } = useSession() as {
    sendSttTranscribe?: (audio: string, opts?: { language?: string; provider?: string }) => boolean;
    sendSttStreamStart?: (opts?: { language?: string; provider?: string }) => boolean;
    sendSttStreamChunk?: (audio: string) => boolean;
    sendSttStreamFinish?: () => boolean;
    sendSttStreamStop?: () => boolean;
    subscribeSttFrames?: (listener: (e: EventEnvelope) => void) => () => void;
    sendVoiceSynthesize?: (text: string, opts?: { voice?: string; language?: string }) => boolean;
    sendVoiceSynthesizeStream?: (utterId: string, text: string, opts?: { voice?: string }) => boolean;
    sendVoiceSynthesizeStop?: (utterId?: string) => boolean;
    subscribeVoiceFrames?: (listener: (e: EventEnvelope) => void) => () => void;
    subscribeStewardFrames?: (listener: (e: EventEnvelope) => void) => () => void;
  };
  const steward = useSteward(open);

  // ── 双模（打开默认语音模式——brief 口径；unsupported 自动回退文本态）──
  const [mode, setModeState] = useState<StewardInputMode>("voice");

  // ── TTS 朗读层（V3b-2 流式优先 + 回退链）──
  // 流式：delta 切句 → voice.synthesize.stream 逐句 → chunk 入 SpeechPlayer
  // 队列（句间无缝）；回退：流式失败 → 一次性 voice.synthesize → 面板 Audio
  // 播放（V3a 现行为）；再失败只丢句不断对话。
  const [legacySpeaking, setLegacySpeaking] = useState(false);
  const [streamSpeaking, setStreamSpeaking] = useState(false);
  const speaking = legacySpeaking || streamSpeaking;
  const speakPendingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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
      ...(options?.createPlayer !== undefined
        ? {
            createPlayer: () => {
              const player = options.createPlayer!();
              player.setVolume(Math.max(0, Math.min(1, readVoiceVolumePref() / 100)));
              return player;
            },
          }
        : {}),
    });
  }
  const speechOut = speechOutRef.current;
  useEffect(() => {
    return speechOut.onSpeakingChange(setStreamSpeaking);
  }, [speechOut]);

  const stopSpeaking = useCallback(() => {
    speakPendingRef.current = false;
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio !== null) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }
    setLegacySpeaking(false);
    setStreamSpeaking(false); // 静音即停——不依赖播放器回调时序（fake/真体一致）
    speechOut.stopSpeaking(); // stop 命令 + 队列清空 + 分句缓冲 reset + 本轮静音
  }, [speechOut]);

  // 面板卸载（Dock 关/路由外弹层退场）即停读——不留幽灵音频/孤儿在途句。
  // StrictMode 双效应兼容：cleanup 先跑 close() 毒死 useRef 实例，重挂 setup
  // 必须显式 reopen()（否则 disposed 永真 → 朗读全链静默）。
  useEffect(
    () => {
      speechOut.reopen();
      return () => {
        speakPendingRef.current = false;
        const audio = audioRef.current;
        audioRef.current = null;
        if (audio !== null) {
          audio.onended = null;
          audio.onerror = null;
          audio.pause();
        }
        speechOut.close();
      };
    },
    [speechOut],
  );

  // 回答终态 → 朗读闸（money 纪律：语音模式 × 偏好开；answer 判别在
  // speechOut 内收口）。流式优先：delta 已切句发流的轮次不再重复一次性。
  // 模式按 result 时点读（ref 免 listener 重绑）。
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    if (subscribeStewardFrames === undefined) return;
    return subscribeStewardFrames((event: EventEnvelope) => {
      if (event.type === "steward.ask.delta") {
        // 流式朗读闸（money 纪律）：语音模式 × 偏好开才喂（文本模式零合成）
        const p = event.payload as { delta?: unknown };
        if (modeRef.current !== "voice" || !readStewardSpeakReplyPref()) return;
        if (typeof p.delta !== "string" || p.delta === "") return;
        speechOut.feedRawDelta(p.delta);
        return;
      }
      if (event.type !== "steward.ask.result") return;
      const payload = event.payload as { status?: unknown; text?: unknown };
      const status = String(payload.status ?? "");
      // 闸不过（非语音模式/偏好关/非 answer 不合成——confirm/error 零朗读）
      // 时：语音模式下非 answer 终态仍收口轮次（废弃在途未读句缓冲）
      if (!shouldSpeakReply({ mode: modeRef.current, speakEnabled: readStewardSpeakReplyPref(), askResult: { status } })) {
        if (modeRef.current === "voice" && readStewardSpeakReplyPref()) {
          speechOut.answerResult(status, typeof payload.text === "string" ? payload.text : "");
        }
        return;
      }
      const verdict = speechOut.answerResult(status, typeof payload.text === "string" ? payload.text : "");
      if (verdict === "fallback") speakPendingRef.current = true; // 一次性回执单飞门控位
    });
  }, [subscribeStewardFrames, speechOut]);

  // ask 在途 → 新一轮朗读开轮（迟到 delta 归零——句不跨轮泄漏）
  const askInFlight = steward.askInFlight;
  useEffect(() => {
    if (askInFlight) speechOut.resetAnswer();
  }, [askInFlight, speechOut]);

  // 一次性回退回执 → 播放（单飞门控：仅本面 pending 消费——设置页试听回执
  // 不串台；useVoiceBroadcast 顺序播放是全局订阅面，与本点对点面互不相干）
  useEffect(() => {
    if (subscribeVoiceFrames === undefined) return;
    return subscribeVoiceFrames((event: EventEnvelope) => {
      if (event.type === "voice.synthesize.chunk") {
        const p = event.payload as { utterId?: unknown; audio?: unknown };
        if (typeof p.utterId === "string" && typeof p.audio === "string") speechOut.onChunkFrame(p.utterId, p.audio);
        return;
      }
      if (event.type === "voice.synthesize.done") {
        const p = event.payload as { utterId?: unknown };
        if (typeof p.utterId === "string") speechOut.onDoneFrame(p.utterId);
        return;
      }
      if (event.type === "voice.synthesize.error") {
        const p = event.payload as { utterId?: unknown };
        if (typeof p.utterId === "string") speechOut.onErrorFrame(p.utterId);
        return;
      }
      if (event.type !== "voice.synthesize.result") return;
      if (!speakPendingRef.current) return;
      speakPendingRef.current = false;
      const payload = event.payload as { status?: unknown; audio?: unknown };
      if (payload.status !== "ok" || typeof payload.audio !== "string") {
        setLegacySpeaking(false);
        return;
      }
      try {
        const audio = new Audio(payload.audio);
        audio.volume = Math.max(0, Math.min(1, readVoiceVolumePref() / 100));
        audioRef.current = audio;
        setLegacySpeaking(true);
        audio.onended = () => {
          audioRef.current = null;
          setLegacySpeaking(false);
        };
        audio.onerror = () => {
          audioRef.current = null;
          setLegacySpeaking(false);
        };
        void audio.play().catch(() => {
          // 自动播放策略拒绝等：跳过（不重试不打扰——面板交互态在场，
          // 下轮用户点击后天然解锁）
          audioRef.current = null;
          setLegacySpeaking(false);
        });
      } catch {
        setLegacySpeaking(false);
      }
    });
  }, [subscribeVoiceFrames, speechOut]);

  // ── 录音 + 转写 → ask（转写文本一次性喂 ask；失败回填草稿可重试）──
  const [voiceDraft, setVoiceDraft] = useState<string | null>(null);
  // ── 流式面（V3b-1）：interim 上屏 + 终帧收口 + 回落链 ──
  const [interim, setInterim] = useState<string | null>(null);
  const [streamDegraded, setStreamDegraded] = useState(false);
  /** start 已发（等 started 回执；期间 chunk 照发——daemon 缓冲）。 */
  const streamArmedRef = useRef(false);
  /** started.ok 的 streamId（单飞门控判别位；null = 未就绪）。 */
  const streamIdRef = useRef<string | null>(null);
  /** 流已死（started.error/终帧 error/超时）——本轮不再上行/等帧。 */
  const streamDeadRef = useRef(false);
  /** finish 已发，等终帧（超时回落计时器在飞）。 */
  const finalPendingRef = useRef(false);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamSenders = { sendSttStreamStart, sendSttStreamChunk, sendSttStreamFinish, sendSttStreamStop };
  const streamSendersRef = useRef(streamSenders);
  streamSendersRef.current = streamSenders;

  const clearFallbackTimer = useCallback(() => {
    if (fallbackTimerRef.current !== null) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  // PCM 帧 → stt.stream.chunk（仅 armed 且未死；他态零上行——money 纪律）
  const onPcmFrame = useCallback((frame: ArrayBuffer) => {
    if (!streamArmedRef.current || streamDeadRef.current) return;
    const send = streamSendersRef.current.sendSttStreamChunk;
    if (typeof send !== "function") return;
    send(pcmFrameToBase64(frame));
  }, []);

  // blob 就位（deferred 态）→ 流在途？finish 等终帧 : 立即回落非流式
  const finalTimeoutMsRef = useRef(options?.streamFinalTimeoutMs ?? STREAM_FINAL_TIMEOUT_MS);
  finalTimeoutMsRef.current = options?.streamFinalTimeoutMs ?? STREAM_FINAL_TIMEOUT_MS;
  const onDeferredHold = useCallback(() => {
    const senders = streamSendersRef.current;
    if (streamArmedRef.current && !streamDeadRef.current && streamIdRef.current !== null && typeof senders.sendSttStreamFinish === "function") {
      finalPendingRef.current = true;
      senders.sendSttStreamFinish();
      clearFallbackTimer();
      fallbackTimerRef.current = setTimeout(() => {
        // 终帧超时 → 回落非流式（V3a 行为等价）；timer 回调读不到最新
        // voiceRef——经 ref 转发（下方 voiceRef 声明前置提升）
        finalPendingRef.current = false;
        streamDeadRef.current = true;
        setStreamDegraded(true);
        voiceRef.current.transcribeNow();
      }, finalTimeoutMsRef.current);
    } else {
      voiceRef.current.transcribeNow();
    }
  }, [clearFallbackTimer]);

  const askRef = useRef(steward.ask);
  askRef.current = steward.ask;
  const handleTranscript = useCallback((text: string) => {
    const sent = askRef.current(text);
    const plan = planTranscript(text, sent);
    if (plan.kind === "fallback") setVoiceDraft(plan.draft);
  }, []);
  const voice = useVoiceInput(handleTranscript, {
    sendSttTranscribe,
    subscribeSttFrames,
    onPcmFrame,
    deferredTranscribe: true,
    onDeferredHold,
    ...(options?.createMeter !== undefined ? { createMeter: options.createMeter } : {}),
    ...(options?.createPump !== undefined ? { createPump: options.createPump } : {}),
  });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  // 流式帧消费（与 useVoiceInput 回执面双订阅扇出——LISTEN_SURFACE 官方
  // 形态；streamId 单飞门控：他流/旧流帧丢弃，非 pending 终帧丢弃）
  useEffect(() => {
    if (subscribeSttFrames === undefined) return;
    return subscribeSttFrames((event: EventEnvelope) => {
      if (event.type === "stt.stream.started") {
        if (!streamArmedRef.current) return; // 非本轮（他面/迟到）不消费
        const p = event.payload as { status?: unknown; streamId?: unknown; reason?: unknown };
        if (p.status === "ok" && typeof p.streamId === "string") {
          streamIdRef.current = p.streamId;
        } else {
          // 开流失败：静默降级（录音照常，停后 blob 回落非流式）
          streamDeadRef.current = true;
          setStreamDegraded(true);
        }
      } else if (event.type === "stt.stream.interim") {
        const p = event.payload as { streamId?: unknown; prior?: unknown; text?: unknown; stash?: unknown };
        if (p.streamId !== streamIdRef.current) return; // 单飞门控
        const prior = typeof p.prior === "string" ? p.prior : "";
        const text = typeof p.text === "string" ? p.text : "";
        const stash = typeof p.stash === "string" ? p.stash : "";
        setInterim(`${prior}${text}${stash}`);
      } else if (event.type === "stt.stream.final") {
        const p = event.payload as { status?: unknown; streamId?: unknown; text?: unknown };
        if (p.streamId !== streamIdRef.current) return; // 单飞门控
        if (!finalPendingRef.current) return; // 未在等终帧（已废弃/未 finish）→ 丢弃
        clearFallbackTimer();
        finalPendingRef.current = false;
        streamIdRef.current = null;
        if (p.status === "ok") {
          const text = typeof p.text === "string" ? p.text : "";
          if (text.trim() !== "") setInterim(text); // final 替换 interim（转正前闪现）
          voiceRef.current.resolveStreaming(text);
        } else {
          // 流失败 → 回落非流式（blob 整段转写，V3a 行为等价）
          streamDeadRef.current = true;
          setStreamDegraded(true);
          voiceRef.current.transcribeNow();
        }
      }
    });
  }, [subscribeSttFrames, clearFallbackTimer]);

  // 新一轮说话 = 停上轮朗读 + 流式复位（开流同步发——失败静默降级）
  const startListening = useCallback(async () => {
    stopSpeaking();
    clearFallbackTimer();
    setInterim(null);
    setStreamDegraded(false);
    streamIdRef.current = null;
    streamDeadRef.current = false;
    finalPendingRef.current = false;
    // 开流门（money 纪律）：仅语音模式 listening 态开——点击开始才建 WS；
    // provider 偏好非 dashscope（无流式能力）不开流零连接
    const pref = readSttProviderPref();
    const sendStart = streamSendersRef.current.sendSttStreamStart;
    streamArmedRef.current =
      typeof sendStart === "function" && (pref === undefined || pref === "dashscope") && sendStart({ language: "zh" });
    await voiceRef.current.start();
  }, [stopSpeaking, clearFallbackTimer]);

  const stopListening = useCallback(() => {
    voiceRef.current.stop();
  }, []);

  // 面板卸载/路由退场：在录强制停链路自然走完之外，废弃未收口的流（abort
  // 上游——money 纪律零孤儿连接；final 已 pending 时 timer 兑底回落后停）
  useEffect(
    () => () => {
      clearFallbackTimer();
      if (streamArmedRef.current && !finalPendingRef.current) {
        streamSendersRef.current.sendSttStreamStop?.();
      }
      streamArmedRef.current = false;
      streamDeadRef.current = true;
    },
    [clearFallbackTimer],
  );

  // unsupported 自动回退文本态（mic 环境不可用——语音模式不可达）
  const phase = deriveStewardVoicePhase({ voiceState: voice.state, askInFlight: steward.askInFlight, speaking });
  useEffect(() => {
    if (phase === "unsupported") setModeState("text");
  }, [phase]);

  // interim 出态清理（listening/transcribing 外不残留浮字——final 转正后
  //（idle/asking）清位；phase 派生在上方，此处消费无 TDZ）
  useEffect(() => {
    if (phase !== "listening" && phase !== "transcribing") setInterim(null);
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
    interim,
    streamDegraded,
    speaking,
    voiceError: voice.error,
    voiceDraft,
    startListening,
    stopListening,
    stopSpeaking,
    clearVoiceDraft: useCallback(() => setVoiceDraft(null), []),
  };
}
