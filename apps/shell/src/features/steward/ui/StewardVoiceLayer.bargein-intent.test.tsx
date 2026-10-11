// @vitest-environment jsdom
/**
 * StewardVoiceLayer barge-in 判定分支测试（Jev 停止意图判官单轨：声纹→判官→
 * 真停/丢弃——停止词表已整体退役）。
 *
 * 契约（判官单轨定稿链 → 行为）：
 * - R1 判 stop 本地消费保持：非窗内 final 判官判「要打断」（「别说了/停」等
 *   纯停止文本经判官仍真停——③行为兼容回归）→ executeBargeInStop（幂等三
 *   步序，携 scope=all 全停）零 submitUtterance（停止句不当聊天句回灌 LLM
 *   ——历史级联根因防回归）；
 * - R2 判非 stop 丢弃（裁决 #2）：窗内 final 判官判「不打断」→ 一律丢弃关
 *   窗（声纹 pass/skip 同径——单向广播，播报期唯一合法打断 = 判官判停）；
 * - ①判不出 = 真停（宁误停不漏停）：判官报错/超时/不可达（判官判定面归一
 *   "unjudged"）→ 窗内真停 scope=all；判官面抛异常同径防御真停；
 *   非窗内判不出 → 照常 submitUtterance（正常链零劣化——判不出不吞用户
 *   正常发言，停止判定缺席只影响喊停灵敏度不影响对话可用性）；
 * - 回归保护：窗内判 stop + pass → 真停；窗内 reject（旁人）→ 关窗不真停
 *   且判官零调用（声纹总闸先于判官）；非窗内普通聊天句 + pass → 照旧
 *   submitUtterance（正常链零劣化）；
 * - R4 卡栈口令窗内退役：播报中「取消/确认/都不要了」→ 判官判非停 → 丢弃
 *   零卡动作；播报停后（非窗内）口令照常可用（卡不随 run 死）。
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

// ── useStewardVoice 受控桩（Jev 停止判定归 hook 判官接线，Layer 只消费判定）──
const submitUtterance = vi.fn();
const executeBargeInStop = vi.fn();
const closeBargeInIntentWindow = vi.fn();
/** Jev 停止意图判官桩（语义模拟——零生成 token 分类判定的 shell 侧替身）：
 *  「停/停止」族纯停止文本判 stop（③行为兼容回归的判官语义），其余判
 *  other；判不出用例 mockResolvedValueOnce("unjudged") / mockRejectedValueOnce
 *  覆写。 */
const judgeStopIntent = vi.fn(
  async (text: string): Promise<"stop" | "other" | "unjudged"> =>
    new Set(["停", "停下", "停止", "停一下", "别说了", "先别说了", "不要说了", "不用说了", "别念了", "别说话了", "闭嘴", "住嘴", "够了", "stop"]).has(
      text.trim().replace(/[。．.!！?？?，,、；;～~\s]+$/u, ""),
    )
      ? "stop"
      : "other",
);
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

describe("StewardVoiceLayer barge-in 判定分支（Jev 停止意图判官单轨：声纹→判官→真停/丢弃）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stewardListeners.clear();
    localStorage.setItem("helix-lang", "zh-CN");
  });
  afterEach(() => {
    cleanup();
  });

  it("R1-A 非窗内判 stop → 本地消费：真停（幂等）+ 零 submitUtterance（停止句不当聊天句发 LLM）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    let consumed: string | undefined;
    act(() => {
      consumed = capturedOnFinalText?.("别说了") ?? "pass";
    });
    expect(consumed).toBe("consumed");
    await waitFor(() => expect(executeBargeInStop).toHaveBeenCalledTimes(1));
    expect(judgeStopIntent).toHaveBeenCalledWith("别说了"); // 停止判定单源 = Jev 判官（词表已退役）
    expect(submitUtterance).not.toHaveBeenCalled(); // 零回灌——真停后不再开新轮
    expect(sendStewardAsk).not.toHaveBeenCalled();
  });

  it("R1-A 强停止文本「停」经判官仍真停（③行为兼容回归——原词表口令族经判官语义判定）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    act(() => {
      expect(capturedOnFinalText?.("停")).toBe("consumed");
    });
    await waitFor(() => expect(executeBargeInStop).toHaveBeenCalledTimes(1));
    expect(judgeStopIntent).toHaveBeenCalledWith("停");
    expect(submitUtterance).not.toHaveBeenCalled();
  });

  it("R1-B 停止文本「够了」非窗内同样本地消费真停（③行为兼容回归）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    act(() => {
      expect(capturedOnFinalText?.("够了")).toBe("consumed");
    });
    await waitFor(() => expect(executeBargeInStop).toHaveBeenCalledTimes(1));
    expect(submitUtterance).not.toHaveBeenCalled();
  });

  it("R2 窗内判非 stop + 声纹 skip（未注册/推断失败）→ 丢弃关窗：零 submit 零提示零真停（裁决 #2 单向广播）", async () => {
    renderLayer(gateReturning({ kind: "skip", reason: "unregistered" }));
    act(() => {
      expect(capturedOnFinalText?.("顺便帮我查下天气", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(closeBargeInIntentWindow).toHaveBeenCalledTimes(1));
    expect(submitUtterance).not.toHaveBeenCalled();
    expect(executeBargeInStop).not.toHaveBeenCalled();
  });

  it("R2 窗内判非 stop + 声纹 pass → 同径丢弃关窗（②判官判不打断 = 丢弃零提交）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    act(() => {
      expect(capturedOnFinalText?.("顺便帮我查下天气", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(closeBargeInIntentWindow).toHaveBeenCalledTimes(1));
    expect(submitUtterance).not.toHaveBeenCalled(); // 无排队无自动提交
    expect(executeBargeInStop).not.toHaveBeenCalled();
  });

  it("保护：窗内判 stop + pass → 真停（判官判停 = 唯一合法打断）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    act(() => {
      expect(capturedOnFinalText?.("停止", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(executeBargeInStop).toHaveBeenCalledTimes(1));
    expect(submitUtterance).not.toHaveBeenCalled();
  });

  it("① 窗内判不出（判官报错/超时/不可达归一 unjudged）→ 真停（宁误停不漏停）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    judgeStopIntent.mockResolvedValueOnce("unjudged");
    act(() => {
      expect(capturedOnFinalText?.("现在说到哪了", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(executeBargeInStop).toHaveBeenCalledTimes(1));
    expect(submitUtterance).not.toHaveBeenCalled();
  });

  it("① 判官面抛异常 → 防御同径真停（判不出 = 真停）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    judgeStopIntent.mockRejectedValueOnce(new Error("judge boom"));
    act(() => {
      expect(capturedOnFinalText?.("现在说到哪了", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(executeBargeInStop).toHaveBeenCalledTimes(1));
    expect(submitUtterance).not.toHaveBeenCalled();
  });

  it("非窗内判不出 → 照常 submitUtterance（正常链零劣化——判不出不吞用户正常发言）", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    judgeStopIntent.mockResolvedValueOnce("unjudged");
    act(() => {
      expect(capturedOnFinalText?.("今天天气怎么样")).toBe("consumed");
    });
    await waitFor(() => expect(submitUtterance).toHaveBeenCalledWith("今天天气怎么样"));
    expect(executeBargeInStop).not.toHaveBeenCalled();
  });

  it("保护：窗内 reject（旁人）→ 关窗不真停且判官零调用（旁人防线保持——声纹总闸先于判官）", async () => {
    renderLayer(gateReturning({ kind: "reject", score: 0.2 }));
    act(() => {
      expect(capturedOnFinalText?.("停", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(closeBargeInIntentWindow).toHaveBeenCalledTimes(1));
    expect(executeBargeInStop).not.toHaveBeenCalled(); // 旁人喊停被声纹总闸挡
    expect(judgeStopIntent).not.toHaveBeenCalled();
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

  it("R4-A 窗内「取消」+ pass → 判官判非停丢弃零卡动作；播报停后（非窗内）「取消」照常 cancelCard", async () => {
    renderLayer(gateReturning({ kind: "pass" }));
    act(() => {
      stewardListeners.forEach((fn) =>
        fn({ type: "steward.ask.result", payload: { status: "confirm_required", actionId: "a1", agentId: "主会话", message: "m" } } as unknown as EventEnvelope),
      );
    });
    // 阶段一：播报中（窗内）说「取消」→ 判官判非停 → 丢弃，零卡动作零真停
    act(() => {
      expect(capturedOnFinalText?.("取消", { bargeInIntent: true })).toBe("consumed");
    });
    await waitFor(() => expect(closeBargeInIntentWindow).toHaveBeenCalledTimes(1));
    expect(sendStewardCancel).not.toHaveBeenCalled(); // 窗内口令不直达
    expect(executeBargeInStop).not.toHaveBeenCalled(); // 口令判非停——不真停
    expect(submitUtterance).not.toHaveBeenCalled();
    // 阶段二：播报已停（喊过停/自然播完 → 非窗内）再说「取消」→ 卡栈动作照常
    act(() => {
      expect(capturedOnFinalText?.("取消")).toBe("consumed");
    });
    await waitFor(() => expect(sendStewardCancel).toHaveBeenCalledWith("a1"));
    expect(executeBargeInStop).toHaveBeenCalledTimes(0); // 口令路径本就不真停
  });

  it("R4-B 窗内「都不要了」多卡 → 同径判非停丢弃零卡动作（多卡直达面随口令窗内退役）", async () => {
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
