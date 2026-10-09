// @vitest-environment jsdom
/**
 * StewardVoiceLayer barge-in 意图窗判定分支测试（回归修复批：停止词回灌 +
 * 排队身份收紧）。
 *
 * 契约（回归根因 → 行为）：
 * - R1-A 停止词回灌：非窗内 final 停止词（「别说了」等）→ 本地消费——
 *   executeBargeInStop（幂等三步序）零 submitUtterance（不再把停止词当
 *   聊天句发 LLM——真停后又开新一轮播报的级联根因）；
 * - R2 排队身份收紧：窗内 final 非停止词 → 仅声纹 pass（注册且匹配）才
 *   queueUtterance；skip（未注册/推断失败）→ 不排队不 ask + 关窗 + 白话
 *   提示（排队插话是特权——需正面身份确认；噪音/旁人灰区话语不再进 LLM）；
 * - 回归保护：窗内 pass 非停 → 排队 + 关窗 + 「听到了」字幕；窗内停止词
 *   pass → 真停不排队；窗内 reject → 关窗不排队（旁人防线保持）。
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "@helix/protocol";
import { ToastProvider } from "@/shared/ui/Toast";
import { I18nProvider } from "@/shared/i18n";

const sendStewardAsk = vi.fn(() => true);
const sendStewardConfirm = vi.fn(() => true);
const sendStewardInterrupt = vi.fn(() => true);
const sendStewardSubscribe = vi.fn(() => true);
const sendStewardUnsubscribe = vi.fn(() => true);

const stewardListeners = new Set<(e: EventEnvelope) => void>();

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { active: { conn: "connected" } },
    sendStewardAsk,
    sendStewardConfirm,
    sendStewardInterrupt,
    subscribeStewardFrames: (cb: (e: EventEnvelope) => void) => {
      stewardListeners.add(cb);
      return () => {
        stewardListeners.delete(cb);
      };
    },
    sendStewardUnsubscribe,
    sendStewardGetConfig: vi.fn(() => true),
  }),
}));

vi.mock("@/shared/lib/stt-provider-pref", () => ({ readSttProviderPref: () => undefined }));
vi.mock("@/shared/lib/wake-hotkey", () => ({
  setWakeHotkeyFireHandler: () => undefined,
  syncWakeHotkeyRegistration: async () => "ok" as const,
}));

// ── useStewardVoice 受控桩（同 voiceprint 测试形态 + 意图窗动作面）──
const submitUtterance = vi.fn();
const executeBargeInStop = vi.fn();
const queueUtterance = vi.fn();
const closeBargeInIntentWindow = vi.fn();
// 语义停止判官桩（意图窗慢通道）：缺省 false（照排队——daemon 降级链同向）；
// 判停用例 mockResolvedValueOnce(true) 覆写
const judgeStopIntent = vi.fn((_text: string) => Promise.resolve(false));
const fakePcm = new Float32Array(16000);
let capturedOnFinalText:
  | ((text: string, ctx?: { bargeInIntent: boolean }) => "consumed" | "pass")
  | undefined;

vi.mock("../model/useStewardVoice", () => ({
  useStewardVoice: (options?: {
    onFinalText?: (text: string, ctx?: { bargeInIntent: boolean }) => "consumed" | "pass";
  }) => {
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
      phase: "idle",
      level: 0.6,
      userSpeaking: false,
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
      notifSpeaking: false,
      bargeInIntentActive: false,
      executeBargeInStop,
      closeBargeInIntentWindow,
      queueUtterance,
      judgeStopIntent,
      muted: false,
      toggleMute: () => undefined,
      toggleWake: () => undefined,
      say: vi.fn(),
      submitUtterance,
      lastUtterancePcm: () => fakePcm,
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

function gateReturning(decision: VerifyDecision): VoiceprintGate {
  return { verifyGate: () => Promise.resolve(decision) };
}

describe("StewardVoiceLayer barge-in 意图判定分支（回归修复：停止词本地消费 + 排队身份收紧）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stewardListeners.clear();
    localStorage.setItem("helix-lang", "zh-CN");
  });
  afterEach(() => {
    cleanup();
  });

  it("R1-A 非窗内停止词 final → 本地消费：真停（幂等）+ 零 submitUtterance（停止词不当聊天句发 LLM）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    let consumed: string | undefined;
    act(() => {
      consumed = capturedOnFinalText?.("别说了") ?? "pass";
    });
    expect(consumed).toBe("consumed");
    await waitFor(() => expect(executeBargeInStop).toHaveBeenCalledTimes(1));
    expect(submitUtterance).not.toHaveBeenCalled(); // 零回灌——真停后不再开新轮
    expect(sendStewardAsk).not.toHaveBeenCalled();
  });

  it("R1-A 强停止词「停」同样本地消费（词表口令族不含停止词——原会整句发 LLM）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    act(() => {
      expect(capturedOnFinalText?.("停")).toBe("consumed");
    });
    await waitFor(() => expect(executeBargeInStop).toHaveBeenCalledTimes(1));
    expect(submitUtterance).not.toHaveBeenCalled();
  });

  it("R2 窗内非停止词 + 声纹 skip（未注册/推断失败）→ 不排队不 ask + 关窗 + 白话提示", async () => {
    renderLayer(gateReturning({ kind: "skip", reason: "unregistered" }));
    act(() => {
      expect(capturedOnFinalText?.("顺便帮我查下天气", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(closeBargeInIntentWindow).toHaveBeenCalledTimes(1));
    expect(queueUtterance).not.toHaveBeenCalled(); // 排队特权需正面身份
    expect(submitUtterance).not.toHaveBeenCalled();
    await waitFor(() => {
      const lines = document.querySelectorAll('[data-testid="steward-caption"] [data-kind="steward"]');
      expect(Array.from(lines).some((l) => l.textContent?.includes("无法确认"))).toBe(true);
    });
  });

  it("保护：窗内非停止词 + 声纹 pass → 排队 + 关窗 +「听到了」字幕（D1 排队路径保持）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    act(() => {
      expect(capturedOnFinalText?.("顺便帮我查下天气", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(queueUtterance).toHaveBeenCalledWith("顺便帮我查下天气"));
    await waitFor(() => expect(closeBargeInIntentWindow).toHaveBeenCalledTimes(1));
    expect(executeBargeInStop).not.toHaveBeenCalled();
    expect(submitUtterance).not.toHaveBeenCalled();
  });

  it("保护：窗内停止词 + pass → 真停不排队", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    act(() => {
      expect(capturedOnFinalText?.("停止", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(executeBargeInStop).toHaveBeenCalledTimes(1));
    expect(queueUtterance).not.toHaveBeenCalled();
  });

  it("R3 语义停止判官判停：窗内非词表停止表达（「先别说了，等一下」）+ pass + 判官 true → 真停不排队", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    judgeStopIntent.mockResolvedValueOnce(true);
    act(() => {
      expect(capturedOnFinalText?.("先别说了，等一下", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(judgeStopIntent).toHaveBeenCalledWith("先别说了，等一下"));
    await waitFor(() => expect(executeBargeInStop).toHaveBeenCalledTimes(1));
    expect(queueUtterance).not.toHaveBeenCalled(); // 判停优先于排队
    expect(submitUtterance).not.toHaveBeenCalled();
  });

  it("R3-b 判官不判停（纠正/补充内容）→ 照排队不真停（降级/超时同路径 false）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    judgeStopIntent.mockResolvedValueOnce(false);
    act(() => {
      expect(capturedOnFinalText?.("我想补充一点，参数改成 5", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(judgeStopIntent).toHaveBeenCalledWith("我想补充一点，参数改成 5"));
    await waitFor(() => expect(queueUtterance).toHaveBeenCalledWith("我想补充一点，参数改成 5"));
    expect(executeBargeInStop).not.toHaveBeenCalled();
  });

  it("保护：窗内 reject（旁人）→ 关窗不排队不真停（旁人防线保持）", async () => {
    renderLayer(gateReturning({ kind: "reject", score: 0.2 }));
    act(() => {
      expect(capturedOnFinalText?.("随便说点什么", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(closeBargeInIntentWindow).toHaveBeenCalledTimes(1));
    expect(queueUtterance).not.toHaveBeenCalled();
    expect(executeBargeInStop).not.toHaveBeenCalled();
  });

  it("保护：非窗内普通聊天句 + pass → 照旧 submitUtterance（正常链零劣化）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    act(() => {
      expect(capturedOnFinalText?.("今天天气怎么样")).toBe("consumed");
    });
    await waitFor(() => expect(submitUtterance).toHaveBeenCalledWith("今天天气怎么样"));
    expect(executeBargeInStop).not.toHaveBeenCalled();
    expect(queueUtterance).not.toHaveBeenCalled();
  });
});
