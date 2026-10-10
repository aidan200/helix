/**
 * steward-ear-calibration —— 底噪校准采样窗状态机（批 4b 域收口）。
 *
 * 职责（从 useStewardVoice 迁出的采样窗状态管理——4 refs 内联逻辑收一类，
 * 行为逐项等价）：
 * - duplex 开启开窗重采（前 ~2.5s 耳帧采样窗估计环境底噪 P20）；
 * - 发言租约期帧不入样本（校准污染防御：欢迎语 TTS 回灌帧会把 P20 抬到
 *   焊死位——「打不断」根因）；
 * - 窗到期定稿：≥VOICE_NOISE_CALIB_MIN_FRAMES 帧取 noiseFloorEstimate，
 *   不足回落 null（两门用纯偏好值——宁可不校准，不校出毒阈值）；
 * - duplex 落 close 清位（下次会话重采，不携旧底噪）。
 *
 * 估计纯函数（P20 百分位）在 shared/lib/voice-gate.ts 单源——本类只管
 * 采样窗状态；时间由调用方注入（测试可控）。
 */
import {
  VOICE_NOISE_CALIB_WINDOW_MS,
  VOICE_NOISE_CALIB_MIN_FRAMES,
  noiseFloorEstimate,
} from "@/shared/lib/voice-gate";

export class NoiseCalibration {
  private startedAt = 0;
  private samples: number[] = [];
  private sampling = false; // 字段名避开方法 open（同名遮蔽——字段覆盖原型方法）
  private floor: number | null = null;

  /** 开窗重采（duplex 开启——旧样本/旧估计作废）。 */
  open(atMs: number): void {
    this.startedAt = atMs;
    this.samples = [];
    this.sampling = true;
    this.floor = null;
  }

  /** 关窗清位（duplex 落——估计与样本全清，下次会话重采）。 */
  close(): void {
    this.sampling = false;
    this.floor = null;
    this.samples = [];
  }

  /** 采样窗内帧摄入（speechActive = 发言租约期——不入样本）。 */
  feed(rms: number, speechActive: boolean, _atMs: number): void {
    if (!this.sampling) return;
    if (speechActive) return; // 租约期跳过（校准污染防御）
    this.samples.push(rms);
  }

  /** 窗到期定稿（每次耳帧回调先查——窗未到/已定稿零副作用）。 */
  finalizeIfDue(atMs: number): void {
    if (!this.sampling) return;
    if (atMs - this.startedAt < VOICE_NOISE_CALIB_WINDOW_MS) return;
    this.sampling = false;
    this.floor =
      this.samples.length >= VOICE_NOISE_CALIB_MIN_FRAMES
        ? noiseFloorEstimate(this.samples)
        : null; // 采样不足 → 回落纯偏好
  }

  /** 底噪估计（null = 未定稿/不足——两门用纯偏好值）。 */
  estimate(): number | null {
    return this.floor;
  }
}
