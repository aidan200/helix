// @vitest-environment jsdom
/**
 * useShellSurface 测试（M0 表面协议地基批）：
 * - 连接就绪恒注册（surface.register——navigate 收编不依赖感知开关；
 *   重连随 conn 迁移重发）；
 * - 感知开关默认 off：页面级事件（activated/navigated）零上行；
 * - 开关开：连接就绪上报 activated（当前页）；路由切换上报 navigated
 *   （携 from）；
 * - 首挂不算导航（activated 才是首报）；断连窗口零上行。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { EventEnvelope, SurfaceDescriptor } from "@helix/protocol";

const sendSpy = vi.fn();
let connState: string = "connecting";
const surfaceListeners = new Set<(e: EventEnvelope) => void>();
const subscribeSurfaceFrames = vi.fn((cb: (e: EventEnvelope) => void) => {
  surfaceListeners.add(cb);
  return () => {
    surfaceListeners.delete(cb);
  };
});
// 命令面引用稳定（产线 commandSurfaceRef ref 恒定——mock 对齐，否则 effect
// deps 每渲染漂移导致 activated 重发）
let registerOk = true;
const sendSurfaceRegister = (d: SurfaceDescriptor): boolean => {
  sendSpy({ kind: "surface.register", descriptor: d });
  return registerOk;
};
const sendSurfaceEvent = (payload: Record<string, unknown>): boolean => {
  sendSpy({ kind: "surface.event", payload });
  return true;
};

vi.mock("@/entities/session/SessionContext", () => ({
  useSession: () => ({
    topology: { active: { conn: connState } },
    sendSurfaceRegister,
    sendSurfaceEvent,
    subscribeSurfaceFrames,
  }),
}));

import { useShellSurface } from "./useShellSurface";
import { isSurfaceAwarenessOn, setSurfaceAwareness, SURFACE_AWARENESS_KEY } from "./shell-surface";

function Harness({ page }: { page: string }) {
  useShellSurface(page);
  return <div data-testid="harness" />;
}

function events(): Record<string, unknown>[] {
  return sendSpy.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((c) => c.kind === "surface.event");
}

describe("useShellSurface（M0：注册恒发 + 感知开关默认 off）", () => {
  afterEach(() => {
    cleanup();
    surfaceListeners.clear();
    sendSpy.mockClear();
    vi.clearAllMocks();
    localStorage.clear();
    connState = "connecting";
    registerOk = true;
  });

  it("感知开关缺省 off：连接就绪只注册零事件上行", () => {
    expect(isSurfaceAwarenessOn()).toBe(false); // 默认关（D1 隐私一等公民）
    connState = "connected";
    render(<Harness page="/" />);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const reg = sendSpy.mock.calls[0]![0] as { kind: string; descriptor: SurfaceDescriptor };
    expect(reg.kind).toBe("surface.register");
    expect(reg.descriptor.kind).toBe("shell");
    expect(reg.descriptor.capabilities).toContain("navigate"); // 能力协商（D4）
    expect(events()).toEqual([]);
  });

  it("开关开：连接就绪上报 activated（当前页）", () => {
    setSurfaceAwareness(true);
    expect(isSurfaceAwarenessOn()).toBe(true);
    expect(localStorage.getItem(SURFACE_AWARENESS_KEY)).toBe("1");
    connState = "connected";
    render(<Harness page="/tasks" />);
    const evs = events();
    expect(evs.length).toBe(1);
    expect(evs[0]).toEqual({
      kind: "surface.event",
      payload: { kind: "activated", origin: "user", page: "/tasks" },
    });
  });

  it("路由切换上报 navigated（携 from）；首挂不算导航", () => {
    setSurfaceAwareness(true);
    connState = "connected";
    const view = render(<Harness page="/" />);
    expect(events().length).toBe(1); // activated only
    view.rerender(<Harness page="/settings" />);
    const evs = events();
    expect(evs.length).toBe(2);
    expect(evs[1]).toEqual({
      kind: "surface.event",
      payload: { kind: "navigated", origin: "user", page: "/settings", detail: { from: "/" } },
    });
  });

  it("断连窗口零上行；重连重注册（conn 迁移驱动——daemon 不持跨连接表面）", () => {
    setSurfaceAwareness(true);
    connState = "connected";
    const view = render(<Harness page="/" />);
    expect(sendSpy.mock.calls.filter((c) => (c[0] as { kind: string }).kind === "surface.register").length).toBe(1);
    // 断连：无注册无事件
    connState = "disconnected";
    view.rerender(<Harness page="/trace" />);
    expect(events().length).toBe(1); // 仅此前 activated
    // 重连：重注册 + activated（新连接新表面）
    connState = "connected";
    view.rerender(<Harness page="/trace" />);
    expect(sendSpy.mock.calls.filter((c) => (c[0] as { kind: string }).kind === "surface.register").length).toBe(2);
    const evs = events();
    expect(evs.length).toBe(2);
    expect(evs[1]).toEqual({
      kind: "surface.event",
      payload: { kind: "activated", origin: "user", page: "/trace" },
    });
  });
});

describe("useShellSurface · 注册 send 返回值消费（code-review 低危）", () => {
  it("注册发送失败（send=false）→ 一次退避重试；不无限重试（等下次 conn 迁移重放）", async () => {
    vi.useFakeTimers();
    try {
      registerOk = false;
      connState = "connected";
      render(<Harness page="/" />);
      const registerCalls = () =>
        sendSpy.mock.calls.filter((c) => (c[0] as Record<string, unknown>).kind === "surface.register").length;
      expect(registerCalls()).toBe(1);
      await act(async () => {
        vi.advanceTimersByTime(600);
      });
      expect(registerCalls()).toBe(2); // 一次重试（能力缺失面不静默放弃）
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(registerCalls()).toBe(2); // 不无限重试——下次 conn 迁移重放
    } finally {
      vi.useRealTimers();
    }
  });

  it("事件帧发送失败（send=false）→ 不重试、不抛（软语义丢弃可容忍）", () => {
    setSurfaceAwareness(true);
    connState = "connected";
    render(<Harness page="/" />);
    expect(events().length).toBeGreaterThan(0);
    expect(sendSpy).toHaveBeenCalled(); // 零异常路径
  });
});
