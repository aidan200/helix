// @vitest-environment jsdom
/**
 * useStewardVoice 组合钩子集成测试（V3a 管家语音模式；TDD 红→绿）。
 *
 * 链路集成点（brief 测试要求）：
 * - 转写文本一次性喂 ask（不重复触发）：录音强制停 → stt 回执 ok →
 *   sendStewardAsk 恰一次携带转写文本；
 * - 回复终态触发朗读一次：ask.result answer → voice.synthesize 恰一次
 *   （md 剥离后语音文本）；confirm_required/error 不合成（money 闸）；
 * - 文本模式零发声：mode=text 时 answer 终态零合成；偏好关零合成；
 * - ask 发送失败（未连接）→ voiceDraft 回填（文本态可重试，零静默丢话）；
 * - 静音钮 stopSpeaking：在播即停（Audio.pause 断言）+ 后续回执不再播；
 * - 双模切换：setMode("text") 在录即强制停（转写链照常收口）。
 *
 * mock 面：SessionContext（steward/stt/voice 命令与订阅）+ FakeMediaRecorder
 * （shared/lib/useVoiceInput.test 同款）+ FakeAudio（jsdom play 不可用）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";

const sendStewardAsk = vi.fn(() => true);
const sendStewardConfirm = vi.fn(() => true);
const sendStewardSubscribe = vi.fn(() => true);
const sendStewardUnsubscribe = vi.fn(() => true);
const sendStewardGetConfig = vi.fn(() => true);
const sendSttTranscribe = vi.fn(() => true);
const sendVoiceSynthesize = vi.fn(() => true);
const sendVoiceSynthesizeStream = vi.fn(() => true);
const sendVoiceSynthesizeStop = vi.fn(() => true);

// ── V3b-1 流式面（streamStartEnabled 开关：false = 开流不可达，既有 V3a
//    回落路径回归不受串扰；true = 流式链路）──
let streamStartEnabled = false;
const sendSttStreamStart = vi.fn(() => streamStartEnabled);
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

import { useStewardVoice } from "./useStewardVoice";

/** FakeMediaRecorder（useVoiceInput.test 同款时序 stub）。 */
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

/** FakeAudio（jsdom HTMLMediaElement.play 未实现——可控 promise + pause 探针）。 */
class FakeAudio {
  static instances: FakeAudio[] = [];
  paused = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  volume = 1;
  constructor(public readonly src: string) {
    FakeAudio.instances.push(this);
  }
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

function frame(type: string, payload: unknown, channel: string, sessionId = "__system__"): EventEnvelope {
  return { v: "0.14", sessionId, channel, type, payload } as EventEnvelope;
}

/** 安装录音 + Audio 环境，返回还原函数。 */
function installEnv(): () => void {
  const origDevices = navigator.mediaDevices;
  const origRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  const origAudio = (globalThis as { Audio?: unknown }).Audio;
  const fakeStream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn(async () => fakeStream) },
    configurable: true,
  });
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeMediaRecorder;
  (globalThis as { Audio?: unknown }).Audio = FakeAudio;
  return () => {
    Object.defineProperty(navigator, "mediaDevices", { value: origDevices, configurable: true });
    if (origRecorder === undefined) delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    else (globalThis as { MediaRecorder?: unknown }).MediaRecorder = origRecorder;
    if (origAudio === undefined) delete (globalThis as { Audio?: unknown }).Audio;
    else (globalThis as { Audio?: unknown }).Audio = origAudio;
  };
}

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 12));
  });
}

function renderVoice() {
  // 返回 result ref（r.current = 钩子面）——renderHook 返回值解构常见坑钉死
  return renderHook(() => useStewardVoice(true), { wrapper: I18nProvider }).result;
}

/** 走完一轮「点击说话 → 强制停 → 转写回执」到指定文本（含 fake clock 推进
 *  过最短录音窗——防误触门不吞真实录音；useVoiceInput.test 同款手法）。 */
async function speakOnce(result: { current: ReturnType<typeof useStewardVoice> }, text: string): Promise<void> {
  let nowMs = Date.now();
  const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  const sentBefore = sendSttTranscribe.mock.calls.length;
  try {
    await act(async () => {
      await result.current.startListening();
    });
    nowMs += 500; // 过最短录音窗（VOICE_MIN_DURATION_MS 300ms）
    await tick();
    act(() => {
      result.current.stopListening();
    });
    await waitFor(() => expect(sendSttTranscribe.mock.calls.length).toBe(sentBefore + 1), { timeout: 2000 });
    act(() => {
      emit("stt", frame("stt.transcribe.result", { status: "ok", text, provider: "dashscope" }, "stt"));
    });
  } finally {
    spy.mockRestore();
  }
}

describe("useStewardVoice（V3a 管家语音闭环）", () => {
  let restoreEnv: (() => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    for (const s of Object.values(listeners)) s.clear();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    FakeMediaRecorder.instances = [];
    FakeAudio.instances = [];
    restoreEnv?.();
    restoreEnv = null;
  });

  it("打开默认语音模式；mic 可用即停留 voice", () => {
    restoreEnv = installEnv();
    const r = renderVoice();
    expect(r.current.mode).toBe("voice");
    expect(r.current.phase).toBe("idle");
  });

  it("mic 不可用（unsupported）自动回退文本态", () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    const r = renderVoice();
    expect(r.current.mode).toBe("text");
    expect(r.current.phase).toBe("unsupported");
  });

  it("转写文本一次性喂 ask：录音 → 强制停 → stt ok → sendStewardAsk 恰一次", async () => {
    restoreEnv = installEnv();
    const r = renderVoice();
    act(() => {
      emit("steward", frame("steward.config.result", { enabled: true, model: "x/y" }, "steward"));
    });
    await speakOnce(r, "现在有什么在跑？");
    await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledTimes(1));
    expect(sendStewardAsk).toHaveBeenCalledWith("现在有什么在跑？");
    expect(r.current.askInFlight).toBe(true);
    expect(r.current.phase).toBe("asking");
  });

  it("回复终态触发朗读一次：answer → synthesize 恰一次（md 剥离）→ 回执 ok → speaking；播毕回 idle", async () => {
    restoreEnv = installEnv();
    const r = renderVoice();
    act(() => {
      emit("steward", frame("steward.config.result", { enabled: true, model: "x/y" }, "steward"));
    });
    await speakOnce(r, "现在有什么在跑？");
    await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledTimes(1));
    act(() => {
      emit("steward", frame("steward.ask.result", { status: "answer", text: "有 **2 个**任务在跑：\n\n```bash\nls\n```\n详见任务页。" }, "steward"));
    });
    await waitFor(() => expect(sendVoiceSynthesize).toHaveBeenCalledTimes(1));
    const [speechText, opts] = sendVoiceSynthesize.mock.calls[0] as unknown as [string, { voice?: string }];
    expect(speechText).toBe("有 2 个任务在跑： 详见任务页。"); // fenced code 剥离 + 标记剥离
    expect(typeof opts?.voice).toBe("string"); // 音色偏好随发
    // 合成回执 ok → 面板播放 → speaking
    act(() => {
      emit("voice", frame("voice.synthesize.result", { status: "ok", audio: "data:audio/wav;base64,QUJD", provider: "dashscope" }, "voice"));
    });
    expect(r.current.speaking).toBe(true);
    expect(r.current.phase).toBe("speaking");
    expect(FakeAudio.instances.length).toBe(1);
    // 播毕 → 回 idle
    act(() => {
      FakeAudio.instances[0]!.onended?.();
    });
    expect(r.current.speaking).toBe(false);
    expect(r.current.phase).toBe("idle");
  });

  it("money 闸：confirm_required / error 终态零合成；文本模式零发声；偏好关零合成", async () => {
    restoreEnv = installEnv();
    const r = renderVoice();
    act(() => {
      emit("steward", frame("steward.config.result", { enabled: true, model: "x/y" }, "steward"));
    });
    // confirm_required 不朗读
    await speakOnce(r, "帮我停掉搜索任务");
    await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledTimes(1));
    act(() => {
      emit("steward", frame("steward.ask.result", { status: "confirm_required", actionId: "a1", agentId: "agent-1", message: "递话全文" }, "steward"));
    });
    expect(sendVoiceSynthesize).not.toHaveBeenCalled();
    // error 不朗读
    await speakOnce(r, "再问一次");
    await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledTimes(2));
    act(() => {
      emit("steward", frame("steward.ask.result", { status: "error", reason: "额度不足" }, "steward"));
    });
    expect(sendVoiceSynthesize).not.toHaveBeenCalled();
    // 文本模式 answer 不朗读（money 纪律：文本模式零发声）
    act(() => {
      r.current.setMode("text");
    });
    await speakOnce(r, "第三次");
    await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledTimes(3));
    act(() => {
      emit("steward", frame("steward.ask.result", { status: "answer", text: "直答" }, "steward"));
    });
    expect(sendVoiceSynthesize).not.toHaveBeenCalled();
    // 偏好关：语音模式 answer 也不朗读
    act(() => {
      r.current.setMode("voice");
    });
    localStorage.setItem("helix.steward.speakReply", "0");
    await speakOnce(r, "第四次");
    await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledTimes(4));
    act(() => {
      emit("steward", frame("steward.ask.result", { status: "answer", text: "直答" }, "steward"));
    });
    expect(sendVoiceSynthesize).not.toHaveBeenCalled();
  });

  it("静音钮 stopSpeaking：在播即停（pause + speaking=false），pending 合成回执到达也不再播", async () => {
    restoreEnv = installEnv();
    const r = renderVoice();
    act(() => {
      emit("steward", frame("steward.config.result", { enabled: true, model: "x/y" }, "steward"));
    });
    await speakOnce(r, "状态如何");
    await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledTimes(1));
    act(() => {
      emit("steward", frame("steward.ask.result", { status: "answer", text: "一切正常" }, "steward"));
    });
    await waitFor(() => expect(sendVoiceSynthesize).toHaveBeenCalledTimes(1));
    act(() => {
      emit("voice", frame("voice.synthesize.result", { status: "ok", audio: "data:audio/wav;base64,QUJD", provider: "dashscope" }, "voice"));
    });
    expect(r.current.speaking).toBe(true);
    const audio = FakeAudio.instances[0]!;
    act(() => {
      r.current.stopSpeaking();
    });
    expect(audio.paused).toBe(true);
    expect(r.current.speaking).toBe(false);
    expect(FakeAudio.instances.length).toBe(1); // 未再新建
  });

  it("ask 发送失败（未连接）→ 转写文本回填 voiceDraft（文本态可重试，零静默丢话）", async () => {
    restoreEnv = installEnv();
    sendStewardAsk.mockReturnValue(false);
    const r = renderVoice();
    await speakOnce(r, "救命的话");
    await waitFor(() => expect(r.current.voiceDraft).toBe("救命的话"));
    sendStewardAsk.mockReturnValue(true); // 复位——clearAllMocks 不清实现，防泄漏后续 describe
    expect(r.current.askInFlight).toBe(false);
    // 面板采纳后清位
    act(() => {
      r.current.clearVoiceDraft();
    });
    expect(r.current.voiceDraft).toBeNull();
  });

  it("切文本模式：在录即强制停（转写链照常收口到 ask）+ 停朗读", async () => {
    restoreEnv = installEnv();
    const r = renderVoice();
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      await act(async () => {
        await r.current.startListening();
      });
      nowMs += 500;
      await tick();
      act(() => {
        r.current.setMode("text");
      });
      expect(r.current.mode).toBe("text");
      const sttBefore = sendSttTranscribe.mock.calls.length;
      await waitFor(() => expect(sendSttTranscribe.mock.calls.length).toBe(sttBefore + 1), { timeout: 2000 });
      act(() => {
        emit("stt", frame("stt.transcribe.result", { status: "ok", text: "切换时的话", provider: "dashscope" }, "stt"));
      });
      await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledWith("切换时的话"));
    } finally {
      spy.mockRestore();
    }
  });
});

// ── V3b-1 流式转写面：interim 上屏 → final 即刻喂 ask + 回落链 + 单飞门控 ──

describe("useStewardVoice（V3b-1 流式转写面）", () => {
  let restoreEnv: (() => void) | null = null;
  /** fake PCM 泵（帧注入面）。 */
  let pumpCb: ((frame: ArrayBuffer) => void) | null = null;
  const pump = {
    onFrame: (cb: (frame: ArrayBuffer) => void) => {
      pumpCb = cb;
    },
    close: vi.fn(),
  };
  const createPump = () => Promise.resolve(pump);

  beforeEach(() => {
    localStorage.clear();
    for (const s of Object.values(listeners)) s.clear();
    pumpCb = null;
    streamStartEnabled = false;
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    FakeMediaRecorder.instances = [];
    FakeAudio.instances = [];
    restoreEnv?.();
    restoreEnv = null;
  });

  function renderStream(opts?: { streamFinalTimeoutMs?: number }) {
    return renderHook(() => useStewardVoice(true, { createPump, streamFinalTimeoutMs: opts?.streamFinalTimeoutMs }), {
      wrapper: I18nProvider,
    }).result;
  }

  /** 走到「开流就绪 + 录音中」（含 fake clock；返回 result）。 */
  async function startStream(result: { current: ReturnType<typeof useStewardVoice> }): Promise<void> {
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      await act(async () => {
        await result.current.startListening();
      });
      await tick();
      act(() => {
        emit("stt", frame("stt.stream.started", { status: "ok", streamId: "str-1", provider: "dashscope", model: "qwen3-asr-flash-realtime" }, "stt"));
      });
      (result as { __now?: () => void }).__now = () => {
        nowMs += 500;
      };
    } finally {
      spy.mockRestore();
    }
  }

  it("流式闭环：start 开流 → PCM 块上行 → interim 上屏 → finish → final 即刻喂 ask（单次、零非流式上传）", async () => {
    restoreEnv = installEnv();
    streamStartEnabled = true;
    const r = renderStream();
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    await act(async () => {
      await r.current.startListening();
    });
    await tick();
    expect(sendSttStreamStart).toHaveBeenCalledTimes(1);
    act(() => {
      emit("stt", frame("stt.stream.started", { status: "ok", streamId: "str-1", provider: "dashscope", model: "qwen3-asr-flash-realtime" }, "stt"));
    });
    // PCM 帧 → chunk 上行（base64 PCM）
    act(() => {
      pumpCb?.(new Uint8Array([1, 2, 3, 4]).buffer);
    });
    expect(sendSttStreamChunk).toHaveBeenCalledTimes(1);
    expect(typeof (sendSttStreamChunk.mock.calls as unknown as [string][])[0]?.[0]).toBe("string");
    // interim 上屏（prior+text+stash 拼接）
    act(() => {
      emit("stt", frame("stt.stream.interim", { streamId: "str-1", prior: "", text: "帮我把", stash: "Paraformer" }, "stt"));
    });
    expect(r.current.interim).toBe("帮我把Paraformer");
    expect(r.current.phase).toBe("listening");
    // 强制停 → finish → final → ask 恰一次（零 stt.transcribe 上传——单转写）
    nowMs += 500;
    act(() => {
      r.current.stopListening();
    });
    expect(sendSttStreamFinish).toHaveBeenCalledTimes(1);
    const askBefore = sendStewardAsk.mock.calls.length;
    act(() => {
      emit("stt", frame("stt.stream.final", { status: "ok", streamId: "str-1", text: "帮我把 Paraformer 接入 DashScope", provider: "dashscope" }, "stt"));
    });
    spy.mockRestore();
    await waitFor(() => expect(sendStewardAsk.mock.calls.length).toBe(askBefore + 1), { timeout: 2000 });
    expect((sendStewardAsk.mock.calls as unknown as [string][])[sendStewardAsk.mock.calls.length - 1]?.[0]).toBe("帮我把 Paraformer 接入 DashScope");
    expect(sendSttTranscribe).not.toHaveBeenCalled();
    expect(r.current.interim).toBeNull(); // 出态清浮字
  });

  it("开流失败（started error）→ 静默降级：停后 blob 回落非流式，结果等价喂 ask", async () => {
    restoreEnv = installEnv();
    streamStartEnabled = true;
    const r = renderStream();
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    await act(async () => {
      await r.current.startListening();
    });
    await tick();
    act(() => {
      emit("stt", frame("stt.stream.started", { status: "error", reason: "key 未配" }, "stt"));
    });
    expect(r.current.streamDegraded).toBe(true);
    nowMs += 500;
    act(() => {
      r.current.stopListening();
    });
    spy.mockRestore();
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 }); // 回落上传
    expect(sendSttStreamFinish).not.toHaveBeenCalled(); // 死流不发 finish
    const askBefore = sendStewardAsk.mock.calls.length;
    act(() => {
      emit("stt", frame("stt.transcribe.result", { status: "ok", text: "回落转写等价文本", provider: "dashscope" }, "stt"));
    });
    await waitFor(() => expect(sendStewardAsk.mock.calls.length).toBe(askBefore + 1), { timeout: 2000 });
    expect((sendStewardAsk.mock.calls as unknown as [string][])[sendStewardAsk.mock.calls.length - 1]?.[0]).toBe("回落转写等价文本");
  });

  it("final error → 回落非流式（degraded 提示位）", async () => {
    restoreEnv = installEnv();
    streamStartEnabled = true;
    const r = renderStream();
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    await act(async () => {
      await r.current.startListening();
    });
    await tick();
    act(() => {
      emit("stt", frame("stt.stream.started", { status: "ok", streamId: "str-1", provider: "dashscope", model: "m" }, "stt"));
    });
    nowMs += 500;
    act(() => {
      r.current.stopListening();
    });
    expect(sendSttStreamFinish).toHaveBeenCalledTimes(1);
    act(() => {
      emit("stt", frame("stt.stream.final", { status: "error", streamId: "str-1", reason: "上游连接断开" }, "stt"));
    });
    spy.mockRestore();
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(r.current.streamDegraded).toBe(true);
  });

  it("终帧超时 → 自动回落非流式（短窗注入 50ms）", async () => {
    restoreEnv = installEnv();
    streamStartEnabled = true;
    const r = renderStream({ streamFinalTimeoutMs: 50 });
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    await act(async () => {
      await r.current.startListening();
    });
    await tick();
    act(() => {
      emit("stt", frame("stt.stream.started", { status: "ok", streamId: "str-1", provider: "dashscope", model: "m" }, "stt"));
    });
    nowMs += 500;
    act(() => {
      r.current.stopListening();
    });
    spy.mockRestore();
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(r.current.streamDegraded).toBe(true);
    // 迟到 final 不再消费（finalPending 已清 + streamId 已弃）
    const askBefore = sendStewardAsk.mock.calls.length;
    act(() => {
      emit("stt", frame("stt.stream.final", { status: "ok", streamId: "str-1", text: "迟到终帧", provider: "dashscope" }, "stt"));
    });
    await act(async () => {
      await new Promise((res) => setTimeout(res, 20));
    });
    expect(sendStewardAsk.mock.calls.length).toBe(askBefore); // 未重复 ask
  });

  it("单飞门控：他流 streamId 的 interim/final 帧丢弃（不串台）", async () => {
    restoreEnv = installEnv();
    streamStartEnabled = true;
    const r = renderStream();
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    await act(async () => {
      await r.current.startListening();
    });
    await tick();
    act(() => {
      emit("stt", frame("stt.stream.started", { status: "ok", streamId: "str-1", provider: "dashscope", model: "m" }, "stt"));
    });
    act(() => {
      emit("stt", frame("stt.stream.interim", { streamId: "str-OTHER", prior: "", text: "他面", stash: "" }, "stt"));
    });
    expect(r.current.interim).toBeNull(); // 他流帧丢弃
    nowMs += 500;
    act(() => {
      r.current.stopListening();
    });
    spy.mockRestore();
    const askBefore = sendStewardAsk.mock.calls.length;
    act(() => {
      emit("stt", frame("stt.stream.final", { status: "ok", streamId: "str-OTHER", text: "他面终帧", provider: "dashscope" }, "stt"));
    });
    await act(async () => {
      await new Promise((res) => setTimeout(res, 20));
    });
    expect(sendStewardAsk.mock.calls.length).toBe(askBefore); // 他流终帧零消费
  });

  it("provider 偏好非 dashscope：零开流零连接（money 纪律——无流式能力不开流）", async () => {
    restoreEnv = installEnv();
    streamStartEnabled = true;
    // readSttProviderPref 已被 mock 为 undefined——动态改 mock 返回值
    const prefMod = await import("@/shared/lib/stt-provider-pref");
    const prefSpy = vi.spyOn(prefMod, "readSttProviderPref").mockReturnValue("siliconflow");
    const r = renderStream();
    await act(async () => {
      await r.current.startListening();
    });
    expect(sendSttStreamStart).not.toHaveBeenCalled();
    prefSpy.mockRestore();
  });

  it("开流不可达（sendSttStreamStart 缺席）：既有 V3a 行为等价（停即上传）", async () => {
    restoreEnv = installEnv();
    streamStartEnabled = false; // start 返回 false = 未连接形态
    const r = renderStream();
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    await act(async () => {
      await r.current.startListening();
    });
    expect(sendSttStreamStart).toHaveBeenCalledTimes(1);
    nowMs += 500;
    await tick();
    act(() => {
      r.current.stopListening();
    });
    spy.mockRestore();
    await waitFor(() => expect(sendSttTranscribe).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });
});

// ── V3b-2 流式朗读面：delta 切句 → voice.synthesize.stream 逐句 → chunk 播放
//    队列 → 回退链（流式失败→一次性整段）→ 静音钮/闸门 ──

describe("useStewardVoice（V3b-2 流式朗读接线）", () => {
  let restoreEnv: (() => void) | null = null;
  /** fake SpeechPlayer（队列探针面）。 */
  let playerEnqueued: [string, string][] = [];
  let playerStopped = 0;
  let playerActiveCb: ((a: boolean) => void) | null = null;
  const createPlayer = () => ({
    enqueue(utterId: string, b64: string) {
      playerEnqueued.push([utterId, b64]);
      return true;
    },
    setVolume: () => {},
    drop: () => {},
    stop() {
      playerStopped += 1;
    },
    close: () => {},
    onActiveChange(cb: (a: boolean) => void) {
      playerActiveCb = cb;
      return () => {
        playerActiveCb = null;
      };
    },
  });

  /** 走完「说话→转写→ask 发出」进入 asking（fake clock 过录音窗）。 */
  async function askOnce(result: { current: ReturnType<typeof useStewardVoice> }, text: string): Promise<void> {
    let nowMs = Date.now();
    const spy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      await act(async () => {
        await result.current.startListening();
      });
      nowMs += 500;
      await tick();
      act(() => {
        result.current.stopListening();
      });
      await waitFor(() => expect(sendSttTranscribe.mock.calls.length).toBeGreaterThan(0), { timeout: 2000 });
      act(() => {
        emit("stt", frame("stt.transcribe.result", { status: "ok", text, provider: "dashscope" }, "stt"));
      });
      await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledTimes(1));
    } finally {
      spy.mockRestore();
    }
  }

  beforeEach(() => {
    localStorage.clear();
    for (const s of Object.values(listeners)) s.clear();
    playerEnqueued = [];
    playerStopped = 0;
    playerActiveCb = null;
    streamStartEnabled = false;
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    FakeMediaRecorder.instances = [];
    FakeAudio.instances = [];
    restoreEnv?.();
    restoreEnv = null;
  });

  function renderVoiceStream() {
    return renderHook(() => useStewardVoice(true, { createPlayer }), { wrapper: I18nProvider }).result;
  }

  it("流式闭环：delta 切句 → stream 逐句（md 剥离/utterId 单调）→ chunk 入播放队列 → answer 终态零一次性", async () => {
    restoreEnv = installEnv();
    const r = renderVoiceStream();
    await askOnce(r, "现在有什么在跑？");
    act(() => {
      emit("steward", frame("steward.ask.delta", { delta: "**第一句**来了。", seq: 1 }, "steward"));
      emit("steward", frame("steward.ask.delta", { delta: "第二句", seq: 2 }, "steward"));
      emit("steward", frame("steward.ask.delta", { delta: "到了。", seq: 3 }, "steward"));
    });
    await waitFor(() => expect(sendVoiceSynthesizeStream).toHaveBeenCalledTimes(2));
    const [id1, text1] = sendVoiceSynthesizeStream.mock.calls[0] as unknown as [string, string];
    const [id2, text2] = sendVoiceSynthesizeStream.mock.calls[1] as unknown as [string, string];
    expect(text1).toBe("第一句来了。"); // md 剥离在切句前
    expect(text2).toBe("第二句到了。");
    expect(id1 < id2).toBe(true); // utterId 单调
    // chunk 帧入播放队列 → speaking
    act(() => {
      emit("voice", frame("voice.synthesize.chunk", { utterId: id1, seq: 1, audio: "QUJD" }, "voice"));
    });
    expect(playerEnqueued).toEqual([[id1, "QUJD"]]);
    act(() => {
      playerActiveCb?.(true);
    });
    expect(r.current.speaking).toBe(true);
    expect(r.current.phase).toBe("asking"); // ask 在途优先级高于朗读（派生设计）——流式首句在 asking 期出声
    // done 收口 + answer 终态：零一次性合成（流式已播）；终态后 speaking 住
    act(() => {
      emit("voice", frame("voice.synthesize.done", { utterId: id1, provider: "dashscope", frames: 1 }, "voice"));
      emit("steward", frame("steward.ask.result", { status: "answer", text: "**第一句**来了。第二句到了。" }, "steward"));
    });
    await act(async () => {
      await new Promise((res) => setTimeout(res, 20));
    });
    expect(sendVoiceSynthesize).not.toHaveBeenCalled();
    expect(r.current.phase).toBe("speaking"); // 队列仍在播（第二句无缝续播）
    act(() => {
      playerActiveCb?.(false);
    });
    expect(r.current.phase).toBe("idle");
  });

  it("回退链：首句 error → 链死；answer 终态 → 一次性整段回退 → 回执 ok → Audio 播放", async () => {
    restoreEnv = installEnv();
    const r = renderVoiceStream();
    await askOnce(r, "状态如何");
    act(() => {
      emit("steward", frame("steward.ask.delta", { delta: "第一句。第二句。", seq: 1 }, "steward"));
    });
    await waitFor(() => expect(sendVoiceSynthesizeStream).toHaveBeenCalledTimes(2));
    const [id1] = sendVoiceSynthesizeStream.mock.calls[0] as unknown as [string];
    act(() => {
      emit("voice", frame("voice.synthesize.error", { utterId: id1, reason: "上游断开" }, "voice"));
      emit("steward", frame("steward.ask.result", { status: "answer", text: "第一句。第二句。" }, "steward"));
    });
    await waitFor(() => expect(sendVoiceSynthesize).toHaveBeenCalledTimes(1));
    expect((sendVoiceSynthesize.mock.calls[0] as unknown as [string])[0]).toBe("第一句。第二句。");
    // 一次性回执 ok → 面板 Audio 播放（现行为）
    act(() => {
      emit("voice", frame("voice.synthesize.result", { status: "ok", audio: "data:audio/wav;base64,QUJD", provider: "dashscope" }, "voice"));
    });
    expect(r.current.speaking).toBe(true);
    expect(FakeAudio.instances.length).toBe(1);
  });

  it("静音钮：播放中 stopSpeaking → voice.synthesize.stop + 队列清空；后续 delta 零流式", async () => {
    restoreEnv = installEnv();
    const r = renderVoiceStream();
    await askOnce(r, "读一段");
    act(() => {
      emit("steward", frame("steward.ask.delta", { delta: "第一句。", seq: 1 }, "steward"));
    });
    await waitFor(() => expect(sendVoiceSynthesizeStream).toHaveBeenCalledTimes(1));
    const [id1] = sendVoiceSynthesizeStream.mock.calls[0] as unknown as [string];
    act(() => {
      emit("voice", frame("voice.synthesize.chunk", { utterId: id1, seq: 1, audio: "QUJD" }, "voice"));
      playerActiveCb?.(true);
    });
    playerStopped = 0; // 预停读（startListening）的空队列 stop 不计——只断静音钮本次
    act(() => {
      r.current.stopSpeaking();
    });
    expect(sendVoiceSynthesizeStop).toHaveBeenCalledTimes(1);
    expect(playerStopped).toBe(1);
    expect(r.current.speaking).toBe(false);
    // 静音后同轮 delta 不再流式
    act(() => {
      emit("steward", frame("steward.ask.delta", { delta: "第二句。", seq: 2 }, "steward"));
    });
    await act(async () => {
      await new Promise((res) => setTimeout(res, 20));
    });
    expect(sendVoiceSynthesizeStream).toHaveBeenCalledTimes(1);
    // 终态不回退出声（静音语义）
    act(() => {
      emit("steward", frame("steward.ask.result", { status: "answer", text: "第一句。第二句。" }, "steward"));
    });
    await act(async () => {
      await new Promise((res) => setTimeout(res, 20));
    });
    expect(sendVoiceSynthesize).not.toHaveBeenCalled();
  });

  it("money 闸：文本模式与偏好关 → delta 零流式零合成（answer 也零一次性）", async () => {
    restoreEnv = installEnv();
    const r = renderVoiceStream();
    act(() => {
      r.current.setMode("text");
    });
    act(() => {
      emit("steward", frame("steward.ask.delta", { delta: "第一句。", seq: 1 }, "steward"));
      emit("steward", frame("steward.ask.result", { status: "answer", text: "第一句。" }, "steward"));
    });
    expect(sendVoiceSynthesizeStream).not.toHaveBeenCalled();
    expect(sendVoiceSynthesize).not.toHaveBeenCalled();
    // 语音模式但偏好关：同样零合成
    act(() => {
      r.current.setMode("voice");
    });
    localStorage.setItem("helix.steward.speakReply", "0");
    act(() => {
      emit("steward", frame("steward.ask.delta", { delta: "第二句。", seq: 2 }, "steward"));
      emit("steward", frame("steward.ask.result", { status: "answer", text: "第二句。" }, "steward"));
    });
    expect(sendVoiceSynthesizeStream).not.toHaveBeenCalled();
    expect(sendVoiceSynthesize).not.toHaveBeenCalled();
  });
});
