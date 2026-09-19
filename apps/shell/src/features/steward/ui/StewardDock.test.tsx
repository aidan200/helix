// @vitest-environment jsdom
/**
 * StewardDock 测试（管家全局化批：rail 右缘全局弹层面板壳）。
 *
 * - open=true → dock 壳 + 内部 StewardPanel 渲染；open=false → 零渲染；
 * - 点外关闭（pointerdown 落 exempt 选择器外）：dock 内容与 rail 入口钮
 *   免误关（入口钮开合归自身 toggle——pointerdown 关闭 + click toggle 会
 *   抵消成「关了又开」，见 useDismissOnOutside 契约）；
 * - Esc 关闭（面板自有窗口级监听与 dismiss hook 双路径幂等）。
 *
 * mock 口径沿 StewardPanel.test.tsx（SessionContext steward 命令面）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope } from "@helix/protocol";

const sendStewardGetConfig = vi.fn(() => true);
const sendStewardSubscribe = vi.fn(() => true);
const sendStewardUnsubscribe = vi.fn(() => true);
const subscribeStewardFrames = vi.fn(() => () => {});

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { active: { conn: "connected" } },
    sendStewardGetConfig,
    sendStewardSubscribe,
    sendStewardUnsubscribe,
    subscribeStewardFrames,
  }),
}));

import StewardDock from "./StewardDock";

function ui(open: boolean, onClose = vi.fn()) {
  render(
    <I18nProvider>
      <StewardDock open={open} onClose={onClose} />
    </I18nProvider>,
  );
  return onClose;
}

// jsdom navigator.language 默认 en-US：钉 zh-CN（AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

describe("StewardDock（管家全局弹层壳）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("open=true → dock 壳 + 内部 StewardPanel；open=false → 零渲染", () => {
    ui(true);
    expect(document.querySelector('[data-testid="steward-dock"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="steward-panel"]')).not.toBeNull();
    cleanup();
    ui(false);
    expect(document.querySelector('[data-testid="steward-dock"]')).toBeNull();
    expect(document.querySelector('[data-testid="steward-panel"]')).toBeNull();
  });

  it("点外关闭：dock 外 pointerdown → onClose；dock 内与 rail 入口钮免误关", () => {
    const onClose = ui(true);
    // dock 内容内 pointerdown → 不关
    fireEvent.pointerDown(document.querySelector('[data-testid="steward-panel"]')!);
    expect(onClose).not.toHaveBeenCalled();
    // rail 入口钮（exempt：toggle 自持开合）→ 不关
    const entry = document.createElement("button");
    entry.className = "rail-steward-btn";
    document.body.appendChild(entry);
    fireEvent.pointerDown(entry);
    expect(onClose).not.toHaveBeenCalled();
    entry.remove();
    // dock 外 pointerdown → 关
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc → onClose（键盘逃逸）", () => {
    const onClose = ui(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("open=false 零监听（卸载态不响应点外/Esc——监听挂载归 open 态）", () => {
    const onClose = ui(false);
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
