// @vitest-environment jsdom
/**
 * useStewardNavigate 测试（M0 表面协议地基批翻新：消费面切 surface.action
 * 新帧——D8 navigate 收编）：surface.action {verb:"navigate"} 帧 → toast
 * 「已投递到会话 X · [去看看]」——**点按钮才切页**（不强切，G5——行为
 * 断言与 B1 版全等）；toast 呈现即回执行回执（D7-1 seq 对账）；旧
 * steward.navigate 帧（兼容期双发）**零消费零 toast**（新 shell 只认新帧
 * ——双发不双弹）；载荷防御（verb 不符/args.sessionId 非法）零动作。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, act, screen, fireEvent } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";

const surfaceListeners = new Set<(e: EventEnvelope) => void>();
const subscribeSurfaceFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  surfaceListeners.add(cb);
  return () => {
    surfaceListeners.delete(cb);
  };
});
const receipts: { seq: number; ok: boolean; detail?: string }[] = [];
const sendSurfaceActionResult = vi.fn((seq: number, ok: boolean, detail?: string) => {
  receipts.push({ seq, ok, ...(detail !== undefined ? { detail } : {}) });
  return true;
});
const listRows = [{ sessionId: "sess-1", title: "重构调度器", lastActivityAt: 1, runState: "idle", loaded: true }];
const topologyMock = vi.fn(() => ({ list: listRows }));
function emitSurface(e: EventEnvelope): void {
  for (const l of surfaceListeners) l(e);
}

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    subscribeSurfaceFrames,
    sendSurfaceActionResult,
    get topology() {
      return topologyMock();
    },
  }),
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

function actionFrame(overrides: Record<string, unknown> = {}): EventEnvelope {
  return {
    v: "0.14",
    sessionId: "__system__",
    channel: "surface",
    type: "surface.action",
    payload: { verb: "navigate", args: { sessionId: "sess-1" }, risk: "write", seq: 3, origin: "steward", ...overrides },
  } as unknown as EventEnvelope;
}

function frame(type: string, payload: unknown): EventEnvelope {
  return { v: "0.14", sessionId: "__system__", channel: "steward", type, payload } as EventEnvelope;
}

describe("useStewardNavigate（M0：surface.action 消费 + 回执 + 旧帧零消费）", () => {
  afterEach(() => {
    cleanup();
    surfaceListeners.clear();
    receipts.length = 0;
    vi.clearAllMocks();
  });

  it("surface.action navigate 帧 → toast 携会话标题 + [去看看]；不自动回调（不强切）+ 呈现即回执", () => {
    const onNavigate = vi.fn();
    renderNavigate(onNavigate);
    act(() => {
      emitSurface(actionFrame());
    });
    // toast 出现且带会话标题（session.list 元数据查表）
    const zone = document.querySelector(".toast-zone");
    expect(zone?.textContent ?? "").toContain("重构调度器");
    const action = screen.getByTestId("toast-action");
    expect(action.textContent ?? "").toMatch(/去看看|View/);
    // 未点按钮：零切页回调（G5）
    expect(onNavigate).not.toHaveBeenCalled();
    // D7-1：toast 呈现即回执行回执（seq 对账；点按是用户后续决策，不在回执内）
    expect(receipts).toEqual([{ seq: 3, ok: true, detail: "presented" }]);
    // 点按钮 → onNavigate(sessionId)（与侧栏点击同路径）
    fireEvent.click(action);
    expect(onNavigate).toHaveBeenCalledWith("sess-1");
  });

  it("未知会话（list 未命中）→ toast 回退短 id，不猜义", () => {
    const onNavigate = vi.fn();
    renderNavigate(onNavigate);
    act(() => {
      emitSurface(actionFrame({ args: { sessionId: "unheard-session-id-long" } }));
    });
    const zone = document.querySelector(".toast-zone");
    expect(zone?.textContent ?? "").toContain("unheard-sess"); // 短 id 回退（slice(0,12)）
    fireEvent.click(screen.getByTestId("toast-action"));
    expect(onNavigate).toHaveBeenCalledWith("unheard-session-id-long");
  });

  it("旧帧兼容零消费：steward.navigate 双发到达不产生第二 toast（新 shell 只认 surface.action）", () => {
    const onNavigate = vi.fn();
    renderNavigate(onNavigate);
    act(() => {
      emitSurface(actionFrame());
      emitSurface(frame("steward.navigate", { sessionId: "sess-1" }));
    });
    const zone = document.querySelector(".toast-zone");
    expect(zone?.textContent ?? "").toContain("重构调度器");
    // 单 toast（双发不双弹）
    expect(document.querySelectorAll(".toast-zone [data-testid='toast-action']").length).toBe(1);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("非 navigate 动词（携合法 seq）→ 零 toast 零回调 + 失败回执（拒签必应答——事故热修批②）", () => {
    const onNavigate = vi.fn();
    renderNavigate(onNavigate);
    act(() => {
      emitSurface(actionFrame({ verb: "click", args: { selector: "#x" }, seq: 7 }));
      emitSurface(actionFrame({ verb: "scroll", seq: 8 }));
      emitSurface(frame("steward.feed", { kind: "agent.completed", agentId: "a-1", text: "x", seq: 1 }));
    });
    expect(document.querySelector(".toast-zone")?.textContent ?? "").toBe("");
    expect(onNavigate).not.toHaveBeenCalled();
    expect(receipts).toEqual([
      { seq: 7, ok: false, detail: "unsupported-verb:click" },
      { seq: 8, ok: false, detail: "unsupported-verb:scroll" },
    ]);
  });

  it("载荷防御（事故热修批②）：args.sessionId 非法携合法 seq → 零 toast 零回调 + invalid-args 失败回执（daemon 不再 60s 挂死）", () => {
    const onNavigate = vi.fn();
    renderNavigate(onNavigate);
    act(() => {
      emitSurface(actionFrame({ args: {}, seq: 11 }));
      emitSurface(actionFrame({ args: { sessionId: 42 }, seq: 12 }));
      emitSurface(actionFrame({ args: { sessionId: "" }, seq: 13 }));
      emitSurface(actionFrame({ args: null, seq: 14 }));
      // 事故实录形态：模型发明 url 参数（缺 sessionId）
      emitSurface(actionFrame({ args: { url: "helix://session/5b736b22" }, seq: 15 }));
      emitSurface({ ...actionFrame(), payload: { verb: "navigate" } } as unknown as EventEnvelope);
    });
    expect(document.querySelector(".toast-zone")?.textContent ?? "").toBe("");
    expect(onNavigate).not.toHaveBeenCalled();
    expect(receipts).toEqual([
      { seq: 11, ok: false, detail: "invalid-args" },
      { seq: 12, ok: false, detail: "invalid-args" },
      { seq: 13, ok: false, detail: "invalid-args" },
      { seq: 14, ok: false, detail: "invalid-args" },
      { seq: 15, ok: false, detail: "invalid-args" },
    ]);
  });

  it("seq 非法：导航意图仍 toast（sessionId 有效即用户价值面）；零回执（D7-1 对账锚缺失）", () => {
    const onNavigate = vi.fn();
    renderNavigate(onNavigate);
    act(() => {
      emitSurface(actionFrame({ seq: "x" }));
    });
    const zone = document.querySelector(".toast-zone");
    expect(zone?.textContent ?? "").toContain("重构调度器");
    expect(receipts).toEqual([]);
    fireEvent.click(screen.getByTestId("toast-action"));
    expect(onNavigate).toHaveBeenCalledWith("sess-1");
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
    expect(subscribeSurfaceFrames).toHaveBeenCalledTimes(1); // 订阅面不随回调重挂
    act(() => {
      emitSurface(actionFrame());
    });
    fireEvent.click(screen.getByTestId("toast-action"));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("sess-1");
  });
});
