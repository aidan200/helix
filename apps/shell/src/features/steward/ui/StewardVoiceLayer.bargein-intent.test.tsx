// @vitest-environment jsdom
/**
 * StewardVoiceLayer barge-in 意图窗判定分支测试（批 3b 链路重排：声纹→词表→
 * 丢弃——裁决 #2 播报期单向广播）。
 *
 * 契约（批 3b 定稿链 → 行为）：
 * - R1 停止词本地消费保持：非窗内 final 停止词（「别说了/停」等）→
 *   executeBargeInStop（幂等三步序，批 3b 起携 scope=all 全停）零
 *   submitUtterance（停止词不当聊天句回灌 LLM——历史级联根因防回归）；
 * - R2 未命中丢弃（裁决 #2）：窗内 final 非停止词 → 一律丢弃关窗（声纹
 *   pass/skip 同径——排队插话与 Jev 慢通道已整体退役，播报期单向广播，
 *   唯一合法打断 = 停止词）；
 * - 回归保护：窗内停止词 + pass → 真停；窗内 reject（旁人）→ 关窗不真停；
 *   非窗内普通聊天句 + pass → 照旧 submitUtterance（正常链零劣化）；
 * - R4 卡栈口令窗内退役：播报中「取消/确认/都不要了」→ 丢弃零卡动作；
 *   播报停后（非窗内）口令照常可用（卡不随 run 死）。
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "@helix/protocol";
import { ToastProvider } from "@/shared/ui/Toast";
import { I18nProvider } from "@/shared/i18n";

const sendStewardAsk = vi.fn(() => true);
const sendStewardConfirm = vi.fn(() => true);
const sendStewardCancel = vi.fn(() => true);
const sendStewardInterrupt = vi.fn(() => true);
const sendStewardSubscribe = vi.fn(() => true);
const sendStewardUnsubscribe = vi.fn(() => true);

const stewardListeners = new Set<(e: EventEnvelope) => void>();

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { active: { conn: "connected" } },
    sendStewardAsk,
    sendStewardConfirm,
    sendStewardCancel,
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

// ── useStewardVoice 受控桩（批 3b：queueUtterance/judgeStopIntent 已退役）──
const submitUtterance = vi.fn();
const executeBargeInStop = vi.fn();
const closeBargeInIntentWindow = vi.fn();
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

describe("StewardVoiceLayer barge-in 意图判定分支（批 3b 链路重排：声纹→词表→丢弃）", () => {
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

  it("R1-B 扩充词表新词「够了」非窗内同样本地消费真停（批 3b 词表 14 词单源生效）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    act(() => {
      expect(capturedOnFinalText?.("够了")).toBe("consumed");
    });
    await waitFor(() => expect(executeBargeInStop).toHaveBeenCalledTimes(1));
    expect(submitUtterance).not.toHaveBeenCalled();
  });

  it("R2 窗内非停止词 + 声纹 skip（未注册/推断失败）→ 丢弃关窗：零 submit 零提示零真停（裁决 #2 单向广播）", async () => {
    renderLayer(gateReturning({ kind: "skip", reason: "unregistered" }));
    act(() => {
      expect(capturedOnFinalText?.("顺便帮我查下天气", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(closeBargeInIntentWindow).toHaveBeenCalledTimes(1));
    expect(submitUtterance).not.toHaveBeenCalled();
    expect(executeBargeInStop).not.toHaveBeenCalled();
  });

  it("R2 窗内非停止词 + 声纹 pass → 同径丢弃关窗（排队特权面整体退役——pass 不再开 LLM 后门）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    act(() => {
      expect(capturedOnFinalText?.("顺便帮我查下天气", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(closeBargeInIntentWindow).toHaveBeenCalledTimes(1));
    expect(submitUtterance).not.toHaveBeenCalled(); // 无排队无自动提交
    expect(executeBargeInStop).not.toHaveBeenCalled();
  });

  it("保护：窗内停止词 + pass → 真停（词表命中 = 唯一合法打断）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    act(() => {
      expect(capturedOnFinalText?.("停止", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(executeBargeInStop).toHaveBeenCalledTimes(1));
    expect(submitUtterance).not.toHaveBeenCalled();
  });

  it("保护：窗内 reject（旁人）→ 关窗不真停（旁人防线保持——词表也不放行）", async () => {
    renderLayer(gateReturning({ kind: "reject", score: 0.2 }));
    act(() => {
      expect(capturedOnFinalText?.("停", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(closeBargeInIntentWindow).toHaveBeenCalledTimes(1));
    expect(executeBargeInStop).not.toHaveBeenCalled(); // 旁人喊停被声纹总闸挡
    expect(submitUtterance).not.toHaveBeenCalled();
  });

  it("保护：非窗内普通聊天句 + pass → 照旧 submitUtterance（正常链零劣化）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    act(() => {
      expect(capturedOnFinalText?.("今天天气怎么样")).toBe("consumed");
    });
    await waitFor(() => expect(submitUtterance).toHaveBeenCalledWith("今天天气怎么样"));
    expect(executeBargeInStop).not.toHaveBeenCalled();
  });

  // ── R4 卡栈口令窗内退役（裁决 #2：播报中口令丢弃——先喊停再说口令，
  //    播报停后口令照常可用（卡不随 run 死））──────────────────────────

  it("R4-A 窗内「取消」+ pass → 丢弃零卡动作；播报停后（非窗内）「取消」照常 cancelCard", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    act(() => {
      stewardListeners.forEach((fn) =>
        fn({ type: "steward.ask.result", payload: { status: "confirm_required", actionId: "a1", agentId: "主会话", message: "m" } } as unknown as EventEnvelope),
      );
    });
    // 阶段一：播报中（窗内）说「取消」→ 丢弃，零卡动作零真停
    act(() => {
      expect(capturedOnFinalText?.("取消", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(closeBargeInIntentWindow).toHaveBeenCalledTimes(1));
    expect(sendStewardCancel).not.toHaveBeenCalled(); // 窗内口令不直达
    expect(executeBargeInStop).not.toHaveBeenCalled(); // 口令不是停止词——不真停
    expect(submitUtterance).not.toHaveBeenCalled();
    // 阶段二：播报已停（喊过停/自然播完 → 非窗内）再说「取消」→ 卡栈动作照常
    act(() => {
      expect(capturedOnFinalText?.("取消")).toBe("consumed");
    });
    await waitFor(() => expect(sendStewardCancel).toHaveBeenCalledWith("a1"));
    expect(executeBargeInStop).toHaveBeenCalledTimes(0); // 口令路径本就不真停
  });

  it("R4-B 窗内「都不要了」多卡 → 同径丢弃零卡动作（多卡直达面随口令窗内退役）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    act(() => {
      stewardListeners.forEach((fn) => {
        fn({ type: "steward.ask.result", payload: { status: "confirm_required", actionId: "a1", agentId: "会话一", message: "m" } } as unknown as EventEnvelope);
        fn({ type: "steward.ask.result", payload: { status: "confirm_required", actionId: "a2", agentId: "会话二", message: "m2" } } as unknown as EventEnvelope);
      });
    });
    act(() => {
      expect(capturedOnFinalText?.("都不要了", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(closeBargeInIntentWindow).toHaveBeenCalledTimes(1));
    expect(sendStewardCancel).not.toHaveBeenCalled();
    expect(sendStewardConfirm).not.toHaveBeenCalled();
    expect(executeBargeInStop).not.toHaveBeenCalled();
    expect(submitUtterance).not.toHaveBeenCalled();
  });
});
