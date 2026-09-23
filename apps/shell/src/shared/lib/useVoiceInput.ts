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
 * rms-meter.ts）→ 电平帧驱动 VAD 门：开口帧（≥ VOICE_RMS_THRESHOLD）刷新
 * lastLoud，自 max(开始+LEAD_IN, lastLoud) 起连续静音 ≥ VOICE_SILENCE_STOP_MS
 * → 自动停。录音中点击 = 强制停（显式意图，不看 spoke）。停 → blob →
 * base64 data URL → sendSttTranscribe（注入面）→ 回执经 subscribeSttFrames
 * （注入面）→ onResult 回调（消费方各自的最后一道闸）。
 *
 * VAD 丢弃：自动停且全程未开口 → 直接回 idle 零转写零计费（静音片不值得
 * 一次 ASR 调用）；强制停不看 spoke（用户显式收口，宁可转写不丢话）。
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
import { createWorkletRmsMeter, type RmsMeterFactory } from "./rms-meter";
import { createWorkletPcmPump, type PcmPumpFactory } from "./pcm-pump";
import type { EventEnvelope } from "@helix/protocol";

export type VoiceState = "unsupported" | "idle" | "recording" | "transcribing";

/** MediaRecorder 码率（64kbps——语音 opus 足量，spike 实测 156kbps 可压）。 */
const AUDIO_BITS_PER_SECOND = 64_000;

/** VAD 开口判定阈值（RMS ≥ 此值视为有声帧；mic 增益常态语音 0.05-0.3，取低阈保守）。 */
export const VOICE_RMS_THRESHOLD = 0.012;

/** 连续静音自动停窗口（ms；brief 口径 1.5-2s，取 1.8s 中档——常量可调）。 */
export const VOICE_SILENCE_STOP_MS = 1_800;

/** 开口前置宽限（ms）：静音时钟起点 = max(开始+本值, 最后有声帧)——
 *  点击后先给开口窗口，防「点了还没来得及说话就被判静音截断」。 */
export const VOICE_LEAD_IN_MS = 1_200;

/** 最短有效录音（ms）：短于此不转写（误触防静音幻觉计费）。 */
export const VOICE_MIN_DURATION_MS = 300;

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
}

export interface VoiceInput {
  readonly state: VoiceState;
  /** 实时电平（0..1，帧驱动平滑；recording 外恒 0）——三态可视化电平条数据源。 */
  readonly level: number;
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
  const levelRef = useRef(0);
  const stateRef = useRef<VoiceState>(state);
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

  /** 既有上传转写链（V3a 路径；deferred 回落 transcribeNow 复用同体）。 */
  const uploadBlob = useCallback(
    (blob: Blob) => {
      const reader = new FileReader();
      reader.onload = () => {
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
      const durationMs = Date.now() - startedAtRef.current;
      closeMeter();
      closePump();
      recorder.onstop = () => {
        const chunks = chunksRef.current;
        cleanupMedia();
        // VAD 丢弃：自动停且全程未开口 → 零转写零计费（静音片不值一次 ASR 调用）
        if (fromVad && !spoke) {
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
    setError(null);
    if (typeof navigator === "undefined" || navigator.mediaDevices === undefined) {
      setStateSafe("unsupported");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      lastLoudAtRef.current = startedAtRef.current;
      recorder.start(250); // 250ms slices: tail chunk safe before stop
      setStateSafe("recording");

      // RMS meter 挂载（VAD 帧驱动；工厂失败/环境缺失 → VAD 降级关闭不阻断录音；
      // 降级不早退——pump 挂载在后，录音/流式不受 meter 缺席影响）
      try {
        const meter = await createMeterRef.current(stream);
        if (meter !== null && isRecording()) {
          meterRef.current = meter;
          meter.onLevel(({ rms }) => {
            if (!isRecording()) return;
            // 电平显示平滑（loud 抬升/静音衰减——电平条数据源）
            const shown = Math.min(1, Math.max(rms * VOICE_LEVEL_GAIN, levelRef.current * VOICE_LEVEL_DECAY));
            levelRef.current = shown;
            setLevel(shown);
            // VAD 门：开口帧刷新 lastLoud；静音时钟自 max(开始+LEAD_IN, lastLoud) 起算
            const now = Date.now();
            if (rms >= VOICE_RMS_THRESHOLD) {
              spokeRef.current = true;
              lastLoudAtRef.current = now;
            }
            const silenceSince = Math.max(startedAtRef.current + VOICE_LEAD_IN_MS, lastLoudAtRef.current);
            if (now - silenceSince >= VOICE_SILENCE_STOP_MS) stop(true);
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

  return { state, level, error, start, stop, resolveStreaming, transcribeNow };
}
