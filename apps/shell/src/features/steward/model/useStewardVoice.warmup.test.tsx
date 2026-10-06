// @vitest-environment jsdom
/**
 * useStewardVoice 欢迎语音频冷启动修复集成测试（问题 8；TDD 红→绿）。
 *
 * 病根（brief 背景）：toggleWake 内 speakWelcome（输出会话冷启动）与
 * beginListening 的 getUserMedia（输入会话建立）并发——两个音频会话抢
 * 设备冷启动，首次呼出欢迎语首段顿挫，第二次起流畅（通道激活后驻留）。
 *
 * 修复结构断言面：
 * - 挂载即预热输出通道：零音量静音源播一次（一次性——重复挂载不重复
 *   预热，模块级单发位幂等）；
 * - 错峰：toggleWake 进双工时欢迎语播放在 beginListening 完成之后
 *   （可控 getUserMedia deferred——resolve 前欢迎语零播放，resolve 后
 *   播；时序序断言 gum-resolved → play）；
 * - 错峰竞态守卫：beginListening 在途窗口快速再按关麦 → 会话收口后
 *   欢迎语不播（迟归麦由 useVoiceInput 代际守卫即刻释放——零孤儿开麦）；
 * - 预热失败（Audio 构造异常）静默吞：挂载不炸、失败不重试、后续双工
 *   链路照常。
 *
 * mock 面：SessionContext（wake/duplex.test 同构）+ FakeMediaRecorder +
 * 可控 deferred getUserMedia（错峰时序断言面）+ Audio function 形态 stub。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";
import { SILENT_AUDIO_WARMUP_SRC, resetAudioOutputWarmupForTests } from "./audio-output-warmup";

const sendStewardAsk = vi.fn(() => true);
const sendStewardConfirm = vi.fn(() => true);
const sendStewardInterrupt = vi.fn(() => true);
const sendStewardSubscribe = vi.fn(() => true);
const sendStewardUnsubscribe = vi.fn(() => true);
const sendStewardGetConfig = vi.fn(() => true);
const sendSttTranscribe = vi.fn(() => true);
const sendVoiceSynthesize = vi.fn(() => true);
const sendVoiceSynthesizeStream = vi.fn(() => true);
const sendVoiceSynthesizeStop = vi.fn(() => true);
const sendSttStreamStart = vi.fn(() => true);
const sendSttStreamChunk = vi.fn(() => true);
const sendSttStreamFinish = vi.fn(() => true);
const sendSttStreamStop = vi.fn(() => true);

const listeners: Record<string, Set<(e: EventEnvelope) => void>> = {
  steward: new Set(),
  stt: new Set(),
  voice: new Set(),
};
function emit(domain: "steward" | "stt" | "voice", e: EventEnvelope): void {
  for (const l of listeners[domain]!) l(e);
}
function makeSubscribe(domain: "steward" | "stt" | "voice") {
  return vi.fn((cb: (e: EventEnvelope) => void) => {
    listeners[domain]!.add(cb);
    return () => {
      listeners[domain]!.delete(cb);
    };
  });
}
const subscribeStewardFrames = makeSubscribe("steward");
const subscribeSttFrames = makeSubscribe("stt");
const subscribeVoiceFrames = makeSubscribe("voice");

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { active: { conn: "connected" } },
    sendStewardAsk,
    sendStewardConfirm,
    sendStewardInterrupt,
    sendStewardSubscribe,
    sendStewardUnsubscribe,
    sendStewardGetConfig,
    subscribeStewardFrames,
    sendSttTranscribe,
    subscribeSttFrames,
    sendSttStreamStart,
    sendSttStreamChunk,
    sendSttStreamFinish,
    sendSttStreamStop,
    sendVoiceSynthesize,
    sendVoiceSynthesizeStream,
    sendVoiceSynthesizeStop,
    subscribeVoiceFrames,
  }),
}));

vi.mock("@/shared/lib/stt-provider-pref", () => ({ readSttProviderPref: () => undefined }));

let fireWakeHotkey: (() => void) | null = null;
vi.mock("@/shared/lib/wake-hotkey", () => ({
  setWakeHotkeyFireHandler: (h: (() => void) | null) => {
    fireWakeHotkey = h;
  },
  syncWakeHotkeyRegistration: async () => "ok" as const,
}));

import { useStewardVoice } from "./useStewardVoice";

/** FakeMediaRecorder（wake.test 同款时序 stub）。 */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: MediaStream, opts?: MediaRecorderOptions) {
    if (opts?.mimeType !== undefined) this.mimeType = opts.mimeType;
    FakeMediaRecorder.instances.push(this);
  }
  static isTypeSupported(mime: string): boolean {
    return mime === "audio/webm;codecs=opus" || mime === "audio/webm" || mime === "audio/mp4";
  }
  start(): void {
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) });
    }, 5);
  }
  stop(): void {
    this.onstop?.();
  }
}

const fakeCreateMeter = async () => ({
  onLevel: () => undefined,
  close: () => undefined,
});

function frame(type: string, payload: unknown, channel: string, sessionId = "__system__"): EventEnvelope {
  return { v: "0.14", sessionId, channel, type, payload } as EventEnvelope;
}

/** Audio function 形态 stub（duplex.test 同款：new 调用可构造、play 记录；
 *  order 提供时同步推 `play:src` ——跨源时序断言判据）。 */
function stubAudio(order?: string[]): { plays: string[]; volumes: number[] } {
  const plays: string[] = [];
  const volumes: number[] = [];
  vi.stubGlobal(
    "Audio",
    vi.fn().mockImplementation(function (
      this: { src: string; volume: number; onended: null; play: () => Promise<void>; pause: () => void },
      src: string,
    ) {
      this.src = src;
      this.volume = 1;
      this.onended = null;
      this.play = () => (plays.push(src), volumes.push(this.volume), order?.push(`play:${src}`), Promise.resolve());
      this.pause = () => {};
    }),
  );
  return { plays, volumes };
}

/**
 * 可控 deferred getUserMedia 环境（错峰时序断言面）：gum promise 挂起至
 * resolveGum() 调用——beginListening 的麦会话建立窗口被测试持有。
 * order 数组记录跨源事件序（gum-resolved / play:src——时序断言判据）。
 */
function installDeferredEnv(): {
  order: string[];
  trackStop: ReturnType<typeof vi.fn>;
  resolveGum: () => void;
  restore: () => void;
} {
  const origDevices = navigator.mediaDevices;
  const origRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  const order: string[] = [];
  const trackStop = vi.fn();
  const fakeStream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
  // pending 队列：耳 meter 与 voice.start 两路 getUserMedia 都会挂起（单
  // resolver 会被后到者覆盖——早归的一路永息）；resolveGum 一次全解。
  const pending: Array<(s: MediaStream) => void> = [];
  Object.defineProperty(navigator, "mediaDevices", {
    value: {
      getUserMedia: vi.fn(
        () =>
          new Promise<MediaStream>((res) => {
            pending.push(res);
          }),
      ),
    },
    configurable: true,
  });
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
  return {
    order,
    trackStop,
    resolveGum: () => {
      if (pending.length === 0) return;
      order.push("gum-resolved");
      for (const res of pending.splice(0)) res(fakeStream);
    },
    restore: () => {
      Object.defineProperty(navigator, "mediaDevices", { value: origDevices, configurable: true });
      if (origRecorder === undefined) delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
      else (globalThis as { MediaRecorder?: unknown }).MediaRecorder = origRecorder;
    },
  };
}

/** 即时 gum 环境（失败静默测试尾段的正常链路面）。 */
function installEnv(): { trackStop: ReturnType<typeof vi.fn>; restore: () => void } {
  const origDevices = navigator.mediaDevices;
  const origRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  const trackStop = vi.fn();
  const fakeStream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn(async () => fakeStream) },
    configurable: true,
  });
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
  return {
    trackStop,
    restore: () => {
      Object.defineProperty(navigator, "mediaDevices", { value: origDevices, configurable: true });
      if (origRecorder === undefined) delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
      else (globalThis as { MediaRecorder?: unknown }).MediaRecorder = origRecorder;
    },
  };
}

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 12));
  });
}

type HookResult = { current: ReturnType<typeof useStewardVoice> };

function renderVoice(): HookResult {
  return renderHook(() => useStewardVoice({ createMeter: fakeCreateMeter }), {
    wrapper: I18nProvider,
  }).result;
}

const FIXED_AUDIO = "data:audio/mp4;base64,FIXED";

describe("useStewardVoice 欢迎语音频冷启动修复（问题 8：通道预热 + 欢迎语错峰）", () => {
  let restoreEnv: (() => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("helix-lang", "zh-CN");
    for (const s of Object.values(listeners)) s.clear();
    fireWakeHotkey = null;
    resetAudioOutputWarmupForTests(); // 模块级单发位跨用例复位
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    FakeMediaRecorder.instances = [];
    restoreEnv?.();
    restoreEnv = null;
  });

  it("挂载即预热输出通道（一次性）：零音量静音源播一次；重复挂载不重复预热", async () => {
    const audio = stubAudio();
    renderVoice();
    // 挂载即预热：静音源以零音量播放（WKWebView CoreAudio 输出会话激活）
    expect(audio.plays).toEqual([SILENT_AUDIO_WARMUP_SRC]);
    expect(audio.volumes).toEqual([0]);
    // 卸载重挂（模块级单发位）：不重复预热
    cleanup();
    renderVoice();
    await tick();
    expect(audio.plays).toEqual([SILENT_AUDIO_WARMUP_SRC]); // 仍恰一次
  });

  it("错峰：欢迎语播放在 beginListening 完成之后——麦会话建立先收口，输出会话后播（首次呼出首段不再顿挫）", async () => {
    const env = installDeferredEnv();
    restoreEnv = env.restore;
    localStorage.setItem("helix.steward.welcomeAudio", FIXED_AUDIO);
    const audio = stubAudio(env.order);
    const r = renderVoice();
    expect(audio.plays).toEqual([SILENT_AUDIO_WARMUP_SRC]); // 挂载预热先行
    // 呼出：duplex 同步置位 + 开流同步发出；麦会话建立挂起（gum pending）
    await act(async () => {
      fireWakeHotkey?.();
    });
    expect(r.current.duplexActive).toBe(true);
    expect(sendSttStreamStart).toHaveBeenCalledTimes(1); // beginListening 已进入（开流同步段）
    await tick(); // 微任务冲刷（gum 仍 pending）
    // 麦会话建立完成前：欢迎语零播放（错峰——两个音频会话不并发冷启动）
    expect(audio.plays).toEqual([SILENT_AUDIO_WARMUP_SRC]);
    expect(env.order).toEqual([`play:${SILENT_AUDIO_WARMUP_SRC}`]); // 仅挂载预热，gum 未 resolve
    // 麦会话建立收口（beginListening 完成）→ 欢迎语才播
    await act(async () => {
      env.resolveGum();
    });
    await tick();
    act(() => {
      emit("stt", frame("stt.stream.started", { status: "ok", streamId: "s1" }, "stt"));
    });
    await waitFor(() => expect(r.current.phase).toBe("listening"));
    expect(audio.plays).toEqual([SILENT_AUDIO_WARMUP_SRC, FIXED_AUDIO]); // 欢迎语后播
    // 时序序：挂载预热 → 麦会话收口 → 欢迎语播放（红→绿判据——旧实现 gum 前
    // 已播欢迎语，序为 [预热, play:FIXED, gum-resolved]）
    expect(env.order).toEqual([`play:${SILENT_AUDIO_WARMUP_SRC}`, "gum-resolved", `play:${FIXED_AUDIO}`]);
  });

  it("错峰竞态守卫：beginListening 在途窗口快速再按（关麦收口）→ 迟归麦即刻释放、欢迎语不播", async () => {
    const env = installDeferredEnv();
    restoreEnv = env.restore;
    localStorage.setItem("helix.steward.welcomeAudio", FIXED_AUDIO);
    const audio = stubAudio();
    const r = renderVoice();
    await act(async () => {
      fireWakeHotkey?.();
    });
    expect(r.current.duplexActive).toBe(true);
    // 快速再按 = 关麦收口（gum 仍在途——错峰窗口内收场）
    await act(async () => {
      fireWakeHotkey?.();
    });
    expect(r.current.duplexActive).toBe(false);
    // 迟归麦：useVoiceInput 代际守卫即刻释放（track.stop 零孤儿开麦）；
    // beginListening 随后完成——但会话已收口，欢迎语不得补播
    await act(async () => {
      env.resolveGum();
    });
    await tick();
    expect(audio.plays).toEqual([SILENT_AUDIO_WARMUP_SRC]); // 欢迎语零播放
    expect(sendVoiceSynthesizeStream).not.toHaveBeenCalled(); // 回退 TTS 路径也未触发
    expect(sendVoiceSynthesize).not.toHaveBeenCalled();
    expect(env.trackStop).toHaveBeenCalled(); // 迟归麦即刻释放
  });

  it("预热失败静默吞（Audio 构造异常）：挂载不炸、失败不重试、后续双工链路照常", async () => {
    vi.stubGlobal(
      "Audio",
      vi.fn().mockImplementation(() => {
        throw new Error("constructor boom");
      }),
    );
    expect(() => renderVoice()).not.toThrow(); // 静默吞——挂载链路零影响
    cleanup();
    // 正常环境恢复：预热失败已计一次（不重试），双工链路照常走通
    const env = installEnv();
    restoreEnv = env.restore;
    localStorage.setItem("helix.steward.welcomeAudio", FIXED_AUDIO);
    const audio = stubAudio();
    const r = renderVoice();
    expect(audio.plays).toEqual([]); // 不重复预热（单发位已置）
    await act(async () => {
      fireWakeHotkey?.();
    });
    await tick();
    act(() => {
      emit("stt", frame("stt.stream.started", { status: "ok", streamId: "s1" }, "stt"));
    });
    await waitFor(() => expect(r.current.phase).toBe("listening"));
    await waitFor(() => expect(audio.plays).toEqual([FIXED_AUDIO])); // 欢迎语照常（错峰后播）
    expect(r.current.duplexActive).toBe(true);
  });
});
