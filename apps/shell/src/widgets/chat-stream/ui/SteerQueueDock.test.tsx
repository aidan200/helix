// @vitest-environment jsdom
/**
 * SteerQueueDock 队列坞组件测试（drain 落盘语义的 queued 观察面）。
 *
 * 钉四态：
 * - 空队列 → 零渲染；
 * - 非空 → 折叠计数 chip（N 条注入排队中）；
 * - 点击展开 → 清单（正文 + 状态小字：已入队/待确认 + closure/progress 来源 chip）；
 * - 再点击折叠回归。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { createInitialSessionState, type SessionState } from "@/entities/session/model/session-reducer";

const stateRef: { current: SessionState } = { current: createInitialSessionState() };
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return { ...orig, useSession: () => ({ state: stateRef.current }) };
});

import SteerQueueDock from "./SteerQueueDock";

afterEach(cleanup);

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言）
localStorage.setItem("helix-lang", "zh-CN");

function ui(node: React.ReactElement) {
  return render(<I18nProvider>{node}</I18nProvider>);
}

function stateWith(queue: SessionState["steerQueue"]): SessionState {
  return { ...createInitialSessionState(), sessionId: "s1", view: "ready", steerQueue: queue };
}

describe("SteerQueueDock 队列坞", () => {
  it("空队列 → 零渲染", () => {
    stateRef.current = stateWith([]);
    const { container } = ui(<SteerQueueDock />);
    expect(container.querySelector('[data-kind="steer-dock"]')).toBeNull();
  });

  it("非空 → 折叠计数 chip；列表默认不挂载", () => {
    stateRef.current = stateWith([{ id: "e7", text: "排队内容", confirmed: true, ts: 1 }]);
    const { container } = ui(<SteerQueueDock />);
    const toggle = container.querySelector(".sdq-toggle");
    expect(toggle).not.toBeNull();
    expect(toggle!.textContent).toContain("1 条注入排队中");
    expect(container.querySelector(".sdq-list")).toBeNull();
  });

  it("点击展开 → 清单（正文 + 已入队/待确认 + closure 来源 chip）；再点击折叠", () => {
    stateRef.current = stateWith([
      { id: "local:1", text: "刚发的 steer", confirmed: false, ts: 1 },
      { id: "e8", text: "agent-1 closure: done", source: "closure", confirmed: true, ts: 2 },
    ]);
    const { container } = ui(<SteerQueueDock />);
    fireEvent.click(container.querySelector(".sdq-toggle")!);
    const items = container.querySelectorAll(".sdq-item");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("刚发的 steer");
    expect(items[0]!.textContent).toContain("待确认");
    expect(items[1]!.textContent).toContain("CLOSURE");
    expect(items[1]!.textContent).toContain("agent-1 closure: done");
    expect(items[1]!.textContent).toContain("已入队");
    expect(items[1]!.getAttribute("data-source")).toBe("closure");
    fireEvent.click(container.querySelector(".sdq-toggle")!);
    expect(container.querySelector(".sdq-list")).toBeNull();
  });
});
