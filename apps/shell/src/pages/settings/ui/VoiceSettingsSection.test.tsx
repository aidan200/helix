// @vitest-environment jsdom
/**
 * 欢迎词工坊测试（欢迎词固化批）：
 * - 生成试听：文本进 voice.synthesize（当前音色）→ 回执 ok → 自动试播 +
 *   确认钮亮（draft = 刚才那次合成）；
 * - 确认使用：音频 + 文本固化 localStorage（readWelcomeAudioPref /
 *   readWelcomeTextPref 契约）+ 状态 chip「已固化」；
 * - 恢复默认：清固化（read 回 null）+ chip「未固化」+ 文本清空；
 * - 生成失败（status error / send false）：toast 报错，确认钮不亮；
 * - 空文本拒绝生成。
 *
 * vi.mock SessionContext 先例（GeneralSettingsSection.test.tsx 同构——
 * subscribeVoiceFrames 听众数组 + 可变 mock 位）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";
import { readWelcomeAudioPref, readWelcomeTextPref } from "@/shared/lib/voice-pref";

const sendVoiceSynthesize = vi.fn(() => true);
const sendVoiceSubscribe = vi.fn(() => true);
const sendVoiceUnsubscribe = vi.fn(() => true);
const requestAuthList = vi.fn();
/** voice 帧听众（synthesize.result 回执注入面）。 */
let voiceListeners: ((e: EventEnvelope) => void)[] = [];

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: { agentState: "idle", instances: [], daemonFreshness: null },
      topology: { modelConfig: { auth: {}, authLoaded: true }, list: [] },
      requestAuthList,
      sendVoiceSynthesize,
      sendVoiceSubscribe,
      sendVoiceUnsubscribe,
      subscribeVoiceFrames: (listener: (e: EventEnvelope) => void) => {
        voiceListeners.push(listener);
        return () => {
          voiceListeners = voiceListeners.filter((l) => l !== listener);
        };
      },
    }),
  };
});

/** 合成回执注入（voice.synthesize.result）。 */
function emitSynthResult(status: "ok" | "error", audio?: string, reason?: string): void {
  const envelope = {
    v: 1,
    stream: "voice",
    seq: 0,
    at: "2025-01-01T00:00:00.000Z",
    type: "voice.synthesize.result",
    payload: { status, ...(audio !== undefined ? { audio } : {}), ...(reason !== undefined ? { reason } : {}) },
  } as unknown as EventEnvelope;
  act(() => {
    for (const l of [...voiceListeners]) l(envelope);
  });
}

/** jsdom Audio play stub（自动试播路径——play 恒 resolve）。 */
function stubAudioPlay(): void {
  vi.stubGlobal(
    "Audio",
    vi.fn().mockImplementation(() => ({ volume: 1, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn(), onended: null })),
  );
}

/** 工坊元素查询（设置页惯例：自定义 data-* 属性 + querySelector）。 */
const q = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

async function renderSection(): Promise<void> {
  await act(async () => {
    render(
      <I18nProvider>
        <ToastProvider>
          <VoiceSettingsSection />
        </ToastProvider>
      </I18nProvider>,
    );
  });
}

import VoiceSettingsSection from "./VoiceSettingsSection";

// vi.mock 先于组件模块求值（hoisting 后二者均在 mock 生效后加载）

describe("欢迎词工坊（生成试听 → 确认固化 → 恢复默认）", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("helix-lang", "zh-CN");
    voiceListeners = [];
    vi.clearAllMocks();
    sendVoiceSynthesize.mockReturnValue(true);
    stubAudioPlay();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("生成试听：文本进 synthesize（当前音色）→ 回执 ok 自动试播 + 确认钮亮", async () => {
    await renderSection();
    const input = q<HTMLInputElement>("#tts-welcome-text");
    await act(async () => {
      fireEvent.change(input, { target: { value: "我在听，请讲。" } });
    });
    fireEvent.click(q('[data-tts-welcome-generate]'));
    expect(sendVoiceSynthesize).toHaveBeenCalledWith("我在听，请讲。", expect.objectContaining({ voice: expect.any(String), language: "zh" }));
    expect(q<HTMLButtonElement>("[data-tts-welcome-generate]").disabled).toBe(true); // pending 期
    emitSynthResult("ok", "data:audio/mp4;base64,AAAA");
    await waitFor(() => expect(q<HTMLButtonElement>("[data-tts-welcome-confirm]").disabled).toBe(false));
    expect(q('[data-tts-welcome-fixed]').getAttribute("data-fixed")).toBe("off"); // 未固化（仅 draft）
  });

  it("确认使用：音频+文本固化 localStorage + chip 已固化；read 契约回读一致", async () => {
    await renderSection();
    const input = q<HTMLInputElement>("#tts-welcome-text");
    await act(async () => {
      fireEvent.change(input, { target: { value: "主人好。" } });
    });
    fireEvent.click(q('[data-tts-welcome-generate]'));
    emitSynthResult("ok", "data:audio/mp4;base64,BBBB");
    await waitFor(() => expect(q<HTMLButtonElement>("[data-tts-welcome-confirm]").disabled).toBe(false));
    fireEvent.click(q('[data-tts-welcome-confirm]'));
    expect(readWelcomeAudioPref()).toBe("data:audio/mp4;base64,BBBB");
    expect(readWelcomeTextPref()).toBe("主人好。");
    expect(q('[data-tts-welcome-fixed]').getAttribute("data-fixed")).toBe("on");
    expect(q<HTMLButtonElement>("[data-tts-welcome-reset]").disabled).toBe(false);
  });

  it("恢复默认：清固化（read 回 null）+ chip 未固化 + 文本清空", async () => {
    localStorage.setItem("helix.steward.welcomeAudio", "data:audio/mp4;base64,OLD");
    localStorage.setItem("helix.steward.welcomeText", "旧词");
    await renderSection();
    expect(q('[data-tts-welcome-fixed]').getAttribute("data-fixed")).toBe("on");
    fireEvent.click(q('[data-tts-welcome-reset]'));
    expect(readWelcomeAudioPref()).toBeNull();
    expect(readWelcomeTextPref()).toBeNull();
    expect(q('[data-tts-welcome-fixed]').getAttribute("data-fixed")).toBe("off");
    expect(q<HTMLInputElement>("#tts-welcome-text").value).toBe("");
  });

  it("生成失败（status error）：toast 报错，确认钮保持禁用", async () => {
    await renderSection();
    const input = q<HTMLInputElement>("#tts-welcome-text");
    await act(async () => {
      fireEvent.change(input, { target: { value: "你好。" } });
    });
    fireEvent.click(q('[data-tts-welcome-generate]'));
    emitSynthResult("error", undefined, "quota");
    await waitFor(() => expect(screen.getByText("quota")).toBeTruthy());
    expect(q<HTMLButtonElement>("[data-tts-welcome-confirm]").disabled).toBe(true);
  });

  it("空文本拒绝生成（零 synthesize 调用）", async () => {
    await renderSection();
    fireEvent.click(q('[data-tts-welcome-generate]'));
    expect(sendVoiceSynthesize).not.toHaveBeenCalled();
    expect(screen.getByText("欢迎词文本不能为空")).toBeTruthy();
  });
});
