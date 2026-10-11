// @vitest-environment jsdom
/**
 * StewardVoiceLayer 声纹接线测试（M3-c 声纹批）——授权点校验门。
 *
 * 契约（brief：只在确认口令消费卡之前校验）：
 * - confirm 口令 → verifyGate(本句 PCM) → pass/skip → confirmCard 放行（照旧回读）；
 * - reject → 零 confirmCard + 纯语音白话明示（say + 字幕）+ **卡保留**
 *   （拒绝不是 cancel——卡继续挂着等重说或 TTL，E-204 语义）；
 * - gate 抛错 → 兜底照旧放行（授权链零劣化——E-250 同构）；
 * - cancel 口令/非口令句不经声纹门（只挂授权点）。
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "@helix/protocol";
import { ToastProvider } from "@/shared/ui/Toast";
import { I18nProvider } from "@/shared/i18n";

const sendStewardAsk = vi.fn(() => true);
const sendStewardConfirm = vi.fn(() => true);
const sendStewardCancel = vi.fn(() => true);
const sendStewardSubscribe = vi.fn(() => true);
const sendStewardUnsubscribe = vi.fn(() => true);

const stewardListeners = new Set<(e: EventEnvelope) => void>();
function emitSteward(e: EventEnvelope): void {
  for (const l of stewardListeners) l(e);
}

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { active: { conn: "connected" } },
    sendStewardAsk,
    sendStewardConfirm,
    sendStewardCancel,
    sendStewardInterrupt: vi.fn(() => true),
    sendStewardSubscribe,
    sendStewardUnsubscribe,
    sendStewardGetConfig: vi.fn(() => true),
    subscribeStewardFrames: (cb: (e: EventEnvelope) => void) => {
      stewardListeners.add(cb);
      return () => {
        stewardListeners.delete(cb);
      };
    },
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

// ── useStewardVoice 受控桩（同 Layer 主测试形态 + 声纹面 lastUtterancePcm）──
const say = vi.fn();
const submitUtterance = vi.fn();
const fakePcm = new Float32Array(16000); // 1s（Int16 域）
const lastUtterancePcm = vi.fn(() => fakePcm);
let capturedOnFinalText: ((text: string) => "consumed" | "pass") | undefined;

vi.mock("../model/useStewardVoice", () => ({
  useStewardVoice: (options?: { onFinalText?: (text: string) => "consumed" | "pass" }) => {
    capturedOnFinalText = options?.onFinalText;
    return {
      items: [],
      streamingText: null,
      askActivity: null,
      feed: [],
      askInFlight: false,
      config: { enabled: true, model: "x/y" },
      ask: () => true,
      newDialog: () => true,
      mode: "voice",
      setMode: () => undefined,
      phase: "listening",
      level: 0.6,
      userSpeaking: true,
      interim: null,
      streamDegraded: false,
      speaking: false,
      voiceError: null,
      voiceDraft: null,
      startListening: async () => undefined,
      stopListening: () => undefined,
      stopSpeaking: () => undefined,
      clearVoiceDraft: () => undefined,
      duplexActive: true,
      welcomeActive: false,
      muted: false,
      toggleMute: () => undefined,
      toggleWake: () => undefined,
      say,
      submitUtterance,
      lastUtterancePcm,
    };
  },
}));

import StewardVoiceLayer from "./StewardVoiceLayer";
import type { VoiceprintGate } from "../voiceprint/model/steward-voiceprint";
import type { VerifyDecision } from "../voiceprint/model/voiceprint-service";

localStorage.setItem("helix-lang", "zh-CN");

function renderLayer(gate?: VoiceprintGate) {
  return render(
    <ToastProvider>
      <I18nProvider>
        <StewardVoiceLayer {...(gate !== undefined ? { voiceprintGate: gate } : {})} />
      </I18nProvider>
    </ToastProvider>,
  );
}

/** 入栈一张确认卡（useStewardActions 副实例帧驱动）。 */
function pushCard(actionId = "act-1", agentId = "主会话"): void {
  act(() => {
    emitSteward({
      type: "steward.ask.result",
      payload: { status: "confirm_required", actionId, agentId, message: "递话全文" },
    } as unknown as EventEnvelope);
  });
}

function gateReturning(decision: VerifyDecision): VoiceprintGate & { calls: number; lastPcm: Float32Array | null } {
  const g = {
    calls: 0,
    lastPcm: null as Float32Array | null,
    async verifyGate(pcm: Float32Array | null) {
      g.calls += 1;
      g.lastPcm = pcm;
      return decision;
    },
  };
  return g;
}

describe("StewardVoiceLayer 声纹总闸（链路重排：机械→声纹→Jev→LLM）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stewardListeners.clear();
    fireWakeHotkey = null;
    localStorage.setItem("helix-lang", "zh-CN");
  });
  afterEach(() => {
    cleanup();
  });

  it("pass → 消费卡放行（confirmCard 照旧 + 本句 PCM 送验）", async () => {
    const gate = gateReturning({ kind: "pass" });
    renderLayer(gate);
    pushCard();
    act(() => {
      expect(capturedOnFinalText?.("确认")).toBe("consumed");
    });
    await waitFor(() => expect(sendStewardConfirm).toHaveBeenCalledTimes(1));
    expect(sendStewardConfirm).toHaveBeenCalledWith("act-1");
    expect(gate.calls).toBe(1);
    expect(gate.lastPcm).toBe(fakePcm); // 本句音频（授权点前最后语音段）
    expect(sendStewardAsk).not.toHaveBeenCalled(); // 口令句零 ask
  });

  it("skip（未注册等）→ 照旧放行（授权链零劣化）", async () => {
    const gate = gateReturning({ kind: "skip", reason: "unregistered" });
    renderLayer(gate);
    pushCard();
    act(() => {
      expect(capturedOnFinalText?.("确认")).toBe("consumed");
    });
    await waitFor(() => expect(sendStewardConfirm).toHaveBeenCalledTimes(1));
    expect(gate.calls).toBe(1);
  });

  it("reject → 零 confirm + 只上字幕不出声（零 reject 回读）+ 卡保留（零 cancel）", async () => {
    const gate = gateReturning({ kind: "reject", score: 0.3 });
    renderLayer(gate);
    pushCard("act-reject", "写操作");
    act(() => {
      expect(capturedOnFinalText?.("确认")).toBe("consumed");
    });
    // 输入流水注记「声纹未过（相似度 N%，阈值 M%）」（分区批：闸门反馈入左侧输入流水）
    await waitFor(() => {
      const note = document.querySelector('[data-testid="steward-input-note"]');
      expect(note?.getAttribute("data-note")).toBe("voiceprint-reject");
      expect(note?.textContent).toMatch(/^声纹未过（相似度 30%，阈值 \d+%）$/);
    });
    expect(sendStewardConfirm).not.toHaveBeenCalled();
    expect(sendStewardCancel).not.toHaveBeenCalled(); // 拒绝不是 cancel——卡保留等重说或 TTL
    // 只上屏不出声（用户裁决）：say 零 reject 文案回读（弹卡触达播报另算）
    expect(Array.from(say.mock.calls).some((c) => String(c[0]).includes("声纹未过"))).toBe(false);
  });

  it("gate 抛错 → 兜底照旧放行（gate 面异常不吞授权）", async () => {
    const gate: VoiceprintGate = {
      verifyGate: () => Promise.reject(new Error("gate boom")),
    };
    renderLayer(gate);
    pushCard();
    act(() => {
      expect(capturedOnFinalText?.("确认")).toBe("consumed");
    });
    await waitFor(() => expect(sendStewardConfirm).toHaveBeenCalledTimes(1));
  });

  it("cancel 口令同过声纹总闸（每轮必验）：pass → cancel 执行 + gate 调用", async () => {
    const gate = gateReturning({ kind: "pass" });
    renderLayer(gate);
    pushCard("act-c", "会话");
    act(() => {
      expect(capturedOnFinalText?.("取消")).toBe("consumed");
    });
    await waitFor(() => expect(sendStewardCancel).toHaveBeenCalledTimes(1));
    expect(gate.calls).toBe(1); // 总闸：cancel 也验（链路重排：每轮必验语义）
    expect(sendStewardConfirm).not.toHaveBeenCalled();
  });

  it("cancel 口令 reject → 零 cancel（卡保留；注记附相似度 10%）", async () => {
    const gate = gateReturning({ kind: "reject", score: 0.1 });
    renderLayer(gate);
    pushCard("act-c2", "会话");
    act(() => {
      capturedOnFinalText?.("取消");
    });
    await waitFor(() => {
      const note = document.querySelector('[data-testid="steward-input-note"]');
      expect(note?.textContent).toMatch(/^声纹未过（相似度 10%，阈值 \d+%）$/);
    });
    expect(sendStewardCancel).not.toHaveBeenCalled();
    expect(gate.calls).toBe(1);
  });

  it("聊天句同样过总闸：reject → 零 submitUtterance（零 ask；注记附相似度 20%）", async () => {
    const gate = gateReturning({ kind: "reject", score: 0.2 });
    renderLayer(gate);
    act(() => {
      expect(capturedOnFinalText?.("今天天气怎么样")).toBe("consumed");
    });
    await waitFor(() => {
      const note = document.querySelector('[data-testid="steward-input-note"]');
      expect(note?.textContent).toMatch(/^声纹未过（相似度 20%，阈值 \d+%）$/);
    });
    expect(submitUtterance).not.toHaveBeenCalled();
  });

  it("聊天句 pass → submitUtterance 发问（本句 PCM 送验）", async () => {
    const gate = gateReturning({ kind: "pass" });
    renderLayer(gate);
    act(() => {
      expect(capturedOnFinalText?.("今天天气怎么样")).toBe("consumed");
    });
    await waitFor(() => expect(submitUtterance).toHaveBeenCalledWith("今天天气怎么样"));
    expect(gate.calls).toBe(1);
    expect(gate.lastPcm).toBe(fakePcm);
  });

  it("reject 后卡仍在：再次「确认」（pass）→ 放行成功（等重说语义）", async () => {
    const gate = gateReturning({ kind: "reject", score: 0.2 });
    const { rerender } = renderLayer(gate);
    pushCard("act-retry", "重试卡");
    act(() => {
      capturedOnFinalText?.("确认");
    });
    await waitFor(() => expect(say).toHaveBeenCalledTimes(1));
    expect(sendStewardConfirm).not.toHaveBeenCalled();
    // 换 pass gate 重渲（同一张卡还在栈上——卡保留）
    const gate2 = gateReturning({ kind: "pass" });
    rerender(
      <ToastProvider>
        <I18nProvider>
          <StewardVoiceLayer voiceprintGate={gate2} />
        </I18nProvider>
      </ToastProvider>,
    );
    act(() => {
      capturedOnFinalText?.("确认");
    });
    await waitFor(() => expect(sendStewardConfirm).toHaveBeenCalledTimes(1));
    expect(sendStewardConfirm).toHaveBeenCalledWith("act-retry");
  });
});
