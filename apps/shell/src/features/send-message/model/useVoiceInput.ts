/**
 * useVoiceInput —— Composer 语音输入状态机（语音输入批 V1 Phase 1）。
 *
 * 链路（设计 §4）：按住说话 → getUserMedia({audio}) → MediaRecorder
 * （mime 选择序 audio/webm;codecs=opus → audio/webm → audio/mp4——spike
 * 实测支持面；audioBitsPerSecond 64k 压码率）→ 松开 stop → blob → base64
 * data URL → sendSttTranscribe（信封 sessionId = 活跃会话）→ 回执经
 * subscribeSttFrames 点对点到达 → onResult 回调（Composer 回填草稿）。
 *
 * 状态机：idle → recording（按住）→ transcribing（上传/转写中）→ idle
 * （ok/error 收口）。转写结果是草稿而非直接发送——最后一道人工闸。
 *
 * 环境防御：navigator.mediaDevices 缺失（tauri dev 裸二进制无授权历史时
 * API 面整个隐藏——spike 孤例，TR-177 先问环境）→ unsupported 态 + 引导
 * 文案；getUserMedia 拒绝（TCC 未授权）→ error 态 + 原因。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/entities/session/SessionContext";
import { useI18n } from "@/shared/i18n";
import { readSttProviderPref } from "@/shared/lib/stt-provider-pref";
import type { EventEnvelope } from "@helix/protocol";

export type VoiceState = "unsupported" | "idle" | "recording" | "transcribing";

/** MediaRecorder 码率（64kbps——语音 opus 足量，spike 实测 156kbps 可压）。 */
const AUDIO_BITS_PER_SECOND = 64_000;

/** mime 选择序（spike 实测 isTypeSupported 支持面）。 */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const mime of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return undefined;
}

export interface VoiceInput {
  readonly state: VoiceState;
  /** 最近一次失败原因（idle 后保留供 toast 消费；开始新录音即清）。 */
  readonly error: string | null;
  /** 按住开始录音（pointerdown）。 */
  start: () => Promise<void>;
  /** 松开停止录音并发起转写（pointerup/pointerleave/pointercancel）。 */
  stop: () => void;
}

export function useVoiceInput(onTranscript: (text: string) => void): VoiceInput {
  const { t } = useI18n();
  const { sendSttTranscribe, subscribeSttFrames } = useSession();
  const [state, setState] = useState<VoiceState>(() =>
    typeof navigator !== "undefined" && navigator.mediaDevices !== undefined && typeof MediaRecorder !== "undefined"
      ? "idle"
      : "unsupported",
  );
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  // 回执消费（单飞门控：仅 transcribing 态消费；daemon 业务失败走 error 判别，
  // 协议面错误走 connection.error——两者都收口回 idle + error 交代）
  useEffect(() => {
    if (subscribeSttFrames === undefined) return;
    return subscribeSttFrames((event: EventEnvelope) => {
      if (event.type === "stt.transcribe.result") {
        if (event.payload.status === "ok") {
          setError(null);
          setState("idle");
          onTranscriptRef.current(event.payload.text);
        } else {
          setError(String(event.payload.reason));
          setState("idle");
        }
      } else if (event.type === "connection.error") {
        setError(String((event.payload as { message?: string }).message ?? t("chat.voice.transcribeFail")));
        setState("idle");
      }
    });
  }, [subscribeSttFrames]);

  const cleanupMedia = useCallback(() => {
    recorderRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => cleanupMedia, [cleanupMedia]);

  const start = useCallback(async () => {
    if (state !== "idle") return;
    setError(null);
    if (typeof navigator === "undefined" || navigator.mediaDevices === undefined) {
      setState("unsupported");
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
      recorder.start(250); // 250ms slices: tail chunk safe before stop
      setState("recording");
    } catch (err) {
      cleanupMedia();
      setError((err as Error).message);
      setState("idle");
    }
  }, [cleanupMedia, state]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder === undefined || recorder === null || state !== "recording") {
      cleanupMedia();
      if (state === "recording") setState("idle");
      return;
    }
    const durationMs = Date.now() - startedAtRef.current;
    recorder.onstop = () => {
      const chunks = chunksRef.current;
      cleanupMedia();
      const blob = new Blob(chunks, { type: recorder.mimeType });
      if (blob.size === 0 || durationMs < 300) {
        // 过短录音（误触）：不发转写请求（防静音幻觉计费）
        setState("idle");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        // 设置页 provider 偏好随命令携带（缺省 auto = 不带，daemon 装配序自动选择）
        const provider = readSttProviderPref();
        const sent = sendSttTranscribe(String(reader.result), { language: "zh", ...(provider !== undefined ? { provider } : {}) });
        setState(sent ? "transcribing" : "idle");
        if (!sent) setError(t("chat.voice.sendFail"));
      };
      reader.onerror = () => {
        setState("idle");
        setError(t("chat.voice.readFail"));
      };
      reader.readAsDataURL(blob);
    };
    setState("transcribing"); // stop->onstop async gap placeholder (UI-invisible)
    recorder.stop();
  }, [cleanupMedia, sendSttTranscribe, state]);

  return { state, error, start, stop };
}
