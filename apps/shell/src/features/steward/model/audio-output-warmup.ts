/**
 * audio-output-warmup —— WKWebView 输出通道预热（问题 8 音频冷启动修复）。
 *
 * 病根：WKWebView 首次播音频需激活 CoreAudio 输出会话（解码管线建立 +
 * 通道建立 + 采样率协商）——首次呼出管家的欢迎语首段顿挫、第二次起流畅
 * （通道激活后驻留）。预热 = 应用壳挂载期（用户无感知窗口）静音播一段
 * 零音量音频，提前完成通道激活——首次呼出与后续呼出的音频管线激活路径
 * 无差别。
 *
 * 契约面：
 * - 零音量 + 运行时构造的静音源（0.2s 8kHz/8bit 单声道 WAV data URI，
 *   44 字节头 + 1600 静音采样——零时长空文件可能被管线整段跳过，取最短
 *   可解码时长；不内联 base64 巨串，头字段自文档化）；音量 0 ≠ 静默
 *   跳过：解码/通道/协商全走，仅出声为零；
 * - 单发位模块级（一次 App 会话只预热一次——重复挂载/重复调用幂等）；
 *   **先置位再尝试**：失败（autoplay 拒绝/构造异常）也不重试——拒绝不随
 *   重试消失，重试反而重复打扰，且预热是尽力而为优化非正确性依赖；
 * - 任何失败静默吞（不抛、不打扰、不影响任何后续链路）；play 返回非
 *   Promise（测试环境未实现形态）防御性兼容——真浏览器恒 Promise；
 * - 环境无音频面（window/Audio/btoa 未定义）早退**不置位**——SSR/降级
 *   环境到达真环境后仍可预热。
 *
 * 明确不做：预热麦克风输入会话——静默开麦有隐私/权限语义问题（麦克风
 * 指示灯/系统授权提示不能无用户手势点亮），输入侧冷启动由欢迎语错峰
 * （useStewardVoice.toggleWake：speakWelcome 移至 beginListening 完成后）
 * 承担。
 */

/** 静音时长采样数（8kHz × 0.2s）。 */
const SILENT_WARMUP_SAMPLES = 1_600;
/** 采样率 8kHz / 8bit / 单声道（最短可解码的通用 WAV 形态）。 */
const SILENT_WARMUP_SAMPLE_RATE = 8_000;

function writeAscii(view: DataView, text: string, offset: number): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * 静音预热源（0.2s 静音 WAV data URI）。运行时构造：RIFF/WAVE 头字段
 * 即文档，避免源码内联 base64 巨串；8bit PCM 静音 = 中点 128（0x80）。
 */
function buildSilentWarmupSrc(): string {
  const bytes = new Uint8Array(44 + SILENT_WARMUP_SAMPLES);
  const view = new DataView(bytes.buffer);
  writeAscii(view, "RIFF", 0);
  view.setUint32(4, 36 + SILENT_WARMUP_SAMPLES, true); // RIFF chunk size
  writeAscii(view, "WAVE", 8);
  writeAscii(view, "fmt ", 12);
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SILENT_WARMUP_SAMPLE_RATE, true);
  view.setUint32(28, SILENT_WARMUP_SAMPLE_RATE, true); // byte rate（8bit×mono = 1 B/sample）
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  writeAscii(view, "data", 36);
  view.setUint32(40, SILENT_WARMUP_SAMPLES, true);
  bytes.fill(0x80, 44); // 8bit 静音 = 中点
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/** 静音预热源常量（模块加载期构造一次——btoa 在浏览器/jsdom/Node16+ 全可用）。 */
export const SILENT_AUDIO_WARMUP_SRC = buildSilentWarmupSrc();

/** 单发位：一次 App 会话只预热一次（失败也置位——autoplay 拒绝不随重试消失）。 */
let warmed = false;

/** 复位单发位（仅测试——跨用例隔离）。 */
export function resetAudioOutputWarmupForTests(): void {
  warmed = false;
}

/**
 * 输出通道预热（一次性）：静音播零音量音频激活 WKWebView CoreAudio 输出
 * 会话。任何失败静默吞——预热是尽力而为优化，非正确性依赖。
 */
export function warmAudioOutputOnce(): void {
  if (warmed) return;
  if (typeof window === "undefined" || typeof Audio === "undefined" || typeof btoa === "undefined") {
    return; // 环境无音频面：不置位（真环境到达时仍可预热）
  }
  warmed = true; // 先置位再尝试：失败不重试
  try {
    const audio = new Audio(SILENT_AUDIO_WARMUP_SRC);
    audio.volume = 0; // 零音量：解码/通道/协商全走，出声为零
    const started = audio.play();
    if (started && typeof started.catch === "function") {
      started.catch(() => {
        // autoplay 拒绝等：静默吞（下次用户手势后通道自然解锁）
      });
    }
  } catch {
    // 构造异常等：静默吞
  }
}
