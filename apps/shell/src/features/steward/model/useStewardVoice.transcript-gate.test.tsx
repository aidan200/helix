// @vitest-environment jsdom
/**
 * useStewardVoice 转写消费门测试（handleTranscript duplex/wake 会话门）。
 *
 * 背景：onTranscript 的唯一消费端 handleTranscript 入口原无会话门——任何
 * 迟到转写结果（FileReader.onload 迟归复活链等状态面漏网路径，及未来新增
 * 回归路径）都会照常 `steward.ask` 发起 LLM 轮 + TTS 朗读：已关掉的管家
 * 突然开口念回答（幽灵回答），且 ask 落对话历史。
 *
 * 门语义：duplex 双工或唤醒会话（B4）任一活跃 → 放行；双双落定（关麦/待命
 * 超时收口后）→ 零 ask 零 TTS（纵深防御——与 useVoiceInput 迟归代数守卫
 * （transcribe-residue 测试）分层，状态面漏网时行为面兜底）。
 *
 * mock 面：SessionContext 同构 + useVoiceInput 整体 mock（捕获
 * onTranscript = handleTranscript 直引用——绕过录音状态机，纯测门行为）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, act, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";

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
function makeSubscribe(domain: "steward" | "stt" | "voice") {
  return vi.fn((cb: (e: EventEnvelope) => void) => {
    listeners[domain]!.add(cb);
    return () => {
      listeners[domain]!.delete(cb);
    };
  });
}

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { active: { conn: "connected" } },
    sendStewardAsk,
    sendStewardConfirm,
    sendStewardInterrupt,
    sendStewardSubscribe,
    sendStewardUnsubscribe,
    sendStewardGetConfig,
    subscribeStewardFrames: makeSubscribe("steward"),
    sendSttTranscribe,
    subscribeSttFrames: makeSubscribe("stt"),
    sendSttStreamStart,
    sendSttStreamChunk,
    sendSttStreamFinish,
    sendSttStreamStop,
    sendVoiceSynthesize,
    sendVoiceSynthesizeStream,
    sendVoiceSynthesizeStop,
    subscribeVoiceFrames: makeSubscribe("voice"),
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

/** useVoiceInput hook 面 mock（捕获 onTranscript = handleTranscript 直引用）；
 *  常量导出面保留真身（steward-voice-machine 等仍消费 VOICE_* 常量）。
 *  state 可变（start→recording / cancel→idle）：相位门由 voiceState 推导 phase，
 *  fake 需真实驱动相位流转（开麦非 idle、关麦回 idle）。 */
const { capturedOnTranscript } = vi.hoisted(() => ({
  capturedOnTranscript: { current: null as null | ((text: string) => void) },
}));
vi.mock("@/shared/lib/useVoiceInput", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/useVoiceInput")>();
  const { useState } = await import("react");
  return {
    ...actual,
    useVoiceInput: (onTranscript: (text: string) => void) => {
      capturedOnTranscript.current = onTranscript;
      const [state, setState] = useState<"idle" | "recording">("idle");
      return {
        state,
        level: 0,
        error: null,
        start: vi.fn(async () => {
          setState("recording");
        }),
        stop: vi.fn(),
        cancel: vi.fn(() => {
          setState("idle");
        }),
        resolveStreaming: vi.fn(() => false),
        transcribeNow: vi.fn(),
      };
    },
  };
});

import { useStewardVoice } from "./useStewardVoice";

type HookResult = { current: ReturnType<typeof useStewardVoice> };

function renderVoice(): HookResult {
  return renderHook(() => useStewardVoice({}), { wrapper: I18nProvider }).result;
}

describe("useStewardVoice 转写消费门（handleTranscript 会话门——幽灵 ask 防线）", () => {
  beforeEach(() => {
    localStorage.clear();
    for (const s of Object.values(listeners)) s.clear();
    fireWakeHotkey = null;
    capturedOnTranscript.current = null;
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("duplex 活跃 → 转写正常消费（门放行，不误拦合法轮）", async () => {
    const r = renderVoice();
    await act(async () => {
      fireWakeHotkey?.();
    });
    await waitFor(() => expect(r.current.duplexActive).toBe(true));
    act(() => {
      capturedOnTranscript.current?.("帮我看下今天日程");
    });
    await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledTimes(1));
  });

  it("关麦后迟到转写 → 零 ask 零幽灵轮（门拦截：duplex 与唤醒会话双落）", async () => {
    const r = renderVoice();
    await act(async () => {
      fireWakeHotkey?.();
    });
    await waitFor(() => expect(r.current.duplexActive).toBe(true));
    act(() => {
      capturedOnTranscript.current?.("第一句正常");
    });
    await waitFor(() => expect(sendStewardAsk).toHaveBeenCalledTimes(1));
    // 热键关麦（会话收口：duplex 落）
    await act(async () => {
      fireWakeHotkey?.();
    });
    await waitFor(() => expect(r.current.duplexActive).toBe(false));
    // 关麦后迟到转写到达（状态面漏网路径的兜底面）——不得发起幽灵 ask
    act(() => {
      capturedOnTranscript.current?.("关掉后才转写出来的话");
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(sendStewardAsk).toHaveBeenCalledTimes(1); // 修复前（红）：2 次
  });
});
