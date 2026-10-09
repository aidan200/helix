// @vitest-environment jsdom
/**
 * 管家活动时间线页测试（M3-d1 感知兑现批）：
 * - 查询面：进入/切窗 → steward.activity.list {range}；steward.activity.result
 *   回执整表替换（白话句 + 域 chip + 归因徽标渲染）；
 * - 实时面：steward.activity 广播帧在窗入列（新条目插头）；不在窗忽略；
 * - 清理面：两段式 armed 清空 → steward.activity.clear（回执空窗刷新）。
 *
 * vi.mock SessionContext 先例（StewardMemoryPage.test.tsx）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";
import { PROTOCOL_VERSION } from "@helix/protocol";

const sendStewardActivityList = vi.fn(() => true);
const sendStewardActivityClear = vi.fn(() => true);
let stewardListeners: ((e: EventEnvelope) => void)[] = [];

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      sendStewardActivityList,
      sendStewardActivityClear,
      subscribeStewardFrames: (listener: (e: EventEnvelope) => void) => {
        stewardListeners.push(listener);
        return () => {
          stewardListeners = stewardListeners.filter((l) => l !== listener);
        };
      },
    }),
  };
});

vi.mock("@/widgets/app-layout/ui/AppLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import StewardActivityPage from "./StewardActivityPage";

const NOW = Date.now();

beforeEach(() => {
  localStorage.setItem("helix-lang", "zh-CN");
});

afterEach(() => {
  cleanup();
  stewardListeners = [];
  vi.clearAllMocks();
});

const ENTRIES = [
  { at: NOW - 60_000, domain: "task", attribution: "system", text: "「登录修复」完成了" },
  { at: NOW - 120_000, domain: "cli", attribution: "system", text: "终端里的对话回完了" },
  { at: NOW - 180_000, domain: "notify", attribution: "steward", text: "管家通知「后台任务」：任务完成了" },
];

function frameOf(type: string, payload: unknown): EventEnvelope {
  return {
    v: PROTOCOL_VERSION,
    sessionId: "__system__",
    channel: "steward",
    type,
    ts: 1,
    payload,
  } as unknown as EventEnvelope;
}

function feed(type: string, payload: unknown) {
  const frame = frameOf(type, payload);
  act(() => {
    for (const l of stewardListeners) l(frame);
  });
}

function ui() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <StewardActivityPage path="/steward/activity" />
      </ToastProvider>
    </I18nProvider>,
  );
}

describe("管家活动时间线页（M3-d1）", () => {
  it("进入拉取：steward.activity.list(today)；回执整表替换 + 域/归因/白话句渲染", () => {
    const { container } = ui();
    expect(sendStewardActivityList).toHaveBeenCalledTimes(1);
    expect(sendStewardActivityList).toHaveBeenCalledWith("today");
    feed("steward.activity.result", { entries: ENTRIES });
    expect(container.querySelector("[data-activity-item-text='0']")!.textContent).toBe("「登录修复」完成了");
    expect(container.querySelector("[data-activity-item-domain='0']")!.textContent).toContain("任务");
    expect(container.querySelector("[data-activity-item-attribution='2']")!.textContent).toContain("管家");
    expect(container.querySelector("[data-activity-item-domain='1']")!.textContent).toContain("终端");
    expect(container.querySelector("[data-activity-empty]")).toBeNull();
  });

  it("切窗重查：档位切换 → range 参数变化 + 回执权威覆盖", () => {
    const { container } = ui();
    feed("steward.activity.result", { entries: ENTRIES });
    fireEvent.click(container.querySelector("[data-activity-range='this_week']")!);
    expect(sendStewardActivityList).toHaveBeenLastCalledWith("this_week");
    feed("steward.activity.result", { entries: [] });
    expect(container.querySelector("[data-activity-empty]")).not.toBeNull();
  });

  it("实时条目：steward.activity 帧在窗插头入列；不在窗（旧时刻）忽略", () => {
    const { container } = ui();
    feed("steward.activity.result", { entries: ENTRIES });
    feed("steward.activity", { at: NOW - 5_000, domain: "agent", attribution: "system", text: "后台有个帮手干完了一件事", seq: 9 });
    expect(container.querySelector("[data-activity-item-text='0']")!.textContent).toBe("后台有个帮手干完了一件事");
    expect(container.querySelector("[data-activity-item-domain='0']")!.textContent).toContain("帮手");
    // 「今天」窗外的迟到帧（昨日）零入列
    feed("steward.activity", { at: NOW - 2 * 86_400_000, domain: "session", attribution: "system", text: "有一个对话回完了", seq: 10 });
    expect(container.querySelector("[data-activity-item-text='0']")!.textContent).toBe("后台有个帮手干完了一件事");
    // 坏形状帧零破坏（缺字段忽略）
    feed("steward.activity", { at: NOW, domain: "task" });
    expect(container.querySelectorAll("[data-activity-item]").length).toBe(4);
  });

  it("清空两段式：首次点按 armed 态 → 再点按发 steward.activity.clear；回执空窗刷新", () => {
    const { container } = ui();
    feed("steward.activity.result", { entries: ENTRIES });
    const clearBtn = container.querySelector<HTMLButtonElement>("[data-activity-clear]")!;
    fireEvent.click(clearBtn);
    expect(sendStewardActivityClear).not.toHaveBeenCalled(); // 首次 = armed
    expect(clearBtn.getAttribute("data-armed")).toBe("1");
    fireEvent.click(clearBtn);
    expect(sendStewardActivityClear).toHaveBeenCalledTimes(1);
    feed("steward.activity.result", { entries: [] });
    expect(container.querySelector("[data-activity-empty]")).not.toBeNull();
  });

  it("刷新钮：手动重发当前窗口查询", () => {
    const { container } = ui();
    fireEvent.click(container.querySelector("[data-activity-range='all']")!);
    fireEvent.click(container.querySelector("[data-activity-refresh]")!);
    expect(sendStewardActivityList).toHaveBeenLastCalledWith("all");
    expect(sendStewardActivityList).toHaveBeenCalledTimes(3); // 进入 + 切窗 + 刷新
  });
});
