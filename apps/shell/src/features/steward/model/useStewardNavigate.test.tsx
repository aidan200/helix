// @vitest-environment jsdom
/**
 * useStewardNavigate 测试（管家驾驶舱批）：steward.navigate 帧 → onNavigate
 * 回调（sessionId 解析）；非 navigate 帧零回调；载荷异常（sessionId 缺失/
 * 非法）零回调（防御面）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, act } from "@testing-library/react";
import type { EventEnvelope } from "@helix/protocol";

const stewardListeners = new Set<(e: EventEnvelope) => void>();
const subscribeStewardFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  stewardListeners.add(cb);
  return () => {
    stewardListeners.delete(cb);
  };
});
function emitSteward(e: EventEnvelope): void {
  for (const l of stewardListeners) l(e);
}

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({ subscribeStewardFrames }),
}));

import { useStewardNavigate } from "./useStewardNavigate";

function Harness({ onNavigate }: { onNavigate: (sessionId: string) => void }) {
  useStewardNavigate(onNavigate);
  return <div data-testid="harness" />;
}

function frame(type: string, payload: unknown): EventEnvelope {
  return { v: "0.14", sessionId: "__system__", channel: "steward", type, payload } as EventEnvelope;
}

describe("useStewardNavigate（驾驶舱：navigate 帧消费）", () => {
  afterEach(() => {
    cleanup();
    stewardListeners.clear();
    vi.clearAllMocks();
  });

  it("steward.navigate 帧 → onNavigate(sessionId)", async () => {
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} />);
    act(() => {
      emitSteward(frame("steward.navigate", { sessionId: "sess-1" }));
    });
    expect(onNavigate).toHaveBeenCalledWith("sess-1");
  });

  it("非 navigate 帧（feed/ask.result）零回调", () => {
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} />);
    act(() => {
      emitSteward(frame("steward.feed", { kind: "agent.completed", agentId: "a-1", text: "x", seq: 1 }));
      emitSteward(frame("steward.ask.result", { status: "answer", text: "hi" }));
    });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("载荷防御：sessionId 缺失/非字符串/空串 → 零回调", () => {
    const onNavigate = vi.fn();
    render(<Harness onNavigate={onNavigate} />);
    act(() => {
      emitSteward(frame("steward.navigate", {}));
      emitSteward(frame("steward.navigate", { sessionId: 42 }));
      emitSteward(frame("steward.navigate", { sessionId: "" }));
    });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("回调引用漂移不重订阅（ref 定格——最新回调被调）", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Harness onNavigate={first} />);
    rerender(<Harness onNavigate={second} />);
    expect(subscribeStewardFrames).toHaveBeenCalledTimes(1); // 订阅面不随回调重挂
    act(() => {
      emitSteward(frame("steward.navigate", { sessionId: "s" }));
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("s");
  });
});
