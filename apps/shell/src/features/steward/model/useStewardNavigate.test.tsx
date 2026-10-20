// @vitest-environment jsdom
/**
 * useStewardNavigate 测试（navigate 动作语义修正批：动作通道 = 已授权动作
 * 直接执行）。surface.action {verb:"navigate"} 帧 → **直接 onNavigate 切页**
 * （与侧栏点击同一路径）→ 真执行后回执行回执 ok:true("navigated")——
 * 不再走 toast+[去看看] 二次授权（2026-10-07 用户实测反馈：确认卡点了、
 * 管家说已切换、页面纹丝不动——「呈现即回执」在 M2 语义下是谎报）。
 *
 * 语义分界（本批落账面）：动作通道（surface.action，已过确认闸）= 授权即
 * 执行；播报通道（feed/notify/toast）= 永不附带执行（D12-⑤ 不变——
 * 播报类 toast 的 [去看看] 形态归播报族，不归本面）。
 *
 * 旧 steward.navigate 帧（兼容期双发）零消费；载荷防御拒签必回执
 * （事故热修批②）；seq 非法帧仍执行导航（用户价值面）零回执（无对账锚）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, act } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
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

function emitSurface(e: EventEnvelope): void {
  for (const l of surfaceListeners) l(e);
}

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    subscribeSurfaceFrames,
    sendSurfaceActionResult,
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
      <Harness onNavigate={onNavigate} />
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
  return { v: "0.14", sessionId: "__system__", channel: "steward", type, payload } as unknown as EventEnvelope;
}

describe("useStewardNavigate（navigate 动作语义修正：授权即执行 + 真执行回执）", () => {
  afterEach(() => {
    cleanup();
    surfaceListeners.clear();
    receipts.length = 0;
    vi.clearAllMocks();
  });

  it("surface.action navigate 帧 → 直接 onNavigate 切页（零 toast 二次授权）+ 真执行后回执 navigated", () => {
    const onNavigate = vi.fn();
    renderNavigate(onNavigate);
    act(() => {
      emitSurface(actionFrame());
    });
    // 授权即执行：帧到达 = 确认闸已过，直接切页（与侧栏点击同路径）
    expect(onNavigate).toHaveBeenCalledWith("sess-1");
    // D7-1 回执在真执行后发——detail 如实记 navigated（不再谎报 presented）
    expect(receipts).toEqual([{ seq: 3, ok: true, detail: "navigated" }]);
    // 零 toast（二次授权形态退役——右上角不再弹「去看看」）
    expect(document.querySelector(".toast-zone")?.textContent ?? "").toBe("");
  });

  it("未在 session.list 的会话 → 仍直接执行（查表标题逻辑随 toast 退役；不猜义不做存在性拦截）", () => {
    const onNavigate = vi.fn();
    renderNavigate(onNavigate);
    act(() => {
      emitSurface(actionFrame({ args: { sessionId: "unheard-session-id-long" }, seq: 9 }));
    });
    expect(onNavigate).toHaveBeenCalledWith("unheard-session-id-long");
    expect(receipts).toEqual([{ seq: 9, ok: true, detail: "navigated" }]);
  });

  it("旧帧兼容零消费：steward.navigate 双发到达不产生第二次切页（新 shell 只认 surface.action）", () => {
    const onNavigate = vi.fn();
    renderNavigate(onNavigate);
    act(() => {
      emitSurface(actionFrame());
      emitSurface(frame("steward.navigate", { sessionId: "sess-1" }));
    });
    // 单次执行（双发不双切）
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("sess-1");
    expect(receipts).toEqual([{ seq: 3, ok: true, detail: "navigated" }]);
  });

  it("非 navigate 动词（携合法 seq）→ 零执行 + 失败回执（拒签必应答——事故热修批②）", () => {
    const onNavigate = vi.fn();
    renderNavigate(onNavigate);
    act(() => {
      emitSurface(actionFrame({ verb: "click", args: { selector: "#x" }, seq: 7 }));
      emitSurface(actionFrame({ verb: "scroll", seq: 8 }));
      emitSurface(frame("steward.feed", { kind: "agent.completed", agentId: "a-1", text: "x", seq: 1 }));
    });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(receipts).toEqual([
      { seq: 7, ok: false, detail: "unsupported-verb:click" },
      { seq: 8, ok: false, detail: "unsupported-verb:scroll" },
    ]);
  });

  it("载荷防御（事故热修批②）：args.sessionId 非法携合法 seq → 零执行 + invalid-args 失败回执（daemon 不再 60s 挂死）", () => {
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
    expect(onNavigate).not.toHaveBeenCalled();
    expect(receipts).toEqual([
      { seq: 11, ok: false, detail: "invalid-args" },
      { seq: 12, ok: false, detail: "invalid-args" },
      { seq: 13, ok: false, detail: "invalid-args" },
      { seq: 14, ok: false, detail: "invalid-args" },
      { seq: 15, ok: false, detail: "invalid-args" },
    ]);
  });

  it("载荷本体非法（payload=null/undefined）→ 零动作零回执且不抛（订阅回调不再 TypeError）", () => {
    const onNavigate = vi.fn();
    renderNavigate(onNavigate);
    expect(() => {
      act(() => {
        emitSurface({ v: "0.14", sessionId: "__system__", channel: "surface", type: "surface.action", payload: null } as unknown as EventEnvelope);
        emitSurface({ v: "0.14", sessionId: "__system__", channel: "surface", type: "surface.action" } as unknown as EventEnvelope);
      });
    }).not.toThrow();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(receipts).toEqual([]); // 无 seq 锚：零回执（与 seq 非法帧同规）
  });

  it("seq 非法：导航意图仍执行（sessionId 有效即用户价值面）；零回执（D7-1 对账锚缺失）", () => {
    const onNavigate = vi.fn();
    renderNavigate(onNavigate);
    act(() => {
      emitSurface(actionFrame({ seq: "x" }));
    });
    expect(onNavigate).toHaveBeenCalledWith("sess-1");
    expect(receipts).toEqual([]);
  });

  it("回调引用漂移不重订阅（ref 定格——帧到达时执行最新回调）", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderNavigate(first);
    rerender(
      <I18nProvider>
        <Harness onNavigate={second} />
      </I18nProvider>,
    );
    expect(subscribeSurfaceFrames).toHaveBeenCalledTimes(1); // 订阅面不随回调重挂
    act(() => {
      emitSurface(actionFrame());
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("sess-1");
  });
});
