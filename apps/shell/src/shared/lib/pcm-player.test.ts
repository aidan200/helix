/**
 * pcm-player 单测 —— V3b-2 流式 TTS 播放队列（Web Audio 调度面）。
 *
 * 断言面（fake AudioContext——零真实音频设备；jsdom/node 均可跑）：
 * - 同句/跨句 chunk 调度时间连续（gapless：下一块 start = 上一块 start + 时长）；
 * - drop(utterId) 定向丢弃（未播句 stop，他句不受影响）；
 * - stop() 全停 + active 边沿回调（true→false）；
 * - setVolume 即时生效（GainNode）；
 * - ctxFactory 抛 → enqueue 返回 false（调用方走一次性合成回退链）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebAudioSpeechPlayer, type AudioContextLike } from "./pcm-player";

/** fake AudioContext：记录 bufferSource 调度（start 时间/时长）与 stop。 */
class FakeCtx implements AudioContextLike {
  currentTime = 0;
  readonly sources: FakeSource[] = [];
  readonly gainNode = { gain: { value: 1 }, connect: () => {} };
  closed = false;
  /** B2-hotfix 唤醒防御面：可切 suspended（默认 running——既有测试零感知）。 */
  state: "running" | "suspended" = "running";
  resumeCalls = 0;
  resume(): void {
    this.resumeCalls += 1;
    this.state = "running";
  }
  createBuffer(_channels: number, length: number, _sampleRate: number): { getChannelData(): Float32Array } {
    return { getChannelData: () => new Float32Array(length) };
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createGain(): { gain: { value: number }; connect: () => void } {
    return this.gainNode;
  }
  get destination(): { connect: () => void } {
    return { connect: () => {} };
  }
  close(): void {
    this.closed = true;
  }
}

class FakeSource {
  buffer: { getChannelData(): Float32Array } | null = null;
  connected = false;
  startedAt: number | null = null;
  stopped = false;
  onended: (() => void) | null = null;
  connect(_node: unknown): void {
    this.connected = true;
  }
  start(when: number): void {
    this.startedAt = when;
  }
  stop(): void {
    this.stopped = true;
    this.onended?.();
  }
}

/** n 采样块（16bit mono 24k → n/24000 秒）。 */
function pcmBlock(n: number): string {
  const bytes = new Uint8Array(n * 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = 0;
  return btoa(String.fromCharCode(...bytes));
}

describe("createWebAudioSpeechPlayer（Web Audio PCM 播放队列）", () => {
  let ctx: FakeCtx;
  let player: ReturnType<typeof createWebAudioSpeechPlayer>;
  const activeEvents: boolean[] = [];
  let offActive: (() => void) | null = null;

  beforeEach(() => {
    ctx = new FakeCtx();
    player = createWebAudioSpeechPlayer({ ctxFactory: () => ctx });
    offActive = player.onActiveChange((a) => activeEvents.push(a));
  });
  afterEach(() => {
    offActive?.();
  });

  it("enqueue → 调度启动；active 边沿 true；播尽 → false", () => {
    const ok = player.enqueue("u1", pcmBlock(2400)); // 100ms
    expect(ok).toBe(true);
    expect(ctx.sources.length).toBe(1);
    expect(ctx.sources[0]!.startedAt).not.toBeNull();
    expect(activeEvents).toEqual([true]);
    // 播尽（onended 模拟）
    ctx.sources[0]!.onended?.();
    expect(activeEvents).toEqual([true, false]);
  });

  it("同句多块 + 跨句：start 时间连续（gapless——句间无缝）", () => {
    player.enqueue("u1", pcmBlock(2400)); // 100ms
    player.enqueue("u1", pcmBlock(4800)); // 200ms
    player.enqueue("u2", pcmBlock(2400)); // 100ms（跨句）
    const [s1, s2, s3] = ctx.sources;
    expect(s2!.startedAt!).toBeCloseTo(s1!.startedAt! + 0.1, 5);
    expect(s3!.startedAt!).toBeCloseTo(s2!.startedAt! + 0.2, 5);
  });

  it("drop(utterId) 定向丢弃：目标句 stop，他句不动", () => {
    player.enqueue("u1", pcmBlock(2400));
    player.enqueue("u2", pcmBlock(2400));
    player.drop("u2");
    expect(ctx.sources[0]!.stopped).toBe(false);
    expect(ctx.sources[1]!.stopped).toBe(true);
  });

  it("stop()：全部 stop + active 回调 false", () => {
    player.enqueue("u1", pcmBlock(2400));
    player.enqueue("u2", pcmBlock(2400));
    player.stop();
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    expect(activeEvents[activeEvents.length - 1]).toBe(false);
    // 停后续 enqueue 正常（新一轮）
    expect(player.enqueue("u3", pcmBlock(2400))).toBe(true);
  });

  it("setVolume 即时生效（GainNode.value）", () => {
    player.enqueue("u1", pcmBlock(2400));
    player.setVolume(0.37);
    expect(ctx.gainNode.gain.value).toBeCloseTo(0.37, 5);
  });

  it("ctxFactory 抛 → enqueue false（回退链信号）；后续 enqueue 不再重试", () => {
    const boom = createWebAudioSpeechPlayer({ ctxFactory: () => { throw new Error("no audio"); } });
    expect(boom.enqueue("u1", pcmBlock(2400))).toBe(false);
    expect(boom.enqueue("u2", pcmBlock(2400))).toBe(false);
  });

  it("B2-hotfix：suspended ctx → enqueue 唤醒（resume）——恢复会话有声（WKWebView 挂起防御）；running 零冗余", () => {
    ctx.state = "suspended";
    const ok = player.enqueue("u1", pcmBlock(2400));
    expect(ok).toBe(true);
    expect(ctx.resumeCalls).toBe(1); // 唤醒而非静默丢声
    expect(ctx.state).toBe("running");
    // running 期再入队：零重复 resume（幂等无冗余）
    player.enqueue("u1", pcmBlock(2400));
    expect(ctx.resumeCalls).toBe(1);
    // 长时间空闲后再挂起 → 恢复轮再次入队再唤醒
    ctx.state = "suspended";
    player.enqueue("u2", pcmBlock(2400));
    expect(ctx.resumeCalls).toBe(2);
  });

  it("close()：停播 + 关 ctx", () => {
    player.enqueue("u1", pcmBlock(2400));
    player.close();
    expect(ctx.sources[0]!.stopped).toBe(true);
    expect(ctx.closed).toBe(true);
  });
});
