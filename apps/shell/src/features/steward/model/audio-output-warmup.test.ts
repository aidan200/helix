// @vitest-environment jsdom
/**
 * audio-output-warmup 单元测试（问题 8 音频冷启动修复批；TDD 红→绿）。
 *
 * WKWebView 首次播音频需激活 CoreAudio 输出会话（解码管线 + 通道建立 +
 * 采样率协商）——首段顿挫病根。预热 = 挂载期静音播零音量音频提前完成
 * 通道激活。契约面：
 * - 零音量 + 固化静音源（WAV data URI）恰播一次（播放即激活，音量 0
 *   不等于静默跳过——解码/通道全走）；
 * - 单发位模块级（重复调用/重复挂载幂等；失败也置位——autoplay 拒绝
 *   不随重试消失，重试反而重复打扰）；
 * - 任何失败静默吞：构造异常 / autoplay 拒绝 / play 非 Promise 返回
 *   （jsdom 未实现形态——真浏览器恒 Promise，防御面兼容测试环境）；
 * - 环境无音频面（Audio 未定义）早退不置位——真环境到达时仍可预热。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SILENT_AUDIO_WARMUP_SRC,
  resetAudioOutputWarmupForTests,
  warmAudioOutputOnce,
} from "./audio-output-warmup";

interface StubAudioInstance {
  src: string;
  volume: number;
  paused: boolean;
  playCount: number;
  onended: (() => void) | null;
}

interface StubAudio {
  plays: string[];
  instances: StubAudioInstance[];
}

/** function 形态 Audio stub（箭头函数非构造器——new 调用抛错会走错路径）。 */
function stubAudio(): StubAudio {
  const s: StubAudio = { plays: [], instances: [] };
  vi.stubGlobal(
    "Audio",
    vi.fn().mockImplementation(function (
      this: { src: string; volume: number; paused: boolean; playCount: number; onended: null; play: () => Promise<void>; pause: () => void },
      src: string,
    ) {
      this.src = src;
      this.volume = 1;
      this.paused = false;
      this.playCount = 0;
      this.onended = null;
      this.play = () => {
        this.playCount += 1;
        s.plays.push(src);
        return Promise.resolve();
      };
      this.pause = () => {
        this.paused = true;
      };
      s.instances.push(this as unknown as StubAudioInstance & { play: () => Promise<void>; pause: () => void });
    }),
  );
  return s;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("audio-output-warmup（输出通道预热：零音量静音播激活 CoreAudio）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetAudioOutputWarmupForTests();
  });

  it("调用即播零音量静音源恰一次：src = 固化静音源、volume = 0、play 1 次", () => {
    const s = stubAudio();
    warmAudioOutputOnce();
    expect(s.instances.length).toBe(1);
    expect(s.instances[0]!.src).toBe(SILENT_AUDIO_WARMUP_SRC);
    expect(s.instances[0]!.volume).toBe(0); // 零音量（解码/通道全走，出声为零）
    expect(s.plays).toEqual([SILENT_AUDIO_WARMUP_SRC]); // 播放即激活
  });

  it("单发位幂等：重复调用不重复播；复位后可再播（测试隔离面）", () => {
    const s = stubAudio();
    warmAudioOutputOnce();
    warmAudioOutputOnce();
    expect(s.plays).toEqual([SILENT_AUDIO_WARMUP_SRC]); // 仍一次
    resetAudioOutputWarmupForTests();
    warmAudioOutputOnce();
    expect(s.plays).toEqual([SILENT_AUDIO_WARMUP_SRC, SILENT_AUDIO_WARMUP_SRC]); // 复位后再播
  });

  it("构造异常静默吞且单发位已置：失败不重试（后续正常 Audio 到场零补播）", () => {
    vi.stubGlobal(
      "Audio",
      vi.fn().mockImplementation(() => {
        throw new Error("constructor boom");
      }),
    );
    expect(() => warmAudioOutputOnce()).not.toThrow(); // 静默吞
    const s = stubAudio();
    warmAudioOutputOnce();
    expect(s.plays).toEqual([]); // 失败已计一次——不重试
  });

  it("autoplay 拒绝（play 返回 rejected promise）静默吞：零未处理 rejection 冒泡", async () => {
    const plays: string[] = [];
    vi.stubGlobal(
      "Audio",
      vi.fn().mockImplementation(function (
        this: { src: string; volume: number; onended: null; play: () => Promise<void>; pause: () => void },
        src: string,
      ) {
        this.src = src;
        this.volume = 1;
        this.onended = null;
        this.play = () => {
          plays.push(src);
          return Promise.reject(new Error("autoplay denied"));
        };
        this.pause = () => {};
      }),
    );
    expect(() => warmAudioOutputOnce()).not.toThrow();
    await flushMicrotasks(); // 拒绝被 .catch 接住（vitest 挂未处理 rejection 即红）
    expect(plays).toEqual([SILENT_AUDIO_WARMUP_SRC]); // play 已发起（拒绝被吞）
  });

  it("play 非 Promise 返回（jsdom 未实现形态）不抛 TypeError", () => {
    vi.stubGlobal(
      "Audio",
      vi.fn().mockImplementation(function (
        this: { src: string; volume: number; onended: null; play: () => undefined; pause: () => void },
        src: string,
      ) {
        this.src = src;
        this.volume = 1;
        this.onended = null;
        this.play = () => undefined; // jsdom HTMLMediaElement.play 未实现形态
        this.pause = () => {};
      }),
    );
    expect(() => warmAudioOutputOnce()).not.toThrow();
  });

  it("Audio 未定义（环境无音频面）早退不置位：真环境 Audio 到场后仍可预热", () => {
    vi.stubGlobal("Audio", undefined);
    expect(() => warmAudioOutputOnce()).not.toThrow(); // 早退零副作用
    const s = stubAudio();
    warmAudioOutputOnce();
    expect(s.plays).toEqual([SILENT_AUDIO_WARMUP_SRC]); // 早退未消耗单发位
  });
});
