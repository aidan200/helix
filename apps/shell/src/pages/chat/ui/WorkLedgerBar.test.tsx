// @vitest-environment jsdom
/**
 * 工作台账条（WorkLedgerBar）三态测试（main-session plan 批）：
 *
 * - 无台账（plan=null）→ 整条隐藏（零占位）；
 * - 收起态（缺省）→ 一行摘要：图标 + n/m 项完成（ledger 服务端计数直渲）
 *   + 进行中项名 + 展开箭头；条目清单不渲染；
 * - 展开态（点击切换）→ 条目清单：四态状态点（data-wl-work）、内容、
 *   note 摘要（右对齐位 data-wl-note）、abandoned 灰显带理由、in_progress
 *   高亮；再点击回收起。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { WorkItemDto } from "@helix/protocol";
import {
  createInitialSessionState,
  type SessionState,
} from "@/entities/session/model/session-reducer";

const stateRef: { current: SessionState } = { current: createInitialSessionState() };
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({ state: stateRef.current }),
  };
});

import WorkLedgerBar from "./WorkLedgerBar";

const ROWS: WorkItemDto[] = [
  { seq: 1, content: "读未提交改动", status: "done", note: "diff 已读" },
  { seq: 2, content: "跑 daemon 测试", status: "in_progress", note: null },
  { seq: 3, content: "shell 观察面", status: "pending", note: null },
  { seq: 4, content: "旧方案探查", status: "abandoned", note: "被 #2 覆盖，不做" },
];

function withPlan(plan: WorkItemDto[] | null): SessionState {
  return {
    ...createInitialSessionState(),
    sessionId: "s1",
    view: "ready",
    plan,
    ledger: plan === null ? null : { total: plan.length, done: 1, inProgress: 1 },
  };
}

function ui() {
  return render(
    <I18nProvider>
      <WorkLedgerBar />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

describe("工作台账条三态（main-session plan 批观察面）", () => {
  it("无台账（plan=null）→ 整条隐藏", () => {
    stateRef.current = withPlan(null);
    ui();
    expect(document.querySelector("[data-wl-bar]")).toBeNull();
  });

  it("收起态：一行摘要（n/m 项完成 + 进行中项名 + 展开箭头）；条目清单不渲染", () => {
    stateRef.current = withPlan(ROWS);
    ui();
    const bar = document.querySelector("[data-wl-bar]")!;
    expect(bar.getAttribute("data-plan-open")).toBe("off");
    expect(document.querySelector("[data-wl-count]")?.textContent).toBe("1/4 项完成");
    expect(document.querySelector("[data-wl-doing]")?.textContent).toContain("跑 daemon 测试");
    expect(document.querySelector(".wl-arrow")?.textContent).toBe("▾");
    expect(document.querySelector("[data-wl-items]")).toBeNull();
    // 无进行中项时「正在：」不渲染
    stateRef.current = {
      ...withPlan(ROWS.map((r) => ({ ...r, status: "pending" as const }))),
    };
    cleanup();
    ui();
    expect(document.querySelector("[data-wl-doing]")).toBeNull();
  });

  it("展开态：条目清单四态状态点 + 内容 + note 右对齐位；abandoned 灰显带理由；in_progress 高亮；再击回收起", () => {
    stateRef.current = withPlan(ROWS);
    ui();
    fireEvent.click(document.querySelector("[data-wl-toggle]")!);
    const bar = document.querySelector("[data-wl-bar]")!;
    expect(bar.getAttribute("data-plan-open")).toBe("on");
    const items = Array.from(document.querySelectorAll("[data-wl-work]"));
    expect(items.map((el) => el.getAttribute("data-wl-work"))).toEqual([
      "done",
      "in_progress",
      "pending",
      "abandoned",
    ]);
    // in_progress 高亮（类名位）+ abandoned 灰显（类名位）带理由 note
    expect(items[1]!.className).toContain("in_progress");
    expect(items[3]!.className).toContain("abandoned");
    expect(items[3]!.querySelector("[data-wl-note]")?.textContent).toBe("被 #2 覆盖，不做");
    // note=null 行不渲染 note 位
    expect(items[1]!.querySelector("[data-wl-note]")).toBeNull();
    // 内容行文本
    expect(items[0]!.textContent).toContain("读未提交改动");
    // 再击回收起
    fireEvent.click(document.querySelector("[data-wl-toggle]")!);
    expect(document.querySelector("[data-wl-bar]")!.getAttribute("data-plan-open")).toBe("off");
    expect(document.querySelector("[data-wl-items]")).toBeNull();
  });
});
