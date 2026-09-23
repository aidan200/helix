// @vitest-environment jsdom
/**
 * StewardPanel 语音 UI 下线回归测试（B2 全局语音批，D4：面板语音区随
 * useStewardVoice 挂载点迁移整体退役——设计稿 §2 职责重划 / §3.5）。
 *
 * 钉终态（B2 后面板 = 纯记录面）：
 * - 语音区组件零渲染：mic 钮/波形/相位文案/interim 浮字/双模切换排/
 *   静音钮/耳机提示全退役；
 * - 文本输入面常驻（textarea——Enter 换行 / alt+enter 发送归
 *   StewardPanel.test 键位用例）；
 * - Esc 回归纯关面板（B4 让位逻辑随语音 UI 退役——无 wake 态判据）；
 * - ask 载荷无语音分支（纯文本单路）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";

const sendStewardAsk = vi.fn(() => true);
const sendStewardConfirm = vi.fn(() => true);
const sendStewardSubscribe = vi.fn(() => true);
const sendStewardUnsubscribe = vi.fn(() => true);
const sendStewardGetConfig = vi.fn(() => true);
const sendStewardHistory = vi.fn(() => true);
const stewardListeners = new Set<(e: EventEnvelope) => void>();
const subscribeStewardFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  stewardListeners.add(cb);
  return () => {
    stewardListeners.delete(cb);
  };
});

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { active: { conn: "connected" } },
    sendStewardAsk,
    sendStewardConfirm,
    sendStewardSubscribe,
    sendStewardUnsubscribe,
    sendStewardGetConfig,
    sendStewardHistory,
    subscribeStewardFrames,
  }),
}));

import StewardPanel from "./StewardPanel";

localStorage.setItem("helix-lang", "zh-CN");

function renderPanel(opts?: { readonly onClose?: () => void; readonly active?: boolean }) {
  return render(
    <I18nProvider>
      <StewardPanel onClose={opts?.onClose ?? (() => undefined)} active={opts?.active} />
    </I18nProvider>,
  );
}

function emitSteward(e: EventEnvelope): void {
  for (const l of stewardListeners) l(e);
}

describe("StewardPanel 语音 UI 下线回归（B2/D4：纯记录面）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stewardListeners.clear();
    localStorage.setItem("helix-lang", "zh-CN");
    localStorage.removeItem("helix.steward.headsetHintSeen");
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("语音区组件零渲染：mic/波形/相位文案/interim/双模排/静音钮/耳机提示全退役", async () => {
    renderPanel();
    act(() => {
      emitSteward({ type: "steward.config.result", payload: { enabled: true, model: "x/y" } } as EventEnvelope);
    });
    await waitFor(() => expect(screen.getByTestId("steward-input")).toBeTruthy());
    expect(screen.queryByTestId("steward-mic")).toBeNull();
    expect(screen.queryByTestId("steward-voice")).toBeNull();
    expect(screen.queryByTestId("steward-voice-phase")).toBeNull();
    expect(screen.queryByTestId("steward-interim")).toBeNull();
    expect(screen.queryByTestId("steward-mode")).toBeNull();
    expect(screen.queryByTestId("steward-mode-voice")).toBeNull();
    expect(screen.queryByTestId("steward-mode-text")).toBeNull();
    expect(screen.queryByTestId("steward-mute")).toBeNull();
    expect(screen.queryByTestId("steward-stream-degraded")).toBeNull();
    expect(screen.queryByTestId("steward-headset-hint")).toBeNull();
  });

  it("文本输入面常驻（无语音/文本双模切换——输入框直接在场）", async () => {
    renderPanel();
    act(() => {
      emitSteward({ type: "steward.config.result", payload: { enabled: true, model: "x/y" } } as EventEnvelope);
    });
    const input = await waitFor(() => screen.getByTestId("steward-input"));
    expect(input.tagName).toBe("TEXTAREA"); // textarea（Enter 换行载体）
    expect(screen.getByTestId("steward-send")).toBeTruthy();
  });

  it("Esc 回归纯关面板（B4 唤醒让位逻辑随语音 UI 退役）", () => {
    const onClose = vi.fn();
    renderPanel({ onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1); // 无 wake 态判据——总是关面板
  });

  it("active=false（Dock 隐藏期）零全局 Esc 监听（A1 语义保留）", () => {
    const onClose = vi.fn();
    renderPanel({ onClose, active: false });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ask 载荷纯文本单路：发送路径无语音分支（useSteward 单点）", async () => {
    renderPanel();
    act(() => {
      emitSteward({ type: "steward.config.result", payload: { enabled: true, model: "x/y" } } as EventEnvelope);
    });
    await waitFor(() => expect(screen.getByTestId("steward-input")).toBeTruthy());
    fireEvent.change(screen.getByTestId("steward-input"), { target: { value: "文本提问" } });
    fireEvent.keyDown(screen.getByTestId("steward-input"), { key: "Enter", altKey: true });
    expect(sendStewardAsk).toHaveBeenCalledTimes(1);
    expect(sendStewardAsk).toHaveBeenCalledWith("文本提问");
  });
});
