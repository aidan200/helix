// @vitest-environment jsdom
/**
 * useStewardNavigate 测试（B1 建议导航批，设计稿 §3.7）：steward.navigate 帧
 * → toast「已投递到会话 X · [去看看]」——**点按钮才切页**（不强切，G5）；
 * toast 文案携带会话标题（session.list 元数据）；非 navigate 帧零 toast；
 * 载荷异常（sessionId 缺失/非法）零 toast（防御面）；回调引用漂移不重订阅。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, act, screen, fireEvent } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";

const stewardListeners = new Set<(e: EventEnvelope) => void>();
const subscribeStewardFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  stewardListeners.add(cb);
  return () => {
    stewardListeners.delete(cb);
  };
});
const listRows = [{ sessionId: "sess-1", title: "重构调度器", lastActivityAt: 1, runState: "idle", loaded: true }];
const topologyMock = vi.fn(() => ({ list: listRows }));
function emitSteward(e: EventEnvelope): void {
  for (const l of stewardListeners) l(e);
}

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({ subscribeStewardFrames, get topology() { return topologyMock(); } }),
}));

import { useStewardNavigate } from "./useStewardNavigate";

function Harness({ onNavigate }: { onNavigate: (sessionId: string) => void }) {
  useStewardNavigate(onNavigate);
  return <div data-testid="harness" />;
}

function renderNavigate(onNavigate: (sessionId: string) => void) {
  return render(
    <I18nProvider>
      <ToastProvider>
        <Harness onNavigate={onNavigate} />
      </ToastProvider>
    </I18nProvider>,
  );
}

function frame(type: string, payload: unknown): EventEnvelope {
  return { v: "0.14", sessionId: "__system__", channel: "steward", type, payload } as EventEnvelope;
}

describe("useStewardNavigate（B1 建议导航：toast 通知不强切）", () => {
  afterEach(() => {
    cleanup();
    stewardListeners.clear();
    vi.clearAllMocks();
  });

  it("steward.navigate 帧 → toast 携会话标题 + [去看看] 按钮；**不自动回调**（不强切）", () => {
    const onNavigate = vi.fn();
    renderNavigate(onNavigate);
    act(() => {
      emitSteward(frame("steward.navigate", { sessionId: "sess-1" }));
    });
    // toast 出现且带会话标题（session.list 元数据查表）
    const zone = document.querySelector(".toast-zone");
    expect(zone?.textContent ?? "").toContain("重构调度器");
    const action = screen.getByTestId("toast-action");
    expect(action.textContent ?? "").toMatch(/去看看|View/);
    // 未点按钮：零切页回调（G5）
    expect(onNavigate).not.toHaveBeenCalled();
    // 点按钮 → onNavigate(sessionId)（与侧栏点击同路径）
    fireEvent.click(action);
    expect(onNavigate).toHaveBeenCalledWith("sess-1");
  });

  it("未知会话（list 未命中）→ toast 回退短 id，不猜义", () => {
    const onNavigate = vi.fn();
    renderNavigate(onNavigate);
    act(() => {
      emitSteward(frame("steward.navigate", { sessionId: "unheard-session-id-long" }));
    });
    const zone = document.querySelector(".toast-zone");
    expect(zone?.textContent ?? "").toContain("unheard-sess"); // 短 id 回退（slice(0,12)）
    fireEvent.click(screen.getByTestId("toast-action"));
    expect(onNavigate).toHaveBeenCalledWith("unheard-session-id-long");
  });

  it("非 navigate 帧（feed/ask.result）零 toast 零回调", () => {
    const onNavigate = vi.fn();
    renderNavigate(onNavigate);
    act(() => {
      emitSteward(frame("steward.feed", { kind: "agent.completed", agentId: "a-1", text: "x", seq: 1 }));
      emitSteward(frame("steward.ask.result", { status: "answer", text: "hi" }));
    });
    expect(document.querySelector(".toast-zone")?.textContent ?? "").toBe("");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("载荷防御：sessionId 缺失/非字符串/空串 → 零 toast 零回调", () => {
    const onNavigate = vi.fn();
    renderNavigate(onNavigate);
    act(() => {
      emitSteward(frame("steward.navigate", {}));
      emitSteward(frame("steward.navigate", { sessionId: 42 }));
      emitSteward(frame("steward.navigate", { sessionId: "" }));
    });
    expect(document.querySelector(".toast-zone")?.textContent ?? "").toBe("");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("回调引用漂移不重订阅（ref 定格——按钮触发最新回调）", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderNavigate(first);
    rerender(
      <I18nProvider>
        <ToastProvider>
          <Harness onNavigate={second} />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(subscribeStewardFrames).toHaveBeenCalledTimes(1); // 订阅面不随回调重挂
    act(() => {
      emitSteward(frame("steward.navigate", { sessionId: "sess-1" }));
    });
    fireEvent.click(screen.getByTestId("toast-action"));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("sess-1");
  });
});
