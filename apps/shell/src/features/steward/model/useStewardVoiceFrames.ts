/**
 * useStewardVoiceFrames —— 管家语音帧订阅面（P2 体量门 ④ 轻拆批：从
 * useStewardVoice.ts 机械迁出，钩子体逐字未改）。
 *
 * 两块订阅装配（各在 useStewardVoice 原调用点位置调用——effect 注册序与
 * 迁出前逐项一致，行为零变更）：
 * - useStewardVoiceSpeechFrames：对话面帧（steward.ask.delta 流式朗读闸 +
 *   steward.judge_stop_intent.result 判官回执唤醒 + steward.ask.result 终态
 *   朗读判决）与 ask 在途开轮（新轮清在途/轮次 id 递增）；
 * - useStewardVoiceSttFrames：stt.stream 四帧消费（started 单飞门控 /
 *   interim 上屏 / final 收口与回落非流式）。
 *
 * 共享的可变面（speechOut 单例/轮次 ref/等待队列 ref）由组合根持有，经
 * deps 注入——本模块零状态，只做订阅与分派。
 */
import { useEffect } from "react";
import type { EventEnvelope } from "@helix/protocol";
import { beginDialogueSpeech, endDialogueSpeech } from "@/shared/lib/speech-floor";
import { readStewardSpeakReplyPref, readVoiceVolumePref } from "@/shared/lib/voice-pref";
import { recordSpeechDiag } from "./speech-diag";
import type { StewardSpeechOut } from "./steward-speech-out";
import { shouldSpeakReply, type StewardInputMode } from "./steward-voice-machine";

// ── ① speech-floor 对话源（出声面协调器：播×播互斥——对话 > 通知）：
//    回答轮在途（askInFlight）/ a 流式播放器在播 / b 一次性回执在播三源
//    任一在场 = 对话发言期——通知播报面（c）被压制（延后/收编，见
//    speech-floor）。源 id 与租约同串（两套计数客自独立，互不混）。──
const SPEECH_FLOOR_ROUND = "steward-answer-round";

/** 对话面帧订阅装配的注入面（ref/单例由组合根持有——同实例同序）。 */
export interface StewardVoiceSpeechFramesDeps {
  readonly subscribeStewardFrames?: (listener: (e: EventEnvelope) => void) => () => void;
  readonly subscribeVoiceFrames?: (listener: (e: EventEnvelope) => void) => () => void;
  readonly modeRef: { current: StewardInputMode };
  readonly speechOut: StewardSpeechOut;
  readonly judgeStopWaitersRef: { current: ((verdict: "stop" | "other" | "unjudged") => void)[] };
  readonly speakPendingRef: { current: boolean };
  readonly speakRoundRef: { current: number };
  readonly answerRoundRef: { current: number };
  readonly audioRef: { current: HTMLAudioElement | null };
  readonly stopLegacyAudio: () => void;
  readonly markLegacySpeaking: (active: boolean) => void;
  readonly askInFlight: boolean;
}

export function useStewardVoiceSpeechFrames(deps: StewardVoiceSpeechFramesDeps): void {
  const {
    subscribeStewardFrames,
    subscribeVoiceFrames,
    modeRef,
    speechOut,
    judgeStopWaitersRef,
    speakPendingRef,
    speakRoundRef,
    answerRoundRef,
    audioRef,
    stopLegacyAudio,
    markLegacySpeaking,
    askInFlight,
  } = deps;

  useEffect(() => {
    if (subscribeStewardFrames === undefined) return;
    return subscribeStewardFrames((event: EventEnvelope) => {
      if (event.type === "steward.ask.delta") {
        // 流式朗读闸（money 纪律）：语音模式 × 偏好开才喂（文本模式零合成）
        const p = event.payload as { delta?: unknown };
        if (modeRef.current !== "voice" || !readStewardSpeakReplyPref()) {
          recordSpeechDiag("gate.drop.frame.steward.ask.delta", `mode=${modeRef.current} pref=${readStewardSpeakReplyPref()}`);
          return;
        }
        if (typeof p.delta !== "string" || p.delta === "") return;
        speechOut.feedRawDelta(p.delta);
        return;
      }
      if (event.type === "steward.judge_stop_intent.result") {
        // 停止意图判定回执（Jev 单轨）：等待队列整体唤醒；判不出归一
        // （stop=false + degraded = 判官降级/抛错 → unjudged，fail-stop 归
        // 消费面）；迟到回执无等待者幂等吞。
        const p = event.payload as { stop?: unknown; degraded?: unknown };
        const waiters = judgeStopWaitersRef.current;
        if (waiters.length === 0) return;
        judgeStopWaitersRef.current = [];
        const verdict = p.stop === true ? "stop" : p.degraded !== undefined ? "unjudged" : "other";
        for (const w of waiters) w(verdict);
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
      recordSpeechDiag("result.consumed", `verdict=${verdict}`);
      if (verdict === "fallback") {
        speakPendingRef.current = true; // 一次性回执单飞门控位
        speakRoundRef.current = answerRoundRef.current; // ③ 记轮次 id（迟到回执弃播判据）
      }
    });
  }, [subscribeStewardFrames, speechOut]);

  // ask 在途 → 新一轮朗读开轮（迟到 delta 归零——句不跨轮泄漏）
  useEffect(() => {
    if (!askInFlight) return;
    recordSpeechDiag("ask.in-flight", "edge");
    // ① 对话发言期开轮（先占面再清在途——防清理边沿瞬时放行通知面）
    beginDialogueSpeech(SPEECH_FLOOR_ROUND);
    answerRoundRef.current += 1; // ③ 轮次 id 递增（旧轮回执自此判为迟到）
    stopLegacyAudio(); // ② 补边：旧轮一次性回执让位（新轮清在途的 b 面）
    speechOut.resetAnswer(); // ② 新轮清在途（在途句定向 stop + player 旧尾音停 + 闸复位）
    return () => endDialogueSpeech(SPEECH_FLOOR_ROUND); // 收口（含卸载）——a/b 在播仍持面
  }, [askInFlight, speechOut, stopLegacyAudio]);

  // 一次性回退回执 → 播放（单飞门控：仅本面 pending 消费——设置页试听回执
  // 不串台；useVoiceBroadcast 顺序播放是全局订阅面，与本点对点面互不相干）
  useEffect(() => {
    if (subscribeVoiceFrames === undefined) return;
    return subscribeVoiceFrames((event: EventEnvelope) => {
      if (event.type === "voice.synthesize.chunk") {
        const p = event.payload as { utterId?: unknown; audio?: unknown; seq?: unknown };
        if (typeof p.utterId === "string" && typeof p.audio === "string")
          speechOut.onChunkFrame(p.utterId, p.audio, typeof p.seq === "number" ? p.seq : undefined);
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
      if (!speakPendingRef.current) {
        recordSpeechDiag("fallback.result-drop", "no-pending");
        return;
      }
      speakPendingRef.current = false;
      // ③ 迟到回执弃播：fallback 发出后新 ask 已开轮（轮次 id 已变）→ 旧轮
      // 音频不覆盖新轮——零 new Audio（内容在活动流/toast 可查）
      if (speakRoundRef.current !== answerRoundRef.current) {
        recordSpeechDiag("fallback.result-drop", "round-mismatch");
        return;
      }
      const payload = event.payload as { status?: unknown; audio?: unknown };
      if (payload.status !== "ok" || typeof payload.audio !== "string") {
        recordSpeechDiag("fallback.result-drop", `status=${String(payload.status)}`);
        markLegacySpeaking(false);
        return;
      }
      try {
        markLegacySpeaking(true); // ⑥ 回执发言期登记租约 + ① b 面起播占对话面
        // ① a×b 互斥：b 起播即停 a——旧流式尾音/在途句不与回执同时出声
        //（money：在途句逐条定向 stop）
        speechOut.stopInFlightPlayback();
        const audio = new Audio(payload.audio);
        audio.volume = Math.max(0, Math.min(1, readVoiceVolumePref() / 100));
        audioRef.current = audio;
        audio.onended = () => {
          audioRef.current = null;
          markLegacySpeaking(false);
        };
        audio.onerror = () => {
          audioRef.current = null;
          markLegacySpeaking(false);
        };
        void audio.play().catch(() => {
          // 自动播放策略拒绝等：跳过（不重试不打扰——面板交互态在场，
          // 下轮用户点击后天然解锁）
          recordSpeechDiag("fallback.play-reject", "autoplay-or-decode");
          audioRef.current = null;
          markLegacySpeaking(false);
        });
      } catch {
        markLegacySpeaking(false);
      }
    });
  }, [subscribeVoiceFrames, speechOut, markLegacySpeaking]);
}

/** stt 流式帧订阅装配的注入面（流 ref 与回执面由组合根持有）。 */
export interface StewardVoiceSttFramesDeps {
  readonly subscribeSttFrames?: (listener: (e: EventEnvelope) => void) => () => void;
  readonly streamArmedRef: { current: boolean };
  readonly streamIdRef: { current: string | null };
  readonly streamDeadRef: { current: boolean };
  readonly finalPendingRef: { current: boolean };
  readonly clearFallbackTimer: () => void;
  readonly voiceRef: {
    current: { resolveStreaming: (text: string) => void; transcribeNow: () => void };
  };
  readonly setInterim: (value: string | null) => void;
  readonly setStreamDegraded: (value: boolean) => void;
}

export function useStewardVoiceSttFrames(deps: StewardVoiceSttFramesDeps): void {
  const {
    subscribeSttFrames,
    streamArmedRef,
    streamIdRef,
    streamDeadRef,
    finalPendingRef,
    clearFallbackTimer,
    voiceRef,
    setInterim,
    setStreamDegraded,
  } = deps;

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
        const accumulated = `${prior}${text}${stash}`;
        setInterim(accumulated);
        // 判定必经 final 路径（批 3b 链路重排后单轨化）：interim 级停止快通道
        // 已拆（绕声纹总闸的通道不复辟）——interim 帧仅上屏（字幕），停止判定
        // 延迟回到 final 级（VAD 收口+声纹+Jev 停止判定，判停即停）。
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
}
