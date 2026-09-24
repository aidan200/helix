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
 * B2 barge-in（V3b-3 全双工核心）：语音模式全程 RMS 采样（耳 meter 常开
 * ——rms-meter 注入面从「仅录音期」扩展全程，text 模式/面板关即收）；
 * speaking/asking 相位人声门（B3 双参：RMS 分档超阈 + ZCR 人声带 + 持续
 * ≥ 最短发声时长 + 停播后静默窗 + fired 闩锁，判定全在 steward-voice-machine
 * 纯函数面；门参数逐帧读偏好——设置面改参即时生效）→ 打断序 = ①stopSpeaking
 * 立即停播（UX 零延迟）②steward.interrupt（daemon abortInFlight 幂等善后
 * ——E-198 截断记账零改动）③listening 开 stt.stream.start 新流；新转写
 * final → steward.ask 新轮。触发帧特征入误触埋点（barge-in-trace 环形缓冲
 * ——校准数据面）。asking 相位可打断（旧轮让位新输入）；text 模式/mic
 * 不可用行为完全不变。
 *
 * B4 唤醒链（全局组合键手动开麦；B2-hotfix 语义修订：热键直通双工）：
 * 全局组合键（壳 tauri-plugin-global-shortcut，wake-hotkey 注册面单点）
 * → **直通双工对话**（listening 开麦即听——热键是显式用户手势，身份已
 * 确认；唤醒词门槛仅属未来「被动监听唤起」场景：麦克风常开等词防误
 * 触才需要词，热键会话二次确认语义冗余——B2-hotfix 修复「说完话零回应
 * + 待命 30s 超时光球消失」）。待命机制（wakeSession/超时收场/词剥离/
 * matchWakeWord）保留待被动监听批复用（热键路径 wakeRef 恒 null = 零行为）。
 * 组合键再按 / Esc = 关麦收场（cancelWake——duplex 落，在途 ask 轮不动）。
 * 唤醒词偏好仍可配置（被动监听批消费面）。
 *
 * B2 双工会话（全局语音批，设计稿 §3.2/§3.3）：挂载点从 StewardPanel 迁
 * 至 StewardVoiceLayer（光球层，app 壳级常驻）——open 参数（面板活跃）退
 * 役，采样/耳 meter 注入面改「双工会话活跃」（duplex 态内聚，语义同构平移
 * ——E-200 判据零改动）。组合键 → duplex=true + 欢迎语（speechOut 流式链
 * 复用，TR-200 闸不动）→ 待命/直通 listening → 终帧喂 ask → delta 字幕 +
 * TTS → 播毕自动续听（直到关麦）。关麦（组合键再按，D2 单键 toggle）=
 * 停采集（track.stop 即刻零转写，ed508171 同纪律）+ 停朗读（synthesize stop
 * + 队列清空）+ duplex=false 光球淡出；**不动在途 ask 轮**（零 interrupt/
 * abortInFlight，结果照常落历史，D6）。临时静音（D5）：listening 点击
 * toggleMute → 续听挂起（停采集），再按恢复。口令拦截（D3=b）：终帧文本
 * 先过 onFinalText 钩子——返回 consumed 即前端本地消费（零 ask，语音口令
 * 面 voice-command.ts）。
 *
 * 异常回退（纯面 planTranscript）：ask 发送失败（未连接）→ 转写文本回填
 * voiceDraft（面板采纳进输入框——文本态可重试，零静默丢话）；转写失败 →
 * useVoiceInput error 面（面板 toast，Composer 同构）。
 *
 * 双模（mode）：面板双模 UI 已随 B2 面板语音退役——mode 恒 voice；mic 不可用
 * （unsupported）自动回退 text（朗读闸零合成防御保留）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { useVoiceInput } from "@/shared/lib/useVoiceInput";
import { createWorkletRmsMeter, type RmsMeter, type RmsMeterFactory } from "@/shared/lib/rms-meter";import type { PcmPumpFactory } from "@/shared/lib/pcm-pump";
import { pcmFrameToBase64 } from "@/shared/lib/pcm-pump";
import type { SpeechPlayerFactory } from "@/shared/lib/pcm-player";
import { readSttProviderPref } from "@/shared/lib/stt-provider-pref";
import {
  readTtsVoicePref,
  readVoiceVolumePref,
  readStewardSpeakReplyPref,
  readVoiceVadSensitivityPref,
  readVoiceMinDurationPref,
  readVoiceSilenceWindowPref,
  readVoiceCheckPref,
  readZcrTolerancePref,
  voiceRmsThresholdFromSensitivity,
} from "@/shared/lib/voice-pref";
import { setWakeHotkeyFireHandler, syncWakeHotkeyRegistration } from "@/shared/lib/wake-hotkey";
import { recordBargeInTrace } from "@/shared/lib/barge-in-trace";
import type { MeterFrame } from "@/shared/lib/rms-meter";
import type { EventEnvelope } from "@helix/protocol";
import { useSteward, type StewardPanelItem } from "./useSteward";
import { StewardSpeechOut } from "./steward-speech-out";
import {
  deriveStewardVoicePhase,
  shouldSpeakReply,
  mdToSpeechText,
  planTranscript,
  matchWakeWord,
  stepBargeInGate,
  openBargeInSilenceWindow,
  isBargeInArmed,
  INITIAL_BARGE_IN_GATE,
  type BargeInGateState,
  type StewardInputMode,
  type StewardVoicePhase,
} from "./steward-voice-machine";

/** 唤醒会话态（B4；面板待命指示与 Esc 分流判据）。 */
export type StewardWakeState = "off" | "standby" | "round";

/** 唤醒会话快照（唤醒词进入待命时定格 + 命中位；null = 无会话）。 */
interface WakeSession {
  readonly word: string;
  readonly hit: boolean;
}

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
  /** 唤醒待命超时 ms（缺省 wakeTimeoutPref（可配 30s）；测试注入短窗）。 */
  readonly wakeTimeoutMs?: number;
  /** 流式朗读播放器工厂（缺省 Web Audio；测试注入 fake——jsdom 无音频设备）。 */
  readonly createPlayer?: SpeechPlayerFactory;
  /** B2 欢迎语文本（缺省 i18n 常量；Layer 注入）。 */
  readonly welcomeText?: string;
  /** B2 终帧拦截钩（D3=b 语音口令）：返回 "consumed" = 前端本地消费零 ask
   *  （口令解析/执行面 voice-command.ts + StewardVoiceLayer）；"pass" = 照发。 */
  readonly onFinalText?: (text: string) => "consumed" | "pass";
}

export interface UseStewardVoice {
  // ── useSteward 整面透传（面板数据面不二开；A1：messages → items 过程条目）──
  readonly items: readonly StewardPanelItem[];
  readonly streamingText: string | null;
  readonly feed: ReturnType<typeof useSteward>["feed"];
  readonly askInFlight: boolean;
  readonly config: ReturnType<typeof useSteward>["config"];
  ask(text: string): boolean;
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
  /** 唤醒会话态（B4）：off 无 / standby 唤醒待命中（命中前）/ round 唤醒轮
   *  （命中后——既有 listening 同链）。 */
  readonly wakeState: StewardWakeState;
  /** 手动退出唤醒会话（Esc / 组合键再按）：取消收场关麦，零 ask。B2 起
   *  = duplex 会话收口（停采集 + 停朗读 + duplex 落）。 */
  cancelWake(): void;
  // ── B2 双工会话面（光球层数据源）──
  /** 双工会话活跃（组合键开 → 关麦收口落；光球可见性/耳 meter 采样窗）。 */
  readonly duplexActive: boolean;
  /** 欢迎语期（duplex 开启后、用户第一句定稿前——光球 welcome 相位）。 */
  readonly welcomeActive: boolean;
  /** 临时静音（D5：listening 点击切换——静音期续听挂起，duplex 会话保持）。 */
  readonly muted: boolean;
  /** D5 点击行为：listening 点击 = 临时静音切换（speaking 停读归 stopSpeaking）。 */
  toggleMute(): void;
  /** B2 光球唤起入口（wake-hotkey / steward-open-signal 接线共径——Layer 消费）。 */
  toggleWake(): void;
  /** B2 主动发言（欢迎语/口令回读同链；money 闸内判——偏好关零合成）。 */
  say(text: string): void;
}

export function useStewardVoice(options?: UseStewardVoiceOptions): UseStewardVoice {
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
    sendStewardInterrupt,
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
    sendStewardInterrupt?: (reason?: string) => boolean;
  };
  const steward = useSteward(); // B1 订阅解绑：无参（订阅不随面板开合）

  // ── B2 双工会话态（open 参数退役——采样/耳面改 duplex 会话活跃驱动；
  //    duplexRef = 回调面镜像（listener 闭包读实时态），duplexActive = 光球
  //    可见性呈现面；两处同点写归 markDuplex（TR-173 禁渲染体裸写镜像 ref）──
  const [duplexActive, setDuplexActive] = useState(false);
  const duplexRef = useRef(false);
  const markDuplex = useCallback((v: boolean) => {
    duplexRef.current = v;
    setDuplexActive(v);
  }, []);
  /** 欢迎语期标记（duplex 开启置位；用户第一句终帧定稿清位——光球 welcome 相位）。 */
  const [welcomeActive, setWelcomeActive] = useState(false);
  /** B2 临时静音（D5）：静音期续听挂起（自动重听闸），duplex 会话保持。 */
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  /** 终帧拦截钩（D3=b 口令）：ref 转发实时读（onTranscript 闭包不随重渲染刷新）。 */
  const onFinalTextRef = useRef(options?.onFinalText);
  onFinalTextRef.current = options?.onFinalText;

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
  // ── B2 barge-in 触发面（V3b-3）：门状态 + 相位镜像 + 触发闭包转发 ──
  const bargeInGateRef = useRef<BargeInGateState>(INITIAL_BARGE_IN_GATE);
  const phaseRef = useRef<StewardVoicePhase>("idle");
  const bargeInRef = useRef<() => void>(() => {});
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
    // 停播即开残响静默窗（B2：防 TTS 残响被耳 meter 再触发——静音钮/打断同径；
    // B3：窗长取偏好值，设置面改参即时生效）
    bargeInGateRef.current = openBargeInSilenceWindow(bargeInGateRef.current, Date.now(), readVoiceSilenceWindowPref());
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

  // ── B2 欢迎语（进入双工时 TTS；字幕同步归 Layer）：speechOut 主动发言
  //    入口 sayNow（切句发流——闸/播放队列全复用，TR-200 播放闸零改动）；
  //    money 闸同构（偏好关零合成，字幕照显）。──
  const { t } = useI18n();
  const say = useCallback(
    (text: string) => {
      if (
        !shouldSpeakReply({ mode: "voice", speakEnabled: readStewardSpeakReplyPref(), askResult: { status: "answer" } })
      ) {
        return;
      }
      speechOut.sayNow(text);
    },
    [speechOut],
  );
  const welcomeTextRef = useRef(options?.welcomeText);
  welcomeTextRef.current = options?.welcomeText;
  const speakWelcome = useCallback(() => {
    say(welcomeTextRef.current ?? t("steward.voice.welcome"));
  }, [say, t]);

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

  // ── B2 barge-in 门帧消费（耳 meter 回调；armed = 相位派生）──
  // B3：门参数逐帧读偏好（灵敏度→阈值映射/最短发声/静默窗/双参判定/容忍带）
  // + 门限分档（phase 抬档防 TTS 自声回灌）——设置面改偏好，下一次门判定即用
  // 新值（不必重开麦）；触发帧特征入误触埋点环形缓冲（校准数据面）。
  const onBargeInLevel = useCallback((frame: MeterFrame) => {
    const armed = isBargeInArmed({ mode: modeRef.current, phase: phaseRef.current });
    const atMs = Date.now();
    const out = stepBargeInGate(bargeInGateRef.current, {
      rms: frame.rms,
      zcr: frame.zcr,
      atMs,
      armed,
      phase: phaseRef.current,
      threshold: voiceRmsThresholdFromSensitivity(readVoiceVadSensitivityPref()),
      minDurationMs: readVoiceMinDurationPref(),
      silenceWindowMs: readVoiceSilenceWindowPref(),
      voiceCheck: readVoiceCheckPref(),
      zcrTolerance: readZcrTolerancePref(),
    });
    bargeInGateRef.current = out.state;
    if (out.trigger) {
      recordBargeInTrace({ at: atMs, rms: frame.rms, zcr: frame.zcr, phase: phaseRef.current });
      bargeInRef.current();
    }
  }, []);

  // ── B2 barge-in 耳朵：双工会话期 RMS 采样（duplex 活跃 × 语音模式；
  //    meter 注入面从「面板活跃」平移「双工会话活跃」——语义同构，判据
  //    零改动 E-200；duplex 落即刻 track.stop。mic 不可用/被拒 → barge-in
  //    降级关闭，语音主链不受影响）──
  const earMeterFactoryRef = useRef(options?.createMeter ?? createWorkletRmsMeter);
  earMeterFactoryRef.current = options?.createMeter ?? createWorkletRmsMeter;
  useEffect(() => {
    if (!duplexActive || mode !== "voice") return;
    if (typeof navigator === "undefined" || navigator.mediaDevices === undefined) return;
    let cancelled = false;
    let meter: RmsMeter | null = null;
    let stream: MediaStream | null = null;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        const created = await earMeterFactoryRef.current(stream);
        if (created === null || cancelled) {
          created?.close();
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        meter = created;
        created.onLevel((frame) => {
          if (cancelled) return;
          onBargeInLevel(frame);
        });
      } catch {
        // 麦不可用/被拒：barge-in 降级关闭（环境面——语音主链不受影响）
      }
    })();
    return () => {
      cancelled = true;
      meter?.close();
      if (stream !== null) for (const track of stream.getTracks()) track.stop();
    };
  }, [duplexActive, mode, onBargeInLevel]);
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

  // ── B4 唤醒会话（组合键 → 待命 → 唤醒词命中 → 唤醒轮）：会话态单点 ──
  // wakeRef = 回调面镜像（listener 闭包读实时态），wakeSession = 响应式呈现面；
  // 两处同点写归 markWakeSession（TR-173：禁渲染体裸写镜像 ref）。
  const [wakeSession, setWakeSession] = useState<WakeSession | null>(null);
  const wakeRef = useRef<WakeSession | null>(null);
  const wakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markWakeSession = useCallback((s: WakeSession | null) => {
    wakeRef.current = s;
    setWakeSession(s);
  }, []);
  const wakeState: StewardWakeState =
    wakeSession === null ? "off" : wakeSession.hit ? "round" : "standby";
  const clearWakeTimer = useCallback(() => {
    if (wakeTimerRef.current !== null) {
      clearTimeout(wakeTimerRef.current);
      wakeTimerRef.current = null;
    }
  }, []);

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
  const wakeTimeoutMsRef = useRef(options?.wakeTimeoutMs);
  wakeTimeoutMsRef.current = options?.wakeTimeoutMs;
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

  // 双工会话收口（B2 扩展：组合键再按（D2 单键 toggle 关麦）/ Esc / 待命
  // 超时 / 口令期收场共径）：关麦（track.stop 即刻零转写，ed508171 同纪律）
  // + 废流（stt.stream.stop）+ 停朗读（synthesize stop + 队列清空）+
  // duplex 落（光球淡出数据面）+ 静音/欢迎语位复位。**不动在途 ask 轮**
  //（零 interrupt/abortInFlight——结果照常落历史，D6）。流 refs 收位防孤儿
  // timer/上行（money 纪律）。
  const cancelWake = useCallback(() => {
    clearWakeTimer();
    markWakeSession(null);
    clearFallbackTimer();
    finalPendingRef.current = false;
    streamIdRef.current = null;
    if (streamArmedRef.current && !streamDeadRef.current) {
      streamSendersRef.current.sendSttStreamStop?.();
    }
    streamArmedRef.current = false;
    streamDeadRef.current = true;
    setInterim(null);
    voiceRef.current.cancel();
    if (duplexRef.current) {
      stopSpeaking(); // D6 停朗读（队列清空 + 残响静默窗）
      markDuplex(false);
      setWelcomeActive(false);
      mutedRef.current = false;
      setMuted(false);
    }
  }, [clearWakeTimer, markWakeSession, clearFallbackTimer, stopSpeaking, markDuplex]);

  const handleTranscript = useCallback(
    (text: string) => {
      // 转写消费门（幽灵 ask/TTS 防线）：duplex 双工活跃、唤醒会话（B4）、
      // 或录音/转写在途相位（V3a 手动单轮）任一成立才消费；否则零 ask 零朗
      // 读（4282f4ca 同根族：与 useVoiceInput 迟归代数守卫分层，状态面漏网时
      // 行为面兕底——关掉的管家不开口）。拦截面含关麦后残影 asking/speaking
      //（旧 ask 轮在途/在朗读——D6 不 abort，但迟到转写不得借道开新轮）。
      if (
        !duplexRef.current &&
        wakeRef.current === null &&
        phaseRef.current !== "listening" &&
        phaseRef.current !== "transcribing"
      )
        return;
      // B2 welcome 相位收口：用户第一句定稿（VAD 静音丢弃轮不至此）
      setWelcomeActive(false);
      /** 即将 ask 的文本路由：口令拦截（D3=b）优先——consumed 零 ask。 */
      const routeToAsk = (utterance: string) => {
        if (onFinalTextRef.current?.(utterance) === "consumed") return;
        const sent = askRef.current(utterance);
        const plan = planTranscript(utterance, sent);
        if (plan.kind === "fallback") setVoiceDraft(plan.draft);
      };
      const wake = wakeRef.current;
      if (wake !== null) {
        // B4 唤醒轮收口：剥离唤醒词前缀（命中前内容不入对话）；未命中防御面
        // 零 ask——剩余话语（含本轮续句）走既有 ask 链
        markWakeSession(null);
        clearWakeTimer();
        const m = matchWakeWord(text, wake.word);
        const rest = m.hit ? m.rest.trim() : "";
        if (rest === "") return; // 只剩唤醒词/未命中：零 ask（空弃同构零计费）
        routeToAsk(rest);
        return;
      }
      routeToAsk(text);
    },
    [markWakeSession, clearWakeTimer],
  );
  const voice = useVoiceInput(handleTranscript, {
    sendSttTranscribe,
    subscribeSttFrames,
    onPcmFrame,
    deferredTranscribe: true,
    onDeferredHold,
    // B4：唤醒待命期（命中前）静音自动停挂起（等唤醒词不被 ~1.8s 静音误收）；
    // 命中后/普通轮照旧（既有 VAD 语义零改动）
    allowSilenceStop: () => wakeRef.current === null || wakeRef.current.hit,
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
          if (wakeRef.current !== null && !wakeRef.current.hit) {
            // B4 待命期开流失败 = 无法本地匹配：取消收场（非流式回落对唤醒
            // 匹配无意义——不留盲开麦）
            cancelWake();
            return;
          }
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
        // B4 唤醒词本地匹配（webview 判定零后置花费；命中前内容不入对话）
        const wake = wakeRef.current;
        if (wake !== null && !wake.hit) {
          const m = matchWakeWord(accumulated, wake.word);
          if (m.hit) {
            markWakeSession({ word: wake.word, hit: true }); // 命中 → 转入既有 listening 流
            clearWakeTimer();
          }
        }
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
  }, [subscribeSttFrames, clearFallbackTimer, cancelWake, markWakeSession, clearWakeTimer]);

  // 听音本体（手动点击与 barge-in 共用）：流式复位 + 开流（同步发——失败
  // 静默降级）+ 录音启动；不带停播序（调用方按打断序安排）
  const beginListening = useCallback(async () => {
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
  }, [clearFallbackTimer]);

  // B2 barge-in 打断序（①②③不可换序——UX 与一致性分离）：①立即停播
  // （零延迟）②steward.interrupt（daemon abortInFlight 幂等善后）③进
  // listening 开 stt.stream.start 新流；新转写 final → steward.ask 新轮。
  const bargeIn = useCallback(() => {
    stopSpeaking(); // ①（含残响静默窗）
    const interruptOk = sendStewardInterrupt?.("barge-in") ?? false; // ②
    if (interruptOk === false) {
      // 未连接：打断帧未达 daemon——本地停播即事实（零回滚）；后续 ask
      // 发送失败走 voiceDraft 回填既有降级（零静默丢话）
    }
    void beginListening(); // ③
  }, [stopSpeaking, beginListening, sendStewardInterrupt]);
  bargeInRef.current = bargeIn;

  // 新一轮说话 = 停上轮朗读 + 听音本体（手动 barge-in 同构先序）
  const startListening = useCallback(async () => {
    stopSpeaking();
    await beginListening();
  }, [stopSpeaking, beginListening]);

  const stopListening = useCallback(() => {
    voiceRef.current.stop();
  }, []);

  // ── B2 双工听音锁（重入防护）：beginListening 的 getUserMedia 窗口内
  //    stateRef 仍 idle——自动续听 effect 与 toggleWake 并发触发会双开麦；
  //    锁内串行（useVoiceInput 自身 stateRef 守卫在 await 后才生效）。──
  const beginListeningLockRef = useRef(false);
  const guardedBeginListening = useCallback(async () => {
    if (beginListeningLockRef.current) return;
    beginListeningLockRef.current = true;
    try {
      await beginListening();
    } finally {
      beginListeningLockRef.current = false;
    }
  }, [beginListening]);

  // ── B2 唤醒链 toggle（全局组合键唯一入口；D2 单键 toggle）：无会话 →
  //    进双工（光球浮现 + 欢迎语 + 持续麦）；duplex 在途（待命/对话链）→
  //    关麦收口（D6）。──
  const toggleWake = useCallback(async () => {
    // 关麦收口（D2 再按）：duplex 在途或唤醒会话在途 → cancelWake 收场
    if (duplexRef.current || wakeRef.current !== null) {
      cancelWake();
      return;
    }
    const phase = phaseRef.current;
    // mic 不可用 / 录音链在途 no-op；speaking 相位进待命 = 手动开麦同构先序
    // （先停播——duplex 外的残留朗读）
    if (phase === "unsupported" || phase === "listening" || phase === "transcribing" || phase === "asking") {
      return;
    }
    stopSpeaking();
    setModeState("voice");
    // B2 双工开場：duplex 置位（光球可见/耳 meter 采样窗）+ 欢迎语
    //（speechOut 流式链复用——TR-200 闸不动；money 闸：偏好关零合成字幕照显）
    markDuplex(true);
    setWelcomeActive(true);
    speakWelcome();
    // B2-hotfix：热键 = 显式用户手势，直通双工——不设唤醒词门槛、不启动
    // 待命超时（门槛仅属未来「被动监听唤起」场景；待命机制保留零行为）。
    markWakeSession(null);
    await guardedBeginListening();
  }, [cancelWake, guardedBeginListening, stopSpeaking, markWakeSession, markDuplex, speakWelcome]);
  const toggleWakeRef = useRef(toggleWake);
  toggleWakeRef.current = toggleWake;
  /** 光球入口（ref 定格——Layer 接线稳定引用）。 */
  const toggleWakeStable = useCallback(() => {
    void toggleWakeRef.current();
  }, []);

  // 全局组合键注册面（wake-hotkey 单点）：挂载即读偏好注册（壳不读
  // ~/.helix/，偏好读取全在前端——红线不破）；卸载清位。
  useEffect(() => {
    setWakeHotkeyFireHandler(() => {
      void toggleWakeRef.current();
    });
    void syncWakeHotkeyRegistration();
    return () => setWakeHotkeyFireHandler(null);
  }, []);

  // Esc = 手动退出并关麦（B2-hotfix：直通后 wakeState 恒 off——监听挂 duplex
  // 会话期；待命态遗留条件保留：被动监听批复用时待命期 Esc 仍可用）
  useEffect(() => {
    if (wakeState === "off" && !duplexActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelWake();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wakeState, duplexActive, cancelWake]);

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
  const phase = deriveStewardVoicePhase({
    voiceState: voice.state,
    askInFlight: steward.askInFlight,
    speaking,
    wakeStandby: wakeState === "standby",
  });
  // B2：相位镜像（耳帧回调读实时态）+ 离开可打断相位复位门闩锁（下一轮可
  // 再触发；静默窗跨轮保留——残响防线）
  phaseRef.current = phase;
  useEffect(() => {
    if (!isBargeInArmed({ mode, phase })) {
      bargeInGateRef.current = stepBargeInGate(bargeInGateRef.current, { rms: 0, atMs: Date.now(), armed: false }).state;
    }
  }, [mode, phase]);
  useEffect(() => {
    if (phase === "unsupported") setModeState("text");
  }, [phase]);

  // interim 出态清理（listening/transcribing/wake_armed 外不残留浮字——
  // 待命期浮字 = 唤醒匹配进度可视（命中前内容只上屏不入对话））
  useEffect(() => {
    if (phase !== "listening" && phase !== "transcribing" && phase !== "wake_armed") setInterim(null);
  }, [phase]);

  // ── B2 双工循环（设计稿 §3.3）：duplex 中说完（回 idle 且无唤醒会话）
  //    → 自动续听（新 stt.stream.start，VAD 分段继续听直到关麦）；边沿触发
  //    （离开 idle 重新武装防重复）+ muted 挂起（D5）+ 重入锁。──
  const relistenArmedRef = useRef(true);
  useEffect(() => {
    if (!duplexActive) {
      relistenArmedRef.current = true; // 会话外重置（下双工首轮武装）
      return;
    }
    const idle = phase === "idle" && wakeState === "off";
    if (!idle) {
      relistenArmedRef.current = true;
      return;
    }
    if (!relistenArmedRef.current || mutedRef.current) return;
    relistenArmedRef.current = false;
    void guardedBeginListening();
  }, [duplexActive, phase, wakeState, muted, guardedBeginListening]);

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

  // ── B2 临时静音（D5 光球点击）：listening 点击 = 静音（停采集——麦克风
  //    指示落地，duplex 会话保持，自动续听挂起）；再点恢复（自动续听边沿
  //    重启）。speaking 相位点击归 stopSpeaking（Layer 按相位分发）。──
  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (!next) return; // 恢复路径：muted 落 → 自动续听 effect 边沿重启
    voiceRef.current.cancel(); // 静音即停采集（track.stop 即刻）
    if (streamArmedRef.current && !streamDeadRef.current) {
      streamSendersRef.current.sendSttStreamStop?.();
    }
    streamArmedRef.current = false;
    streamDeadRef.current = true;
    streamIdRef.current = null; // 单飞门控同步收位（静音期迟到 final 零消费）
    setInterim(null);
    relistenArmedRef.current = true; // 恢复后首轮武装
  }, []);

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
    wakeState,
    cancelWake,
    startListening,
    stopListening,
    stopSpeaking,
    clearVoiceDraft: useCallback(() => setVoiceDraft(null), []),
    duplexActive,
    welcomeActive,
    muted,
    toggleMute,
    toggleWake: toggleWakeStable,
    say,
  };
}
