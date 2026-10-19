/**
 * mic-recorder —— 注册引导录音器（M3-c 声纹批；复用既有麦克风链）。
 *
 * 生产形态：getUserMedia + createWorkletPcmPump（pcm-pump——16k mono Int16
 * 100ms 帧，不新开采集通道）。句收口三闸：达最短且静音 1.8s（VOICE_
 * SILENCE_STOP_MS 同值口径）/ 达最长 / 未开口兜底超时。输出 Int16 域
 * Float32Array（模型 normalize_samples=0 口径）；未开口（全程不达 RMS 门）
 * 按采集失败收口 null（零静音段上游）。
 */
import { createWorkletPcmPump } from "@/shared/lib/pcm-pump";
import { PCM_RMS_GATE, frameRms } from "../model/pcm-ring";

/** 录句器 port（测试注入 fake；null = 采集失败）。 */
export interface UtteranceRecorder {
  record(minSeconds: number, maxSeconds: number): Promise<Float32Array | null>;
}

/** 静音自动停窗口（ms；useVoiceInput VOICE_SILENCE_STOP_MS 同值口径）。 */
const SILENCE_STOP_MS = 1_800;

/** 生产录音器（每句一开一关麦克风——注册引导低频操作，不复用会话流）。 */
export function createMicUtteranceRecorder(): UtteranceRecorder {
  return {
    async record(minSeconds: number, maxSeconds: number): Promise<Float32Array | null> {
      const media = navigator.mediaDevices;
      if (typeof media?.getUserMedia !== "function") return null;
      const stream = await media.getUserMedia({ audio: true });
      try {
        const pump = await createWorkletPcmPump(stream);
        if (pump === null) return null;
        return await new Promise<Float32Array | null>((resolve) => {
          const frames: Int16Array[] = [];
          let samples = 0;
          let spoke = false;
          let silenceMs = 0;
          let settled = false;
          const minSamples = Math.round(minSeconds * 16_000);
          const maxSamples = Math.round(maxSeconds * 16_000);
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            pump.close();
            // 未开口（全程过不了 RMS 门）= 采集失败：收口 null（port 契约），
            // 不把纯静音段交上游——上游只校验时长 ≥1.2s，静音句会被注册成
            // 声纹模板句污染模板、相似度判定失真（评审 mic-recorder:52）
            if (!spoke) {
              resolve(null);
              return;
            }
            const total = samples;
            const out = new Float32Array(total);
            let at = 0;
            for (const f of frames) {
              out.set(f, at);
              at += f.length;
            }
            resolve(out);
          };
          const timer = setTimeout(finish, (maxSeconds + 2) * 1000); // 未开口兜底超时
          pump.onFrame((frame: ArrayBuffer) => {
            if (settled) return;
            const s = new Int16Array(frame);
            frames.push(s);
            samples += s.length;
            const rms = frameRms(s);
            if (rms >= PCM_RMS_GATE) {
              spoke = true;
              silenceMs = 0;
            } else if (spoke) {
              silenceMs += 100; // 帧粒度 100ms
            }
            if (samples >= maxSamples || (spoke && samples >= minSamples && silenceMs >= SILENCE_STOP_MS)) finish();
          });
        });
      } finally {
        for (const t of stream.getTracks()) t.stop();
      }
    },
  };
}
