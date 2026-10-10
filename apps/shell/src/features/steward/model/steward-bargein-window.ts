/**
 * steward-bargein-window —— barge-in 意图窗状态机（批 4b 域收口）。
 *
 * 职责（从 useStewardVoice 迁出的纯状态机，行为逐项等价）：
 * - 窗开/关/超时：声学触发开窗（duck 播报不停 + 收音豁免门控收插话），
 *   窗超时兕底（噪音过门后用户实际没说话——不真停恢复音量）；
 * - duck 三轨记账：player（speechOut）/legacy（一次性 Audio）/welcome（固化
 *   欢迎语）各自记 duck 前原值，恢复写回原值（非偏好重算——中途改偏好不
 *   突跳）；player 原值不可读——恢复面恒 1（真体从未设过）；
 * - 开窗 mark 锚：声纹取样锚（批 3b——duck 期自声污染防御，开窗点 ≈ 插话
 *   起点，fromMark 选段不含窗前独白）。
 *
 * 音轨 IO 经注入接口（测试可换假面）；timer 自持（dispose/settle 清位）。
 */
/** 窗超时兕底处理面。 */
export type BargeInTimeoutHandler = () => void;

/** 音轨操作面（duck/恢复的 IO 单点——生产接 speechOut/Audio 元素）。 */
export interface BargeInTracks {
  setPlayerVolume(volume: number): void;
  getLegacyVolume(): number;
  setLegacyVolume(volume: number): void;
  getWelcomeVolume(): number;
  setWelcomeVolume(volume: number): void;
}

export interface BargeInIntentWindowDeps {
  /** 三轨音量 IO 面。 */
  readonly tracks: BargeInTracks;
  /** 开窗时刻标记（声纹 PCM 环取样锚——插话起点近似）。 */
  readonly mark: () => void;
  /** 窗超时兕底（不真停——恢复由 onTimeout 调用方驱动 settle 后自行处理）。 */
  readonly onTimeout: BargeInTimeoutHandler;
  /** 窗时长 ms（缺省 5000——BARGE_IN_INTENT_WINDOW_MS 常量同源）。 */
  readonly windowMs?: number;
}

export class BargeInIntentWindow {
  private active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ducked: { player: number; legacy: number; welcome: number } | null = null;
  private readonly deps: BargeInIntentWindowDeps;

  constructor(deps: BargeInIntentWindowDeps) {
    this.deps = deps;
  }

  /** 窗开（幂等——已开零重开：mark/duck 不重复）。 */
  open(duckScale: number): void {
    if (this.active) return;
    this.active = true;
    this.deps.mark();
    if (this.ducked === null) {
      const legacy = this.deps.tracks.getLegacyVolume();
      const welcome = this.deps.tracks.getWelcomeVolume();
      this.ducked = { player: 1, legacy, welcome };
      this.deps.tracks.setPlayerVolume(duckScale);
      this.deps.tracks.setLegacyVolume(legacy * duckScale);
      this.deps.tracks.setWelcomeVolume(welcome * duckScale);
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deps.onTimeout();
    }, this.deps.windowMs ?? 5000);
  }

  /** 窗开标记（同步读面——onPcmFrame 豁免/final 分流）。 */
  isActive(): boolean {
    return this.active;
  }

  /** 窗收口不真停（噪音/旁人/非停止插话）：清位 + 恢复音量 + 清 timer。 */
  settle(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.active) return;
    this.active = false;
    const v = this.ducked;
    this.ducked = null;
    if (v !== null) {
      this.deps.tracks.setPlayerVolume(v.player);
      this.deps.tracks.setLegacyVolume(v.legacy);
      this.deps.tracks.setWelcomeVolume(v.welcome);
    }
  }

  /** 终态清位（duplex 收口/组件卸载——timer 不漏）。 */
  dispose(): void {
    this.settle();
  }
}
