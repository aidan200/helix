// @vitest-environment jsdom
/**
 * StewardVoiceLayer 测试（B2 全局语音批；TDD 红→绿）。
 *
 * 结构契约（设计稿 §3.2 + D1/D3/D5/D6）：
 * - 光球层 app 壳级独立 root：duplex=false 零 DOM（不在场不占位）；
 * - duplex=true → 光球（data-testid=steward-orb，data-phase=OrbPhase）
 *   + 字幕条（steward-caption，光球上方）；
 * - 关麦（duplex 落）→ closing 淡出（0.18s 后卸载 DOM）；reduced-motion
 *   直切（零 timer 等待）；
 * - 点击行为（D5）：speaking 点击 → stopSpeaking；listening 点击 →
 *   toggleMute（临时静音）；muted 点击 → 恢复；
 * - 字幕：用户行/管家行弱区分（data-kind）；短驻批：上限 2 行 + TTL 6s
 *   驻留（静置自动移除、流式更新保活、空栈容器隐藏）；
 *   interim 实时行灰显（data-interim）；
 * - 欢迎语：进入 duplex → steward 行入字幕（i18n 常量文案）；
 * - 语音口令（D3=b）：final 整句口令 → steward.confirm/steward.cancel
 *   （既有命令零新帧）+ 回读字幕/音频；非口令句零拦截；
 * - wakeSignal prop（app 层 steward-open-signal 接线）：递增 → 唤起光球
 *   （duplex on）；已在会话幂等零重开。
 *
 * mock 面：SessionContext（steward/stt/voice 命令订阅）+ useStewardVoice
 * 受控桩（状态机本体归 model 层测试——本文件钉 Layer 接线与渲染）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";

const sendStewardAsk = vi.fn(() => true);
const sendStewardConfirm = vi.fn(() => true);
const sendStewardCancel = vi.fn(() => true);
const sendStewardSubscribe = vi.fn(() => true);
const sendStewardUnsubscribe = vi.fn(() => true);
const sendStewardGetConfig = vi.fn(() => true);
const sendStewardHistory = vi.fn(() => true);
const sendVoiceSynthesize = vi.fn(() => true);
const sendVoiceSynthesizeStream = vi.fn(() => true);
const sendVoiceSynthesizeStop = vi.fn(() => true);

const stewardListeners = new Set<(e: EventEnvelope) => void>();
const subscribeStewardFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  stewardListeners.add(cb);
  return () => {
    stewardListeners.delete(cb);
  };
});
function emitSteward(e: EventEnvelope): void {
  for (const l of stewardListeners) l(e);
}

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { active: { conn: "connected" } },
    sendStewardAsk,
    sendStewardConfirm,
    sendStewardCancel,
    sendStewardSubscribe,
    sendStewardUnsubscribe,
    sendStewardGetConfig,
    sendStewardHistory,
    subscribeStewardFrames,
    sendVoiceSynthesize,
    sendVoiceSynthesizeStream,
    sendVoiceSynthesizeStop,
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

// ── useStewardVoice 受控桩（状态机本体归 model 测试；Layer 钉接线渲染）──
const stopSpeaking = vi.fn();
const toggleMute = vi.fn();
const toggleWake = vi.fn();
const say = vi.fn();
let svState: {
  duplexActive: boolean;
  welcomeActive: boolean;
  muted: boolean;
  phase: string;
  userSpeaking: boolean;
  speaking: boolean;
  interim: string | null;
  streamingText: string | null;
  items: Array<{ kind: string; text: string }>;
} = {
  duplexActive: false,
  welcomeActive: false,
  muted: false,
  phase: "idle",
  userSpeaking: false,
  speaking: false,
  interim: null,
  streamingText: null,
  items: [],
};
/** 桩捕获的 options.onFinalText（口令拦截面驱动口）。 */
let capturedOnFinalText: ((text: string) => "consumed" | "pass") | undefined;

vi.mock("../model/useStewardVoice", () => ({
  useStewardVoice: (options?: { onFinalText?: (text: string) => "consumed" | "pass" }) => {
    capturedOnFinalText = options?.onFinalText;
    return {
      items: svState.items,
      streamingText: svState.streamingText,
      feed: [],
      askInFlight: false,
      config: { enabled: true, model: "x/y" },
      ask: () => true,
      newDialog: () => true,
      mode: "voice",
      setMode: () => undefined,
      phase: svState.phase,
      level: 0.6,
      userSpeaking: svState.userSpeaking,
      interim: svState.interim,
      streamDegraded: false,
      speaking: svState.speaking,
      voiceError: null,
      voiceDraft: null,
      startListening: async () => undefined,
      stopListening: () => undefined,
      stopSpeaking,
      clearVoiceDraft: () => undefined,
      duplexActive: svState.duplexActive,
      welcomeActive: svState.welcomeActive,
      muted: svState.muted,
      toggleMute,
      toggleWake,
      say,
    };
  },
}));

import StewardVoiceLayer from "./StewardVoiceLayer";
import { CAPTION_EVICT_TICK_MS } from "../model/caption-log";

localStorage.setItem("helix-lang", "zh-CN");

type LayerProps = { readonly wakeSignal?: number };

function renderLayer(props?: LayerProps) {
  const view = (p: LayerProps) => (
    <ToastProvider>
      <I18nProvider>
        <StewardVoiceLayer {...(p.wakeSignal !== undefined ? { wakeSignal: p.wakeSignal } : {})} />
      </I18nProvider>
    </ToastProvider>
  );
  const utils = render(view(props ?? {}));
  return { ...utils, rerenderLayer: (p: LayerProps) => utils.rerender(view(p)) };
}

/** 推进 duplex 落淡出窗（fake timers 由 vitest 提供——真 timer 18ms 兑底直 await）。 */
async function passFadeWindow(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 260));
  });
}

describe("StewardVoiceLayer（B2 光球层）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stewardListeners.clear();
    fireWakeHotkey = null;
    svState = {
      duplexActive: false,
      welcomeActive: false,
      muted: false,
      phase: "idle",
      userSpeaking: false,
      speaking: false,
      interim: null,
      streamingText: null,
      items: [],
    };
    localStorage.setItem("helix-lang", "zh-CN");
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("不在场零 DOM：duplex=false → 光球层不渲染（app 壳级轻驻留）", () => {
    renderLayer();
    expect(screen.queryByTestId("steward-orb")).toBeNull();
    expect(screen.queryByTestId("steward-caption")).toBeNull();
  });

  it("duplex=true → 光球 + 字幕条在场；呼出全程待机驻留（欢迎语期/开麦未开口）+ 欢迎语入字幕；开口（userSpeaking）→ listening", async () => {
    svState.duplexActive = true;
    svState.welcomeActive = true;
    svState.phase = "idle";
    const { rerenderLayer } = renderLayer();
    expect(screen.getByTestId("steward-orb").getAttribute("data-phase")).toBe("waking"); // 欢语期待机驻留（纯函数钉——欢迎语是伴随声非回复）
    expect(screen.getByTestId("steward-caption")).toBeTruthy();
    // 欢迎语字幕行（管家行）
    const lines = document.querySelectorAll('[data-testid="steward-caption"] [data-kind]');
    expect(Array.from(lines).some((l) => l.textContent === "我在，请说。")).toBe(true);
    // 开麦但未开口（userSpeaking=false）：待机驻留——麦克风开着 ≠ 倾听
    svState.phase = "listening";
    svState.userSpeaking = false;
    rerenderLayer({});
    expect(screen.getByTestId("steward-orb").getAttribute("data-phase")).toBe("waking");
    // 用户开口（userSpeaking=true）：listening 压过欢迎位（转倾听动画）
    svState.userSpeaking = true;
    rerenderLayer({});
    expect(screen.getByTestId("steward-orb").getAttribute("data-phase")).toBe("listening");
    // 欢迎期收位后回 idle 续听间隙 → 待机
    svState.welcomeActive = false;
    svState.phase = "idle";
    svState.userSpeaking = false;
    rerenderLayer({});
    expect(screen.getByTestId("steward-orb").getAttribute("data-phase")).toBe("waking");
  });

  it("相位呈现链：listening（开口）/thinking/speaking（data-phase 反映）", () => {
    svState.duplexActive = true;
    svState.phase = "listening";
    svState.userSpeaking = true;
    renderLayer();
    expect(screen.getByTestId("steward-orb").getAttribute("data-phase")).toBe("listening");
    cleanup();
    svState.phase = "asking";
    renderLayer();
    expect(screen.getByTestId("steward-orb").getAttribute("data-phase")).toBe("thinking");
    cleanup();
    svState.phase = "speaking";
    svState.speaking = true;
    renderLayer();
    expect(screen.getByTestId("steward-orb").getAttribute("data-phase")).toBe("speaking");
  });

  it("关麦淡出（D6）：duplex 落 → closing 相位 + 0.18s 后卸载 DOM", async () => {
    svState.duplexActive = true;
    svState.phase = "speaking";
    const { rerenderLayer } = renderLayer();
    expect(screen.getByTestId("steward-orb").getAttribute("data-phase")).toBe("speaking");
    svState.duplexActive = false;
    svState.phase = "idle";
    svState.speaking = false;
    rerenderLayer({}); // 受控桩重渲（真实面=hook 状态变化驱动）
    expect(screen.getByTestId("steward-orb").getAttribute("data-phase")).toBe("closing");
    await passFadeWindow();
    rerenderLayer({});
    await waitFor(() => expect(screen.queryByTestId("steward-orb")).toBeNull());
  });

  it("reduced-motion 直切：关麦零 timer 等待即卸载", async () => {
    const mq = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      value: vi.fn().mockReturnValue({ matches: true }),
      configurable: true,
      writable: true,
    });
    try {
      svState.duplexActive = true;
      svState.phase = "listening";
      const { rerenderLayer } = renderLayer();
      expect(screen.getByTestId("steward-orb")).toBeTruthy();
      svState.duplexActive = false;
      rerenderLayer({});
      expect(screen.queryByTestId("steward-orb")).toBeNull(); // 直切（closing 不驻留）
    } finally {
      Object.defineProperty(window, "matchMedia", { value: mq, configurable: true, writable: true });
    }
  });

  it("点击行为（D5）：speaking 点击 → stopSpeaking；listening 点击 → toggleMute；muted 点击 → toggleMute（恢复）", () => {
    svState.duplexActive = true;
    svState.phase = "speaking";
    svState.speaking = true;
    renderLayer();
    fireEvent.click(screen.getByTestId("steward-orb"));
    expect(stopSpeaking).toHaveBeenCalledTimes(1);
    expect(toggleMute).not.toHaveBeenCalled();

    cleanup();
    vi.clearAllMocks();
    svState.phase = "listening";
    svState.speaking = false;
    renderLayer();
    fireEvent.click(screen.getByTestId("steward-orb"));
    expect(toggleMute).toHaveBeenCalledTimes(1);
    expect(stopSpeaking).not.toHaveBeenCalled();

    cleanup();
    vi.clearAllMocks();
    svState.muted = true; // 静音态点击 = 恢复
    renderLayer();
    fireEvent.click(screen.getByTestId("steward-orb"));
    expect(toggleMute).toHaveBeenCalledTimes(1);
  });

  it("字幕：用户行/管家行弱区分（data-kind）；interim 实时行灰显（data-interim）", () => {
    svState.duplexActive = true;
    svState.phase = "listening";
    svState.interim = "正在说这句话";
    renderLayer();
    const interim = screen.getByTestId("steward-interim");
    expect(interim.textContent).toBe("正在说这句话");
    // 终帧（口令拦截路径）→ 用户行入栈
    act(() => {
      capturedOnFinalText?.("第一句问话");
    });
    const userLine = document.querySelector('[data-testid="steward-caption"] [data-kind="user"]');
    expect(userLine?.textContent).toBe("第一句问话");
  });

  it("管家流式行：streamingText 增量入字幕（steward 行，同一轮不涨行）", async () => {
    svState.duplexActive = true;
    svState.streamingText = "回答前半";
    const { rerenderLayer } = renderLayer();
    const first = document.querySelectorAll('[data-testid="steward-caption"] [data-kind="steward"]');
    expect(first[first.length - 1]!.textContent).toBe("回答前半");
    const countBefore = first.length; // 欢迎语行 + 流进行（计数快照）
    svState.streamingText = "回答前半后半";
    rerenderLayer({});
    const stewardLines = document.querySelectorAll('[data-testid="steward-caption"] [data-kind="steward"]');
    expect(stewardLines.length).toBe(countBefore); // in-place 更新不涨行
    expect(stewardLines[stewardLines.length - 1]!.textContent).toBe("回答前半后半");
  });

  it("短驻批：行静置 6s 自动移除；行全空且无 interim → 字幕容器隐藏", () => {
    vi.useFakeTimers();
    try {
      svState.duplexActive = true;
      renderLayer();
      expect(screen.getByTestId("steward-caption")).toBeTruthy(); // 欢迎语行在场
      // TTL 内驻留（驱逐 tick 500ms 一拍——静置 5.5s 行仍在）
      act(() => {
        vi.advanceTimersByTime(5_500);
      });
      expect(screen.getByTestId("steward-caption")).toBeTruthy();
      // 过 TTL + 一拍：欢迎语行到期移除；行空且无 interim → 容器整面隐藏
      act(() => {
        vi.advanceTimersByTime(CAPTION_EVICT_TICK_MS + 1_000);
      });
      expect(screen.queryByTestId("steward-caption")).toBeNull();
      // 光球本体不受字幕驱逐影响（在场如常）
      expect(screen.getByTestId("steward-orb")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("短驻批：interim 在场则容器驻留（行空不隐藏——正在说话也算事件发生期）", () => {
    svState.duplexActive = true;
    svState.interim = "正在说这句话";
    renderLayer();
    expect(screen.getByTestId("steward-caption")).toBeTruthy();
    expect(screen.getByTestId("steward-interim")).toBeTruthy();
  });

  it("语音口令（D3=b）：整句「确认」→ steward.confirm 既有命令 + 回读字幕；无卡零动作回读", async () => {
    svState.duplexActive = true;
    renderLayer();
    // 先入栈一张卡（useStewardActions 副实例帧驱动）
    act(() => {
      emitSteward({
        type: "steward.ask.result",
        payload: { status: "confirm_required", actionId: "act-1", agentId: "主会话", message: "递话全文" },
      } as unknown as EventEnvelope);
    });
    expect(sendStewardConfirm).not.toHaveBeenCalled();
    act(() => {
      expect(capturedOnFinalText?.("确认")).toBe("consumed");
    });
    expect(sendStewardConfirm).toHaveBeenCalledTimes(1);
    expect(sendStewardConfirm).toHaveBeenCalledWith("act-1");
    expect(sendStewardAsk).not.toHaveBeenCalled(); // 口令句零 ask
    // 回读字幕（管家行）
    await waitFor(() => {
      const lines = document.querySelectorAll('[data-testid="steward-caption"] [data-kind="steward"]');
      expect(Array.from(lines).some((l) => l.textContent?.includes("主会话"))).toBe(true);
    });
  });

  it("口令「全部取消」→ 逐卡 steward.cancel + 回读撤销数；「确认5号」无卡 → 零动作回读", async () => {
    svState.duplexActive = true;
    renderLayer();
    act(() => {
      emitSteward({
        type: "steward.ask.result",
        payload: { status: "confirm_required", actionId: "a1", agentId: "会话一", message: "m" },
      } as unknown as EventEnvelope);
      emitSteward({
        type: "steward.ask.result",
        payload: { status: "confirm_required", actionId: "a2", agentId: "会话二", message: "m2" },
      } as unknown as EventEnvelope);
    });
    act(() => {
      expect(capturedOnFinalText?.("都不要了")).toBe("consumed");
    });
    expect(sendStewardCancel).toHaveBeenCalledTimes(2);
    expect(sendStewardCancel).toHaveBeenCalledWith("a1");
    expect(sendStewardCancel).toHaveBeenCalledWith("a2");
    // 「确认5号」彼时无此卡 → 零 confirm + 回读无卡
    vi.clearAllMocks();
    act(() => {
      expect(capturedOnFinalText?.("确认5号")).toBe("consumed");
    });
    expect(sendStewardConfirm).not.toHaveBeenCalled();
    await waitFor(() => {
      const lines = document.querySelectorAll('[data-testid="steward-caption"] [data-kind="steward"]');
      expect(Array.from(lines).some((l) => l.textContent?.includes("5"))).toBe(true);
    });
  });

  it("非口令句照常放行（pass → 走 ask 链）", () => {
    svState.duplexActive = true;
    renderLayer();
    act(() => {
      expect(capturedOnFinalText?.("帮我确认一下这件事")).toBe("pass");
    });
    expect(sendStewardConfirm).not.toHaveBeenCalled();
  });

  it("wakeSignal 接线（app 层 steward-open-signal）：递增 → toggleWake 唤起；已在会话幂等零重开", () => {
    const { rerenderLayer } = renderLayer({ wakeSignal: 0 });
    expect(toggleWake).not.toHaveBeenCalled();
    rerenderLayer({ wakeSignal: 1 });
    expect(toggleWake).toHaveBeenCalledTimes(1);
    // 已在会话（duplex on）：再递增无感幂等
    svState.duplexActive = true;
    rerenderLayer({ wakeSignal: 2 });
    expect(toggleWake).toHaveBeenCalledTimes(1);
  });

  // 组合键 → toggleWake 接线归 useStewardVoice（wake/duplex 测试面钉——hook
  // 注册 wake-hotkey fire handler；本文件 hook 整面 mock 不重复钉）。
});
