// @vitest-environment jsdom
/**
 * 抽屉台账条三态测试 + 输入栏去 agentid（SubAgent 抽屉 plan 面）：
 *
 * - 无分片（instancePlans 无键）→ 整条隐藏（零占位）；
 * - 收起态（缺省）→ 一行摘要（n/m + 进行中项名）；展开态 → 清单四态行
 *  （data-dpb-work）+ note 摘要（data-dpb-note）；
 * - 分片隔离：他实例分片不串台（按 instanceId 寻址）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

import DrawerPlanBar from "./DrawerPlanBar";

const ROWS: WorkItemDto[] = [
  { seq: 1, content: "读链路", status: "done", note: "wire 已读" },
  { seq: 2, content: "写实现", status: "in_progress", note: null },
  { seq: 3, content: "验证", status: "pending", note: null },
  { seq: 4, content: "旧方案", status: "abandoned", note: "被 #2 覆盖" },
];

function withPlan(instanceId: string, rows: WorkItemDto[]): SessionState {
  return {
    ...createInitialSessionState(),
    instancePlans: {
      [instanceId]: { plan: rows, ledger: { total: rows.length, done: 1, inProgress: 1 } },
    },
  };
}

function ui(instanceId = "agent-3") {
  return render(
    <I18nProvider>
      <DrawerPlanBar instanceId={instanceId} />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言）
localStorage.setItem("helix-lang", "zh-CN");

describe("DrawerPlanBar 三态（SubAgent 抽屉 plan 面）", () => {
  it("无分片 → 整条隐藏（未建 plan 实例零占位）", () => {
    stateRef.current = createInitialSessionState();
    const { container } = ui();
    expect(container.querySelector("[data-dpb]")).toBeNull();
  });

  it("收起态（缺省）→ 一行摘要：n/m + 进行中项名；清单不渲染", () => {
    stateRef.current = withPlan("agent-3", ROWS);
    ui();
    expect(screen.getByText("1/4 项完成")).toBeTruthy();
    expect(screen.getByText("写实现")).toBeTruthy(); // 进行中项名
    expect(document.querySelector("[data-dpb-items]")).toBeNull();
  });

  it("点击展开 → 四态行 + note 摘要；再点回收起", () => {
    stateRef.current = withPlan("agent-3", ROWS);
    ui();
    fireEvent.click(screen.getByTitle("展开工作台账"));
    const items = document.querySelectorAll("[data-dpb-work]");
    expect(items).toHaveLength(4);
    expect(items[0]?.getAttribute("data-dpb-work")).toBe("done");
    expect(items[1]?.getAttribute("data-dpb-work")).toBe("in_progress");
    expect(items[2]?.getAttribute("data-dpb-work")).toBe("pending");
    expect(items[3]?.getAttribute("data-dpb-work")).toBe("abandoned");
    expect(screen.getByText("被 #2 覆盖")).toBeTruthy(); // note 摘要
    fireEvent.click(screen.getByTitle("收起工作台账"));
    expect(document.querySelector("[data-dpb-items]")).toBeNull();
  });

  it("分片隔离：他实例分片不串台（按 instanceId 寻址）", () => {
    stateRef.current = withPlan("agent-9", ROWS);
    const { container } = ui("agent-3"); // 展开 agent-3，分片在 agent-9
    expect(container.querySelector("[data-dpb]")).toBeNull();
  });

  it("切换实例复用同一组件实例 → 展开态不残留（open 按 instanceId 记忆）", () => {
    stateRef.current = withPlan("agent-3", ROWS);
    const { rerender } = ui("agent-3");
    fireEvent.click(screen.getByTitle("展开工作台账"));
    expect(document.querySelector("[data-dpb-items]")).not.toBeNull();
    // 抽屉按实例复用组件实例（SubagentDrawer 不带 key）：instanceId 变即失配收起
    stateRef.current = {
      ...createInitialSessionState(),
      instancePlans: {
        "agent-3": { plan: ROWS, ledger: { total: 4, done: 1, inProgress: 1 } },
        "agent-7": { plan: ROWS, ledger: { total: 4, done: 1, inProgress: 1 } },
      },
    };
    rerender(
      <I18nProvider>
        <DrawerPlanBar instanceId="agent-7" />
      </I18nProvider>,
    );
    expect(document.querySelector("[data-dpb-items]")).toBeNull();
    expect(document.querySelector("[data-dpb]")!.getAttribute("data-plan-open")).toBe("off");
  });
});
