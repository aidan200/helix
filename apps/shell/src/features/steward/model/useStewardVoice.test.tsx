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
    sendVoiceSynthesize,
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
  return { v: "0.13", sessionId, channel, type, payload } as EventEnvelope;
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
