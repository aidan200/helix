// @vitest-environment jsdom
/**
 * useKgWriteFlight 写面单飞 hook 单测（M9 #2.31：五写面在途收敛单一带类型
 * flight——发起/回执/错误/超时一处收口）。
 *
 * 钉住语义：
 * - 一次一个在途（并发发起去重，错误归因零张冠李戴的结构前提）；
 * - send false（未连接）立即清位 + onSendFail；
 * - settle(kind) 仅匹配当前 flight 才消费（非本视图发起回执不清位）；
 * - notifyError 归因当前在途 kind（零顺序链）；
 * - 超时兜底清位 + onTimeout（结果帧丢失按钮不永久禁用）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useKgWriteFlight, KG_WRITE_FLIGHT_TIMEOUT_MS, type KgWriteFlightHandlers } from "./use-kg-write-flight";

function setup() {
  const handlers: KgWriteFlightHandlers = {
    onSendFail: vi.fn(),
    onConnError: vi.fn(),
    onTimeout: vi.fn(),
  };
  const view = renderHook(() => useKgWriteFlight(handlers));
  return { handlers, view };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useKgWriteFlight（M9 #2.31 写面单飞统一 hook）", () => {
  it("launch 发起 → flight 置位；send true 不清位", () => {
    const { view } = setup();
    expect(view.result.current.flight).toBeNull();
    act(() => view.result.current.launch("review", () => true));
    expect(view.result.current.flight).toBe("review");
  });

  it("一次一个在途：在途时第二个 launch 静默忽略（send 不调用）", () => {
    const { view } = setup();
    const secondSend = vi.fn(() => true);
    act(() => view.result.current.launch("review", () => true));
    act(() => view.result.current.launch("codeReview", secondSend));
    expect(view.result.current.flight).toBe("review");
    expect(secondSend).not.toHaveBeenCalled();
  });

  it("send false → 立即清位 + onSendFail（未连接发起即失败交代）", () => {
    const { handlers, view } = setup();
    act(() => view.result.current.launch("purge", () => false));
    expect(view.result.current.flight).toBeNull();
    expect(handlers.onSendFail).toHaveBeenCalledTimes(1);
    // 清位后可再发起
    act(() => view.result.current.launch("purge", () => true));
    expect(view.result.current.flight).toBe("purge");
  });

  it("settle 仅匹配当前 flight 才消费：异 kind 回执不清位（非本视图发起）", () => {
    const { view } = setup();
    act(() => view.result.current.launch("review", () => true));
    let consumed = false;
    act(() => {
      consumed = view.result.current.settle("codeReview");
    });
    expect(consumed).toBe(false);
    expect(view.result.current.flight).toBe("review"); // 在途位不被张冠李戴清掉
    act(() => {
      consumed = view.result.current.settle("review");
    });
    expect(consumed).toBe(true);
    expect(view.result.current.flight).toBeNull();
  });

  it("notifyError 归因当前在途 kind（零顺序链）；非在途不消费", () => {
    const { handlers, view } = setup();
    act(() => view.result.current.notifyError("boom")); // 空闲：不消费
    expect(handlers.onConnError).not.toHaveBeenCalled();
    act(() => view.result.current.launch("codeReview", () => true));
    act(() => view.result.current.notifyError("daemon 拒绝"));
    expect(handlers.onConnError).toHaveBeenCalledWith("codeReview", "daemon 拒绝");
    expect(view.result.current.flight).toBeNull();
  });

  it("超时兜底：FLIGHT_TIMEOUT_MS 无回执自动清位 + onTimeout", () => {
    vi.useFakeTimers();
    const { handlers, view } = setup();
    act(() => view.result.current.launch("create", () => true));
    expect(view.result.current.flight).toBe("create");
    act(() => {
      vi.advanceTimersByTime(KG_WRITE_FLIGHT_TIMEOUT_MS + 1);
    });
    expect(view.result.current.flight).toBeNull();
    expect(handlers.onTimeout).toHaveBeenCalledWith("create");
  });

  it("settle/notifyError 后超时不再触发（定时器随清位取消）", () => {
    vi.useFakeTimers();
    const { handlers, view } = setup();
    act(() => view.result.current.launch("review", () => true));
    act(() => {
      view.result.current.settle("review");
    });
    act(() => {
      vi.advanceTimersByTime(KG_WRITE_FLIGHT_TIMEOUT_MS + 1);
    });
    expect(handlers.onTimeout).not.toHaveBeenCalled();
  });
});
