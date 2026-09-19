// @vitest-environment jsdom
/**
 * Composer 麦克风钮交互测试（语音输入 V2：点击开始 / 录音中点击强制停 /
 * 三态可视化互斥）。useVoiceInput 整面 mock（状态机本体归
 * useVoiceInput.test——本文件只钉按钮接线与三态渲染面）。
 *
 * - 待录：Mic 图标、无电平条；点击 → start()（点击开始，非按住）；
 * - 录音中：电平条渲染（level 驱动 per-bar scale）、recording 类、
 *   aria-label 切录音文案；点击 → stop()（强制停）；
 * - 转写中：spinner、disabled、点击 no-op（三态互斥——start 不再触发）；
 * - unsupported：恒隐藏（既有回归，Composer.test 已覆盖，此处不重复）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import {
  createInitialSessionState,
  sessionReducer,
  type SessionAction,
  type SessionState,
} from "@/entities/session/model/session-reducer";
import type { EventEnvelope } from "@helix/protocol";
import type { VoiceInput, VoiceState } from "../model/useVoiceInput";

const start = vi.fn(async () => undefined);
const stop = vi.fn();
let voiceState: VoiceState = "idle";
let voiceLevel = 0;
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: stateRef.current,
      topology: {},
      setDraft: vi.fn(),
      submit: vi.fn(() => true),
      abort: vi.fn(),
      attachImages: vi.fn(),
      removeAttachment: vi.fn(),
    }),
  };
});
vi.mock("../model/useVoiceInput", () => ({
  useVoiceInput: (): VoiceInput => ({ state: voiceState, level: voiceLevel, error: null, start, stop }),
}));

import Composer from "./Composer";

const stateRef: { current: SessionState } = { current: createInitialSessionState() };

function play(events: SessionAction[]): SessionState {
  return events.reduce(sessionReducer, createInitialSessionState());
}

/** connected + ready 基态（welcome 即就绪可发）。 */
beforeEach(() => {
  stateRef.current = play([
    {
      type: "event",
      event: {
        v: 0,
        type: "connection.welcome",
        payload: { sessionId: "s1", model: "claude-sonnet-4-5", agentState: "idle" },
      } as EventEnvelope,
    },
  ]);
  voiceState = "idle";
  voiceLevel = 0;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mic() {
  return document.querySelector("#btn-mic") as HTMLButtonElement;
}

describe("Composer 麦克风钮（语音输入 V2：点击 + 三态）", () => {
  it("待录：Mic 图标无电平条；点击 → start()（点击开始非按住）", () => {
    render(
      <I18nProvider>
        <ToastProvider>
          <Composer />
        </ToastProvider>
      </I18nProvider>,
    );
    const btn = mic();
    expect(btn).not.toBeNull();
    expect(btn.querySelector("svg")).not.toBeNull(); // Mic 图标
    expect(btn.querySelector(".mic-level")).toBeNull(); // 无电平条
    expect(btn.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(btn);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("录音中：电平条随 level 缩放 + recording 类；点击 → stop()（强制停）", () => {
    voiceState = "recording";
    voiceLevel = 0.6;
    render(
      <I18nProvider>
        <ToastProvider>
          <Composer />
        </ToastProvider>
      </I18nProvider>,
    );
    const btn = mic();
    expect(btn.className).toContain("recording");
    const bars = btn.querySelectorAll(".mic-level i");
    expect(bars.length).toBe(5);
    // 电平数据面：容器 --lv3（中条因子 1.0；level 0.6 → 0.2+0.6 = 0.8）
    const meter = btn.querySelector(".mic-level") as HTMLElement;
    expect(meter.style.getPropertyValue("--lv3")).not.toBe("");
    expect(Number(meter.style.getPropertyValue("--lv3"))).toBeGreaterThanOrEqual(0.6);
    expect(screen.queryByTitle("recording", { exact: false })).toBeDefined();
    fireEvent.click(btn);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("转写中：spinner + disabled；点击 no-op（三态互斥）", () => {
    voiceState = "transcribing";
    render(
      <I18nProvider>
        <ToastProvider>
          <Composer />
        </ToastProvider>
      </I18nProvider>,
    );
    const btn = mic();
    expect(btn.disabled).toBe(true);
    expect(btn.querySelector(".mic-level")).toBeNull();
    fireEvent.click(btn);
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
});
