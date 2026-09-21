/**
 * pcm-player —— 流式 TTS 播放队列（V3b-2；Web Audio PCM 调度面）。
 *
 * 职责：voice.synthesize.chunk 帧（base64 PCM 16bit mono 24kHz）→ Web Audio
 * AudioBufferSourceNode 时间线调度——块级 gapless（nextStart 连续推进，同句
 * 与跨句无缝），句间无缝 = 上一句播放期间下一句已在合成（enqueue 即排队）。
 * drop(utterId) 定向丢弃（流式 error 帧路径：半句音频弃播）；stop() 全停
 * （静音钮）；setVolume 即时（GainNode）；close() 随面板卸载释放 ctx。
 *
 * 设备面注入（ctxFactory）：jsdom/测试注入 fake（零真实音频设备）；生产
 * 缺省 lazy new AudioContext()——构造失败（无音频设备/自动播放策略）返回
 * false，调用方（steward 朗读编排层）走一次性合成回退链。
 */

/** 采样率（daemon DashScope 流式 TTS 契约：pcm 16bit mono 24kHz）。 */
export const SPEECH_PCM_SAMPLE_RATE = 24_000;
/** 播放队列公共面（编排层消费；测试 fake 同形）。 */

/** 首块调度前瞻（秒）：留少量缓冲防 underrun。 */
const START_LOOKAHEAD_S = 0.08;

/** 停播后重新入队的最小前瞻（秒）。 */
const RESUME_LOOKAHEAD_S = 0.02;

/** 窄接口面（AudioContext 结构子集——测试 fake 注入面）。 */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: AudioNodeLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
  createGain(): GainNodeLike;
  close(): Promise<void> | void;
}

export interface AudioNodeLike {
  connect(node: AudioNodeLike): void;
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface AudioBufferSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  onended: (() => void) | null;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: { value: number };
}

/** 播放队列公共面（编排层消费；测试 fake 同形）。 */
export interface SpeechPlayer {
  /** 增量 PCM 入队（base64 16bit mono 24kHz）。返回 false = 播放面不可用
   *（AudioContext 构造失败——调用方走一次性合成回退链）。 */
  enqueue(utterId: string, base64Pcm: string): boolean;
  /** 音量 0..1（即时生效）。 */
  setVolume(volume: number): void;
  /** 定向丢弃某句（未播/在播；流式 error 路径）。 */
  drop(utterId: string): void;
  /** 全停（静音钮/新一轮回答）：清队列 + 停在播。 */
  stop(): void;
  /** 释放（面板卸载）。 */
  close(): void;
  /** 复活（StrictMode 双效应：close 后重开——内部 ctx 懒建，重置 dead 即可）。 */
  reopen(): void;
  /** 播放态边沿回调（true = 有音频在播或在队；false = 全部播尽/停）。 */
  onActiveChange(cb: (active: boolean) => void): () => void;
}

export type SpeechPlayerFactory = () => SpeechPlayer;

export interface WebAudioSpeechPlayerOptions {
  /** AudioContext 工厂（缺省 lazy new AudioContext()——测试注入 fake）。 */
  readonly ctxFactory?: () => AudioContextLike;
  /** 采样率（缺省 24000——daemon 流式 TTS 契约）。 */
  readonly sampleRate?: number;
}

/** base64 PCM（16bit LE mono）→ Float32 [-1,1]。 */
function base64PcmToFloat32(base64: string, sampleRate: number): Float32Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const sampleCount = Math.floor(bytes.length / 2);
  const out = new Float32Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < sampleCount; i++) out[i] = view.getInt16(i * 2, true) / 32_768;
  return out;
}

/** 生产工厂（编排层缺省注入；jsdom 测试注入 fake factory）。 */
export function createWebAudioSpeechPlayer(options: WebAudioSpeechPlayerOptions = {}): SpeechPlayer {
  const sampleRate = options.sampleRate ?? SPEECH_PCM_SAMPLE_RATE;
  const ctxFactory = options.ctxFactory ?? (() => new AudioContext() as unknown as AudioContextLike);
  let ctx: AudioContextLike | null = null;
  let gain: GainNodeLike | null = null;
  let volume = 1;
  let dead = false;
  let active = false;
  let nextStart: number | null = null;
  const byUtter = new Map<string, Set<AudioBufferSourceLike>>();
  const activeListeners = new Set<(active: boolean) => void>();

  const setActive = (next: boolean): void => {
    if (active === next) return;
    active = next;
    for (const cb of activeListeners) cb(active);
  };

  const ensureCtx = (): boolean => {
    if (dead) return false;
    if (ctx !== null) return true;
    try {
      ctx = ctxFactory();
      gain = ctx.createGain();
      gain.gain.value = volume;
      gain.connect(ctx.destination);
      return true;
    } catch {
      dead = true;
      ctx = null;
      gain = null;
      return false;
    }
  };

  const retireSource = (utterId: string, source: AudioBufferSourceLike): void => {
    const set = byUtter.get(utterId);
    if (set === undefined) return;
    set.delete(source);
    if (set.size === 0) byUtter.delete(utterId);
    if (byUtter.size === 0) setActive(false);
  };

  return {
    enqueue(utterId: string, base64Pcm: string): boolean {
      if (!ensureCtx() || ctx === null || gain === null) return false;
      try {
        const samples = base64PcmToFloat32(base64Pcm, sampleRate);
        if (samples.length === 0) return true; // 空块——no-op（不视为失败）
        const buffer = ctx.createBuffer(1, samples.length, sampleRate);
        buffer.getChannelData(0).set(samples);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);
        const now = ctx.currentTime;
        const when = nextStart === null ? now + START_LOOKAHEAD_S : Math.max(nextStart, now + RESUME_LOOKAHEAD_S);
        source.start(when);
        source.onended = () => retireSource(utterId, source);
        nextStart = when + samples.length / sampleRate;
        let set = byUtter.get(utterId);
        if (set === undefined) {
          set = new Set();
          byUtter.set(utterId, set);
        }
        set.add(source);
        setActive(true);
        return true;
      } catch {
        return false; // 单块解码/调度失败——丢块不杀队列
      }
    },
    setVolume(v: number): void {
      volume = Math.max(0, Math.min(1, v));
      if (gain !== null) gain.gain.value = volume;
    },
    drop(utterId: string): void {
      const set = byUtter.get(utterId);
      if (set === undefined) return;
      for (const source of [...set]) {
        try {
          source.stop();
        } catch {
          // 已结束等——幂等
        }
      }
      byUtter.delete(utterId);
      if (byUtter.size === 0) setActive(false);
    },
    stop(): void {
      for (const set of byUtter.values()) {
        for (const source of [...set]) {
          try {
            source.stop();
          } catch {
            // 幂等
          }
        }
      }
      byUtter.clear();
      nextStart = null;
      setActive(false);
    },
    close(): void {
      this.stop();
      dead = true;
      if (ctx !== null) {
        try {
          void ctx.close();
        } catch {
          // 幂等
        }
        ctx = null;
        gain = null;
      }
    },
    reopen(): void {
      // ctx 已置空（懒建重跑）；队列已清（close→stop）；只重置死亡位
      dead = false;
    },
    onActiveChange(cb: (active: boolean) => void): () => void {
      activeListeners.add(cb);
      return () => activeListeners.delete(cb);
    },
  };
}
