/**
 * useVoiceInput —— 录音 + 转写状态机（V2：点击开始 / VAD 静音自动停 /
 * 点击强制停；V3a 自 features/send-message/model 下移 shared——管家语音
 * 模式跨 feature 复用，AG-15 FSD 同层禁互引，MarkdownMessage 下移先例
 * 同构 git mv 保历史）。
 *
 * 归属变化的两点适配（语义零变）：
 * - DI 注入面：shared 层禁引 entities（AG-15）——sendSttTranscribe /
 *   subscribeSttFrames 由消费方从各自 SessionContext 取出注入
 *   （Composer 与 StewardDock 两消费面）；
 * - 单飞门控落地：stt.transcribe.result / connection.error 仅
 *   transcribing 态消费（docblock 原始声明「单飞门控」补齐实现——两消费
 *   面并存后，idle 态吞外来回执防串台：管家语音的转写结果不得回填
 *   Composer 草稿，反向同然）。
 *
 * 链路（设计 §4 + V2 改造）：点击开始 → getUserMedia({audio}) →
 * MediaRecorder（mime 序 audio/webm;codecs=opus → audio/webm → audio/mp4，
 * spike 实测支持面；64k 码率）+ RMS meter（AudioWorklet 主/Analyser 兜底，
 * rms-meter.ts）→ 电平帧驱动 VAD 门（收口门共基，语音判定钝感批）：开口
 * = 单帧人声判据 isVoiceLikeFrame（rms ≥ 阈值 × ZCR 人声带，与插话打断门
 * 物理同源；阈值逐帧读灵敏度偏好或 getRmsThreshold 注入）刷新 lastLoud，
 * 自 max(开始+LEAD_IN, lastLoud) 起连续静音 ≥ VOICE_SILENCE_STOP_MS →
 * 自动停。录音中点击 = 强制停（显式意图，不看 spoke）。停 → blob →
 * base64 data URL → sendSttTranscribe（注入面）→ 回执经 subscribeSttFrames
 * （注入面）→ onResult 回调（消费方各自的最后一道闸）。
 *
 * VAD 丢弃：自动停且（全程无人声判据帧 || 有效发声累计 < VOICE_SPEECH_MIN_MS
 * 250ms）→ 直接回 idle 零转写零计费（静音片/短促噪声不值得一次 ASR 调用
 * ——噪声幻听兑底闸）；强制停不看此闸（用户显式收口，宁可转写不丢话）。
 *
 * 状态机：idle → recording（点击）→ transcribing（上传/转写中）→ idle
 * （ok/error 收口）。三态互斥：transcribing 态 start() no-op（防二次
 * getUserMedia 打开新麦克风流）。
 *
 * 环境防御：navigator.mediaDevices 缺失（tauri dev 裸二进制无授权历史，
 * TR-177 先问环境）→ unsupported 态 + 引导；getUserMedia 拒绝 → error
 * 态 + 原因；meter 创建失败（无 AudioContext/addModule 拒绝且兜底亦败）
 * → VAD 降级关闭，保留点击手动停（录音功能不因计量缺失而不可用）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/shared/i18n";
import { readSttProviderPref } from "@/shared/lib/stt-provider-pref";
import { createWorkletRmsMeter, type RmsMeterFactory, VOICE_METER_INTERVAL_MS } from "./rms-meter";
import { createWorkletPcmPump, type PcmPumpFactory } from "./pcm-pump";
import { isVoiceLikeFrame } from "./voice-gate";
import {
  readVoiceCheckPref,
  readVoiceVadSensitivityPref,
  readZcrTolerancePref,
  voiceRmsThresholdFromSensitivity,
} from "./voice-pref";
import type { EventEnvelope } from "@helix/protocol";

export type VoiceState = "unsupported" | "idle" | "recording" | "transcribing";

/** MediaRecorder 码率（64kbps——语音 opus 足量，spike 实测 156kbps 可压）。 */
const AUDIO_BITS_PER_SECOND = 64_000;

/** VAD 开口判定阈值（RMS ≥ 此值视为有声帧；mic 增益常态语音 0.05-0.3，取低阈保守）。
 *  定义已迁 shared/lib/voice-gate（两门共基唯一定义点）；此处 re-export 保
 *  兼容（E-221 物化锚 useVoiceInput.ts#VOICE_RMS_THRESHOLD 仍在文件面）。 */
export { VOICE_RMS_THRESHOLD } from "./voice-gate";

/** 连续静音自动停窗口（ms；brief 口径 1.5-2s，取 1.8s 中档——常量可调）。 */
export const VOICE_SILENCE_STOP_MS = 1_800;

/** 开口前置宽限（ms）：静音时钟起点 = max(开始+本值, 最后有声帧)——
 *  点击后先给开口窗口，防「点了还没来得及说话就被判静音截断」。 */
export const VOICE_LEAD_IN_MS = 1_200;

/** 最短有效录音（ms）：短于此不转写（误触防静音幻觉计费）。 */
export const VOICE_MIN_DURATION_MS = 300;

/** 有效发声时长闸（ms，语音判定钝感批）：自动收口时累计「人声判据帧」时长
 *  不足此值 → 按未开口丢弃（零转写零计费——噪声幻听拿去回答的兑底闸：
 *  短促噪声帧即使过了双参判据也不足以构成一次说话）；点击强制停不看此闸
 *  （显式收口宁转写不丢话）。帧级累计粒度 = VOICE_METER_INTERVAL_MS ≈100ms。 */
export const VOICE_SPEECH_MIN_MS = 250;

/** 开口保持窗（ms）：最近人声判据帧距今超出此窗 → userSpeaking 回落 false
 *  （说完话 ~0.9s 光球回待机——词间停顿不闪断；比静音自动停 1.8s 早，
 *  视觉先行回待机、链路收口在后）。 */
export const VOICE_SPEAKING_HOLD_MS = 900;

/** 电平显示增益（RMS→可视电平；常态说话 RMS ~0.1 → 电平 ~0.6）。 */
const VOICE_LEVEL_GAIN = 6;

/** 电平显示衰减系数（每帧无声衰减到 72%——电平条回落动画数据源）。 */
const VOICE_LEVEL_DECAY = 0.72;

/** mime 选择序（spike 实测 isTypeSupported 支持面）。 */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const mime of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return undefined;
}

/** useVoiceInput 注入面（shared 零 entities 依赖——SessionContext 命令/订阅面由消费方注入；测试注入 fake meter/pump 驱动 VAD 帧）。 */
export interface UseVoiceInputOptions {
  /** stt.transcribe 发送面（SessionContext COMMAND_SURFACE；缺省不发——防御测试形态）。 */
  readonly sendSttTranscribe?: (audio: string, opts?: { language?: string; provider?: string }) => boolean;
  /** stt 帧订阅面（SessionContext LISTEN_SURFACE；缺省不订阅）。 */
  readonly subscribeSttFrames?: (listener: (e: EventEnvelope) => void) => () => void;
  /** RMS meter 工厂（缺省 createWorkletRmsMeter；测试注入 fake 驱动 VAD 帧）。 */
  readonly createMeter?: RmsMeterFactory;
  /**
   * PCM 帧回调（V3b-1 流式面）：传入即挂 pcm-pump worklet（与 meter 同流
   * 共存），每 ~100ms 回调 Int16 PCM 16k mono ArrayBuffer。不传 = V3a
   * 行为零感知（Composer 非流式链路不挂泵）。
   */
  readonly onPcmFrame?: (frame: ArrayBuffer) => void;
  /** PCM 泵工厂（缺省 createWorkletPcmPump；测试注入 fake）。 */
  readonly createPump?: PcmPumpFactory;
  /**
   * 停录不自动上传（V3b-1 流式收口面）：stop 后停留 transcribing 态持
   * blob，经 resolveStreaming(text)（流式终帧收口）或 transcribeNow()
   *（回落非流式）出态；onDeferredHold 在 blob 就位后回调（消费方在此
   * 判流式在途与否决定 finish/回落）。缺省 false = V3a 行为（停即上传）。
   */
  readonly deferredTranscribe?: boolean;
  /** deferred 态 blob 就位回调（每轮 stop 恰一次；消费方读自家流式 refs 决策）。 */
  readonly onDeferredHold?: () => void;
  /**
   * VAD 静音自动停闸（逐帧读，B4 唤醒待命用）：false = 静音自动停挂起
   *（待命期等唤醒词，不被 ~1.8s 静音误收）；缺省恒 true = V2 行为不变。
   */
  readonly allowSilenceStop?: () => boolean;
  /**
   * VAD 阈值注入面（逐帧读，语音判定钝感批；allowSilenceStop 同构先例）：
   * 缺省 = 灵敏度偏好映射 voiceRmsThresholdFromSensitivity(
   * readVoiceVadSensitivityPref())——与插话打断门同源；底噪校准
   *（useStewardVoice）注入 max(偏好, 底噪×2.5) 有效阈值，两门共基单点。
   */
  readonly getRmsThreshold?: () => number;
}

export interface VoiceInput {
  readonly state: VoiceState;
  /** 实时电平（0..1，帧驱动平滑；recording 外恒 0）——三态可视化电平条数据源。 */
  readonly level: number;
  /** 用户正在发声（最近 VOICE_SPEAKING_HOLD_MS 内有人声判据帧；recording
   *  外恒 false）——光球相位细分数据源：开麦未开口 ≠ 倾听（待机驻留）。 */
  readonly userSpeaking: boolean;
  /** 最近一次失败原因（idle 后保留供 toast 消费；开始新录音即清）。 */
  readonly error: string | null;
  /** 点击开始录音（unsupported/transcribing 态 no-op）。 */
  start: () => Promise<void>;
  /** 停止录音并发起转写（录音中点击 = 强制停；VAD 自动停走内部路径）。 */
  stop: () => void;
  /**
   * 流式终帧收口（V3b-1；仅 deferred 态生效）：text 非空 → onTranscript(text)
   * 收口回 idle；空/空白 → 丢弃回 idle（零转写零计费同构——全程静音语义）。
   * 他态 no-op（返回 false）。
   */
  resolveStreaming(text: string): boolean;
  /**
   * 回落非流式（V3b-1；仅 deferred 态生效）：把持有 blob 走既有上传转写
   * 链（回执消费照旧）。他态 no-op。
   */
  transcribeNow(): void;
  /**
   * 取消收口（B4 唤醒待命超时/手动退出）：立即关麦（track.stop）+ 废弃
   * 录音/持有 blob/在途回执位，零转写零计费（不看 spoke 不入转写链——
   * 与 stop 的「显式收口宁转写不丢话」语义分道）。
   */
  cancel: () => void;
}

export function useVoiceInput(onTranscript: (text: string) => void, options?: UseVoiceInputOptions): VoiceInput {
  const { t } = useI18n();
  const sendSttTranscribe = options?.sendSttTranscribe;
  const subscribeSttFrames = options?.subscribeSttFrames;
  const deferredTranscribe = options?.deferredTranscribe === true;
  const onPcmFrame = options?.onPcmFrame;
  const [state, setState] = useState<VoiceState>(() =>
    typeof navigator !== "undefined" && navigator.mediaDevices !== undefined && typeof MediaRecorder !== "undefined"
      ? "idle"
      : "unsupported",
  );
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [userSpeaking, setUserSpeaking] = useState(false);
  /** 最近人声判据帧时戳（userSpeaking 保持窗判据；null = 本轮未开口）。 */
  const lastVoiceLikeAtRef = useRef<number | null>(null);
  const userSpeakingRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const meterRef = useRef<ReturnType<RmsMeterFactory> extends Promise<infer T> ? T : never>(null);
  const pumpRef = useRef<ReturnType<PcmPumpFactory> extends Promise<infer T> ? T : never>(null);
  /** deferred 态持有的 blob（resolveStreaming/transcribeNow 消费）。 */
  const pendingBlobRef = useRef<Blob | null>(null);
  /** 回执单飞门控位（V3b-1）：仅自己发起的上传在途才消费 stt.transcribe.result——
   *  deferred 等终帧期间的外来回执（他面上传结果）不串台。 */
  const uploadInFlightRef = useRef(false);
  const spokeRef = useRef(false);
  const lastLoudAtRef = useRef(0);
  /** 人声判据帧累计时长（ms，有效发声闸）：连续判据帧按时戳差累计，静音帧
   *  断段重起；自动停时 < VOICE_SPEECH_MIN_MS 按未开口丢弃。 */
  const speechMsRef = useRef(0);
  const lastVoiceAtRef = useRef<number | null>(null);
  const levelRef = useRef(0);
  const stateRef = useRef<VoiceState>(state);
  /** 取消代数（修复排查）：cancel 递增——start 在 await getUserMedia 窗口内
   *  被 cancel 时，迟归 stream 凭代数失配立即释放，零孤儿开麦。 */
  const cancelGenRef = useRef(0);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const createMeter = options?.createMeter ?? createWorkletRmsMeter;
  const createMeterRef = useRef(createMeter);
  createMeterRef.current = createMeter;
  const createPump = options?.createPump ?? createWorkletPcmPump;
  const createPumpRef = useRef(createPump);
  createPumpRef.current = createPump;
  const onPcmFrameRef = useRef(onPcmFrame);
  onPcmFrameRef.current = onPcmFrame;
  const onDeferredHoldRef = useRef(options?.onDeferredHold);
  onDeferredHoldRef.current = options?.onDeferredHold;
  const allowSilenceStopRef = useRef(options?.allowSilenceStop);
  allowSilenceStopRef.current = options?.allowSilenceStop;
  const getRmsThresholdRef = useRef(options?.getRmsThreshold);
  getRmsThresholdRef.current = options?.getRmsThreshold;

  // 状态 ref 镜像（meter 帧回调闭包不随渲染刷新——帧回调读实时态；
  //  读画封装为函数：tsc 对 ref.current 的直线窄化不因跨函数调用重置，
  //  start() 内早退守卫会窄化后续读画——函数读打破假窄化）
  const isRecording = useCallback(() => stateRef.current === "recording", []);
  const setStateSafe = useCallback((next: VoiceState) => {
    stateRef.current = next;
    setState(next);
    if (next !== "recording") {
      levelRef.current = 0;
      setLevel(0);
      userSpeakingRef.current = false;
      lastVoiceLikeAtRef.current = null;
      setUserSpeaking(false);
    }
  }, []);

  // 回执消费（单飞门控：仅自己发起的上传在途才消费——两消费面并存
  //（Composer / 管家语音）后，idle/deferred 态吞外来回执防串台；daemon 业务
  // 失败走 error 判别，协议面错误走 connection.error——两者都收口回 idle +
  // error 交代）
  useEffect(() => {
    if (subscribeSttFrames === undefined) return;
    return subscribeSttFrames((event: EventEnvelope) => {
      if (stateRef.current !== "transcribing" || !uploadInFlightRef.current) return; // 非在途/非己发：外来回执不消费
      if (event.type === "stt.transcribe.result") {
        uploadInFlightRef.current = false;
        if (event.payload.status === "ok") {
          setError(null);
          setStateSafe("idle");
          onTranscriptRef.current(event.payload.text);
        } else {
          setError(String(event.payload.reason));
          setStateSafe("idle");
        }
      } else if (event.type === "connection.error") {
        uploadInFlightRef.current = false;
        setError(String((event.payload as { message?: string }).message ?? t("chat.voice.transcribeFail")));
        setStateSafe("idle");
      }
    });
  }, [subscribeSttFrames, setStateSafe, t]);

  const cleanupMedia = useCallback(() => {
    recorderRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    chunksRef.current = [];
  }, []);

  const closeMeter = useCallback(() => {
    const meter = meterRef.current;
    meterRef.current = null;
    meter?.close();
  }, []);

  const closePump = useCallback(() => {
    const pump = pumpRef.current;
    pumpRef.current = null;
    pump?.close();
  }, []);

  useEffect(
    () => () => {
      closeMeter();
      closePump();
      cleanupMedia();
    },
    [closeMeter, closePump, cleanupMedia],
  );

  /** 既有上传转写链（V3a 路径；deferred 回落 transcribeNow 复用同体）。
   *  取消代数守卫（4282f4ca 同根族）：关麦（cancel）落在 readAsDataURL
   *  在途窗口时，onload/onerror 迟归凭代数失配全弃——零上行（音频不离
   *  机）、零 transcribing 复活（否则回执守卫被复活值绕过 → 幽灵转写消费）。 */
  const uploadBlob = useCallback(
    (blob: Blob) => {
      const gen = cancelGenRef.current;
      const reader = new FileReader();
      reader.onload = () => {
        if (gen !== cancelGenRef.current) return; // 关麦已发生：零上行零状态复活
        if (sendSttTranscribe === undefined) {
          setStateSafe("idle");
          return;
        }
        // 设置页 provider 偏好随命令携带（缺省 auto = 不带，daemon 装配序自动选择）
        const provider = readSttProviderPref();
        const sent = sendSttTranscribe(String(reader.result), { language: "zh", ...(provider !== undefined ? { provider } : {}) });
        uploadInFlightRef.current = sent;
        setStateSafe(sent ? "transcribing" : "idle");
        if (!sent) setError(t("chat.voice.sendFail"));
      };
      reader.onerror = () => {
        if (gen !== cancelGenRef.current) return; // 关麦已发生：error 面不拉起
        setStateSafe("idle");
        setError(t("chat.voice.readFail"));
      };
      reader.readAsDataURL(blob);
    },
    [sendSttTranscribe, setStateSafe, t],
  );

  // ── 停止收口（双路径：点击强制停 fromVad=false / VAD 自动停 fromVad=true）──
  const stop = useCallback(
    (fromVad = false) => {
      const recorder = recorderRef.current;
      const wasRecording = isRecording();
      if (recorder === null || recorder === undefined || !wasRecording) {
        cleanupMedia();
        if (wasRecording) setStateSafe("idle");
        return;
      }
      const spoke = spokeRef.current;
      const speechMs = speechMsRef.current;
      const durationMs = Date.now() - startedAtRef.current;
      const stopGen = cancelGenRef.current; // onstop 迟归守卫（4282f4ca 同根族）：
      // 关麦落在 stop→onstop 异步窗口时，迟归 onstop 凭代数失配全弃。当前
      // 实际被 cancel 清空 chunksRef + blob.size===0 守卫双重堵死（单线程下
      // onstop 必在 cancel 后读空 chunks）——此守卫把「巧合安全」变为显式契约。
      closeMeter();
      closePump();
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        cleanupMedia();
        if (stopGen !== cancelGenRef.current) return; // 关麦已发生：零 blob 零状态复活零 deferred
        // VAD 丢弃：自动停且（全程无人声判据帧 || 有效发声不足 250ms）→
        // 零转写零计费（静音片/短促噪声不值一次 ASR 调用——噪声幻听兑底闸；
        // 点击强制停 fromVad=false 不看此闸：显式收口宁转写不丢话）
        if (fromVad && (!spoke || speechMs < VOICE_SPEECH_MIN_MS)) {
          setStateSafe("idle");
          return;
        }
        const blob = new Blob(chunks, { type: recorder.mimeType });
        if (blob.size === 0 || durationMs < VOICE_MIN_DURATION_MS) {
          // 过短录音（误触）：不发转写请求（防静音幻觉计费）
          setStateSafe("idle");
          return;
        }
        if (deferredTranscribe) {
          // V3b-1 流式收口面：持 blob 停留 transcribing，交消费方
          //（resolveStreaming/transcribeNow）出态
          pendingBlobRef.current = blob;
          setStateSafe("transcribing");
          onDeferredHoldRef.current?.();
          return;
        }
        uploadBlob(blob);
      };
      setStateSafe("transcribing"); // stop->onstop async gap placeholder (UI-invisible)
      recorder.stop();
    },
    [cleanupMedia, closeMeter, closePump, deferredTranscribe, uploadBlob, setStateSafe],
  );

  const start = useCallback(async () => {
    if (stateRef.current !== "idle") return;
    const startGen = ++cancelGenRef.current; // 领当代（窗口内 cancel 即失配）
    setError(null);
    if (typeof navigator === "undefined" || navigator.mediaDevices === undefined) {
      setStateSafe("unsupported");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 窗口内已取消（cancelWake/toggleMute/Esc…）：即刻释放迟归麦，零孤儿开麦
      if (startGen !== cancelGenRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const mime = pickMimeType();
      if (mime === undefined) throw new Error(t("chat.voice.noMime"));
      const recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      streamRef.current = stream;
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      spokeRef.current = false;
      speechMsRef.current = 0;
      lastVoiceAtRef.current = null;
      lastLoudAtRef.current = startedAtRef.current;
      lastVoiceLikeAtRef.current = null;
      userSpeakingRef.current = false;
      setUserSpeaking(false);
      recorder.start(250); // 250ms slices: tail chunk safe before stop
      setStateSafe("recording");

      // RMS meter 挂载（VAD 帧驱动；工厂失败/环境缺失 → VAD 降级关闭不阻断录音；
      // 降级不早退——pump 挂载在后，录音/流式不受 meter 缺席影响）
      try {
        const meter = await createMeterRef.current(stream);
        if (meter !== null && isRecording()) {
          meterRef.current = meter;
          meter.onLevel((frame) => {
            if (!isRecording()) return;
            // 电平显示平滑（loud 抬升/静音衰减——电平条数据源）
            const shown = Math.min(1, Math.max(frame.rms * VOICE_LEVEL_GAIN, levelRef.current * VOICE_LEVEL_DECAY));
            levelRef.current = shown;
            setLevel(shown);
            // VAD 门（收口门共基，语音判定钝感批）：单帧人声判据与插话打断门
            //（stepBargeInGate）物理同源（isVoiceLikeFrame）；阈值逐帧读——
            // getRmsThreshold 注入面（底噪校准消费）优先，缺省 = 灵敏度偏好
            // 映射；ZCR/voiceCheck 同参（meter 无 zcr 帧 → fail-open，行为同旧）
            const voiceLike = isVoiceLikeFrame(frame, {
              threshold: getRmsThresholdRef.current?.() ?? voiceRmsThresholdFromSensitivity(readVoiceVadSensitivityPref()),
              voiceCheck: readVoiceCheckPref(),
              zcrTolerance: readZcrTolerancePref(),
            });
            const now = Date.now();
            if (voiceLike) {
              spokeRef.current = true;
              lastLoudAtRef.current = now;
              // userSpeaking 保持窗抬升（翻转才 set——帧频 100ms 防渲染抖）
              lastVoiceLikeAtRef.current = now;
              if (!userSpeakingRef.current) {
                userSpeakingRef.current = true;
                setUserSpeaking(true);
              }
              // 有效发声累计：连续判据帧按时戳差累计（首帧计一拍；上限两拍——
              // meter 掉帧/时钟跳变不虚增）；静音帧断段重起
              speechMsRef.current +=
                lastVoiceAtRef.current === null
                  ? VOICE_METER_INTERVAL_MS
                  : Math.min(now - lastVoiceAtRef.current, VOICE_METER_INTERVAL_MS * 2);
              lastVoiceAtRef.current = now;
            } else {
              lastVoiceAtRef.current = null;
            }
            // userSpeaking 回落（保持窗外，非 recording 态帧早退不达此处）：
            // 静音帧也持续到帧——窗判定不依赖有声帧自带时钟
            if (
              userSpeakingRef.current &&
              lastVoiceLikeAtRef.current !== null &&
              now - lastVoiceLikeAtRef.current > VOICE_SPEAKING_HOLD_MS
            ) {
              userSpeakingRef.current = false;
              setUserSpeaking(false);
            }
            // 静音时钟自 max(开始+LEAD_IN, lastLoud) 起算；连续静音 ≥ STOP 收口
            const silenceSince = Math.max(startedAtRef.current + VOICE_LEAD_IN_MS, lastLoudAtRef.current);
            if (now - silenceSince >= VOICE_SILENCE_STOP_MS && (allowSilenceStopRef.current?.() ?? true)) stop(true);
          });
        } else {
          meter?.close(); // 环境不支持/窗口已过：VAD 降级（不早退——pump 仍挂）
        }
      } catch {
        // meter 挂载失败（如 getUserMedia 流被判无效）：降级无 VAD——点击停路径仍可用
      }

      // PCM 泵挂载（V3b-1 流式面：onPcmFrame 传入才挂；与 meter 同流共存；
      // 工厂失败/环境缺失 → 流式降级不阻断录音——VAD/点击停路径不受影响）
      if (onPcmFrameRef.current !== undefined) {
        try {
          const pump = await createPumpRef.current(stream);
          if (pump === null || !isRecording()) {
            pump?.close();
            return;
          }
          pumpRef.current = pump;
          pump.onFrame((frame) => {
            if (!isRecording()) return;
            onPcmFrameRef.current?.(frame);
          });
        } catch {
          // 泵挂载失败：流式降级（消费方 stop 后回落非流式链路）
        }
      }
    } catch (err) {
      cleanupMedia();
      setError((err as Error).message);
      setStateSafe("idle");
    }
  }, [cleanupMedia, setStateSafe, t]);

  /** 取消收口（B4）：关麦零转写（同步收场——track.stop 即刻断言面）。 */
  const cancel = useCallback(() => {
    cancelGenRef.current += 1; // 迟归 getUserMedia 作废（代数失配即弃）
    const recorder = recorderRef.current;
    const wasRecording = isRecording();
    closeMeter();
    closePump();
    pendingBlobRef.current = null;
    uploadInFlightRef.current = false;
    chunksRef.current = [];
    recorderRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (wasRecording && recorder !== null && recorder !== undefined) {
      try {
        recorder.onstop = null; // 废弃链：不走 stop 收口（零转写零计费）
        recorder.stop();
      } catch {
        // recorder 已停等边界：媒体轨已收，静默兜底
      }
    }
    setStateSafe("idle");
  }, [closeMeter, closePump, setStateSafe]);

  /** 流式终帧收口（V3b-1；仅 deferred 态生效）：非空 → onTranscript；空 → 丢弃回 idle。 */
  const resolveStreaming = useCallback(
    (text: string): boolean => {
      if (stateRef.current !== "transcribing" || pendingBlobRef.current === null) return false;
      pendingBlobRef.current = null;
      uploadInFlightRef.current = false;
      setError(null);
      setStateSafe("idle");
      if (text.trim() !== "") onTranscriptRef.current(text);
      return true;
    },
    [setStateSafe],
  );

  /** 回落非流式（V3b-1；仅 deferred 态生效）：持 blob 走既有上传转写链。 */
  const transcribeNow = useCallback((): void => {
    if (stateRef.current !== "transcribing" || pendingBlobRef.current === null) return;
    const blob = pendingBlobRef.current;
    pendingBlobRef.current = null;
    uploadBlob(blob);
  }, [uploadBlob]);

  return { state, level, userSpeaking, error, start, stop, cancel, resolveStreaming, transcribeNow };
}
