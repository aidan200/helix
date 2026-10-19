/**
 * useComposerVoice —— Composer 输入框语音流式接线（实时识别批）。
 *
 * 把 shared/lib/useVoiceInput 的 V3b-1 流式挂点（onPcmFrame /
 * deferredTranscribe / resolveStreaming / transcribeNow）接到 stt.stream
 * 四命令族（start/chunk/finish/stop），让输入框语音输入具备实时识别：
 * - start：同步发 stt.stream.start（zh）→ started.ok 记 streamId（单飞
 *   门控位）→ PCM 帧 ~100ms 一拍 stt.stream.chunk 上行 → stt.stream.interim
 *   实时回流（prior+text+stash 拼接态暴露给 UI 灰字上屏）；
 * - stop：blob 就位（deferred 态）→ 流在途则 stt.stream.finish 等终帧
 *   （超时 4s 回落），final.ok → resolveStreaming(text) → onTranscript
 *   一次性回填草稿（final 替换 interim 转正）；
 * - 回落链（V3a 行为等价兜底）：开流不可达 / started.error / final.error /
 *   终帧超时 → blob 走既有 stt.transcribe 整段上传，结果等价喂 onTranscript
 *   ——流式不可用不改变功能语义，只缺实时上屏；
 * - money 纪律：provider 偏好非 dashscope（无流式能力）不开流零连接；
 *   chunk 仅 armed 且未死上行；卸载在途流 stt.stream.stop 废弃（零孤儿连接）。
 *
 * 为什么存在：Composer 语音输入原走 V3a 一整段上传链（说完才见字，全程
 * 无反馈）；管家语音面（useStewardVoice）已落 V3b-1 流式基建，本钩子按同构
 * 门控（armed/streamId/finalPending 单飞 + 回落 timer）为输入框消费面接线，
 * 不动 useVoiceInput 状态机本体（TR-215 取消竞态守卫全数继承）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { useVoiceInput, type VoiceState } from "@/shared/lib/useVoiceInput";
import { pcmFrameToBase64, type PcmPumpFactory } from "@/shared/lib/pcm-pump";
import type { RmsMeterFactory } from "@/shared/lib/rms-meter";
import { readSttProviderPref } from "@/shared/lib/stt-provider-pref";
import type { EventEnvelope } from "@helix/protocol";

/** 终帧等待上限（ms）：超时自动回落非流式（useStewardVoice 同值 4s）。 */
export const COMPOSER_STREAM_FINAL_TIMEOUT_MS = 4_000;

/** useComposerVoice 注入面（测试缝：设备面/时钟面可注入——生产调用方缺省）。 */
export interface UseComposerVoiceOptions {
  /** RMS meter 工厂（透传 useVoiceInput；测试注入 fake）。 */
  readonly createMeter?: RmsMeterFactory;
  /** PCM 泵工厂（透传 useVoiceInput；测试注入 fake）。 */
  readonly createPump?: PcmPumpFactory;
  /** 终帧等待上限 ms（缺省 COMPOSER_STREAM_FINAL_TIMEOUT_MS；测试注入短窗）。 */
  readonly streamFinalTimeoutMs?: number;
}

export interface UseComposerVoice {
  /** useVoiceInput 状态机透传（idle/recording/transcribing/unsupported）。 */
  readonly state: VoiceState;
  /** 实时电平 0..1（mic 钮电平条数据源）。 */
  readonly level: number;
  /** 用户正在发声（最近 ~900ms 人声判据帧）。 */
  readonly userSpeaking: boolean;
  /** 录音/转写侧最近失败原因（toast 消费；null = 无）。 */
  readonly error: string | null;
  /** 流式 interim 文本（recording/transcribing 态实时上屏；prior+text+stash
   *  拼接态；final 到达替换、出态清空；null = 无——非流式回落路径全程 null）。 */
  readonly interim: string | null;
  /** 点击 mic 开始说话（流式开流同步发出；provider 无流式能力静默跳过）。 */
  start(): Promise<void>;
  /** 录音中点击 = 强制停（流式 finish 等终帧或回落非流式，转写链照常收口）。 */
  stop(): void;
}

export function useComposerVoice(
  onTranscript: (text: string) => void,
  options?: UseComposerVoiceOptions,
): UseComposerVoice {
  const {
    sendSttTranscribe,
    sendSttStreamStart,
    sendSttStreamChunk,
    sendSttStreamFinish,
    sendSttStreamStop,
    subscribeSttFrames,
  } = useSession() as {
    sendSttTranscribe?: (audio: string, opts?: { language?: string; provider?: string }) => boolean;
    sendSttStreamStart?: (opts?: { language?: string; provider?: string }) => boolean;
    sendSttStreamChunk?: (audio: string) => boolean;
    sendSttStreamFinish?: () => boolean;
    sendSttStreamStop?: () => boolean;
    subscribeSttFrames?: (listener: (e: EventEnvelope) => void) => () => void;
  };

  // ── 流式面 refs（useStewardVoice 同构门控）──
  const [interim, setInterim] = useState<string | null>(null);
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

  /** 回落即断流（中危 F3a，money 纪律「零孤儿连接」）：回落路径置 dead 后
   *  立即补发 stt.stream.stop（与卸载清理同口径）——否则 daemon 侧流悬挂到
   *  组件卸载才收口，Composer 常驻会话期即悬挂整场（客户端 chunk 已停）。 */
  const abandonStream = useCallback((): void => {
    if (streamArmedRef.current && !finalPendingRef.current) {
      streamSendersRef.current.sendSttStreamStop?.();
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
  const finalTimeoutMsRef = useRef(options?.streamFinalTimeoutMs ?? COMPOSER_STREAM_FINAL_TIMEOUT_MS);
  finalTimeoutMsRef.current = options?.streamFinalTimeoutMs ?? COMPOSER_STREAM_FINAL_TIMEOUT_MS;
  const onDeferredHold = useCallback(() => {
    const senders = streamSendersRef.current;
    if (
      streamArmedRef.current &&
      !streamDeadRef.current &&
      streamIdRef.current !== null &&
      typeof senders.sendSttStreamFinish === "function"
    ) {
      finalPendingRef.current = true;
      senders.sendSttStreamFinish();
      clearFallbackTimer();
      fallbackTimerRef.current = setTimeout(() => {
        // 终帧超时 → 回落非流式（V3a 行为等价）+ 断流（回落即收口 dead 流）
        finalPendingRef.current = false;
        streamDeadRef.current = true;
        abandonStream();
        voiceRef.current.transcribeNow();
      }, finalTimeoutMsRef.current);
    } else {
      voiceRef.current.transcribeNow();
    }
  }, [clearFallbackTimer, abandonStream]);

  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const voice = useVoiceInput((text) => onTranscriptRef.current(text), {
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
        const p = event.payload as { status?: unknown; streamId?: unknown };
        if (p.status === "ok" && typeof p.streamId === "string") {
          streamIdRef.current = p.streamId;
        } else {
          // 开流失败：静默降级（录音照常，停后 blob 回落非流式）
          streamDeadRef.current = true;
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
          // 流失败 → 回落非流式（blob 整段转写，V3a 行为等价）+ 断流收口
          streamDeadRef.current = true;
          abandonStream();
          voiceRef.current.transcribeNow();
        }
      }
    });
  }, [subscribeSttFrames, clearFallbackTimer, abandonStream]);

  // 点击开始：流式复位 + 开流（同步发——失败静默降级）+ 录音启动
  const start = useCallback(async () => {
    clearFallbackTimer();
    setInterim(null);
    streamIdRef.current = null;
    streamDeadRef.current = false;
    finalPendingRef.current = false;
    // 开流门（money 纪律）：provider 偏好非 dashscope（无流式能力）不开流零连接
    const pref = readSttProviderPref();
    const sendStart = streamSendersRef.current.sendSttStreamStart;
    streamArmedRef.current =
      typeof sendStart === "function" && (pref === undefined || pref === "dashscope") && sendStart({ language: "zh" });
    await voiceRef.current.start();
  }, [clearFallbackTimer]);

  const stop = useCallback(() => {
    voiceRef.current.stop();
  }, []);

  // interim 出态清理（recording/transcribing 外不残留浮字——final 回填草稿
  // 后立即清位，灰字让位正式文本）
  useEffect(() => {
    if (voice.state !== "recording" && voice.state !== "transcribing") setInterim(null);
  }, [voice.state]);

  // 卸载/路由退场：废弃未收口的流（abort 上游——money 纪律零孤儿连接；
  // final 已 pending 时 timer 兜底回落后停）
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

  return { state: voice.state, level: voice.level, userSpeaking: voice.userSpeaking, error: voice.error, interim, start, stop };
}
