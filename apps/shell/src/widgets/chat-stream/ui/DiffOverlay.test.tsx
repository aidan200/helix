// @vitest-environment jsdom
/**
 * DiffOverlay 测试（T3+T4 diff 批）——轮次 diff 详情覆盖窗。
 *
 * 钉纪律：
 * - 挂载即发 diff.get（live 旗标：state.diff.phase === "active" → live:true
 *   进行中轮实时视图；frozen/null → 冻结视图）；
 * - 点对点回执 diff.get.result 经 subscribeDiffFrames 注入：文件列表
 *  （status 色点 data-status / 路径 / ±counts / 多 agent 徽章）+ 右侧
 *  unified diff 渲染（+行 add 类 / −行 del 类 / hunk 头类）；
 * - external 条目：note 呈现、无 diff 文本；
 * - Esc / 点遮罩 → onClose；connection.error → 错误态。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { createInitialSessionState, type SessionState } from "@/entities/session/model/session-reducer";
import type { EventEnvelope } from "@helix/protocol";

localStorage.setItem("helix-lang", "zh-CN");

const stateRef: { current: SessionState } = { current: createInitialSessionState() };
const sent: { payload: { live?: boolean; turnId?: string } }[] = [];
let frameSink: ((e: EventEnvelope) => void) | null = null;
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: stateRef.current,
      sendDiffGet: (payload: { live?: boolean; turnId?: string }) => {
        sent.push({ payload });
        return true;
      },
      subscribeDiffFrames: (cb: (e: EventEnvelope) => void) => {
        frameSink = cb;
        return () => {
          frameSink = null;
        };
      },
    }),
  };
});

import DiffOverlay from "./DiffOverlay";

afterEach(() => {
  cleanup();
  sent.length = 0;
  frameSink = null;
});

const FILES = [
  {
    path: "/w/src/a.ts",
    status: "modified" as const,
    adds: 10,
    dels: 2,
    diff: "@@ -1,3 +1,4 @@\n context\n-old\n+new\n+new2",
    agents: ["main"],
  },
  {
    path: "/w/src/b.ts",
    status: "added" as const,
    adds: 5,
    dels: 0,
    diff: "@@ -0,0 +1,2 @@\n+entire\n+file",
    agents: ["main", "agent-9f2c1d"],
  },
  {
    path: "/w/build.out",
    status: "external" as const,
    adds: 0,
    dels: 0,
    note: "外部修改 ±120 行（粗估）",
    agents: [],
  },
];

function resultFrame(): EventEnvelope {
  return {
    v: 0,
    type: "diff.get.result",
    sessionId: "s1",
    payload: { files: FILES, summary: { adds: 15, dels: 2 } },
  } as unknown as EventEnvelope;
}

function ui(onClose = vi.fn()) {
  return render(
    <I18nProvider>
      <DiffOverlay onClose={onClose} />
    </I18nProvider>,
  );
}

describe("DiffOverlay 查询链", () => {
  it("挂载即发 diff.get；进行中轮（phase=active）带 live:true", () => {
    stateRef.current = {
      ...createInitialSessionState(),
      sessionId: "s1",
      diff: { turnId: "t-1", phase: "active", adds: 1, dels: 0, fileCount: 1 },
    };
    ui();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toEqual({ live: true });
  });

  it("冻结轮（phase=frozen）→ 冻结视图（无 live 旗标）", () => {
    stateRef.current = {
      ...createInitialSessionState(),
      sessionId: "s1",
      diff: { turnId: "t-1", phase: "frozen", adds: 1, dels: 1, fileCount: 1 },
    };
    ui();
    expect(sent[0]!.payload).toEqual({});
  });

  it("diff.get.result → 文件列表 + 汇总渲染", () => {
    stateRef.current = createInitialSessionState();
    const { container } = ui();
    act(() => frameSink!(resultFrame()));
    expect(container.querySelectorAll(".diff-file")).toHaveLength(3);
    expect(container.querySelector(".diff-summary")!.textContent).toContain("+15");
    expect(container.querySelector(".diff-summary")!.textContent).toContain("−2");
  });
});

describe("DiffOverlay 文件行与 diff 渲染", () => {
  it("status 色点 data-status + 路径 + ±counts", () => {
    stateRef.current = createInitialSessionState();
    const { container } = ui();
    act(() => frameSink!(resultFrame()));
    const rows = Array.from(container.querySelectorAll(".diff-file"));
    expect(rows[0]!.getAttribute("data-status")).toBe("modified");
    expect(rows[1]!.getAttribute("data-status")).toBe("added");
    expect(rows[2]!.getAttribute("data-status")).toBe("external");
    expect(rows[0]!.textContent).toContain("/w/src/a.ts");
    expect(rows[0]!.textContent).toContain("+10");
    expect(rows[0]!.textContent).toContain("−2");
  });

  it("多 agent 徽章：main 主色 / SubAgent 短 id（agent-9f2c1d → 9f2c1d）", () => {
    stateRef.current = createInitialSessionState();
    const { container } = ui();
    act(() => frameSink!(resultFrame()));
    const badges = container.querySelectorAll(".diff-file")[1]!.querySelectorAll(".diff-agent");
    expect(badges).toHaveLength(2);
    expect(badges[0]!.getAttribute("data-agent")).toBe("main");
    expect(badges[1]!.getAttribute("data-agent")).toBe("sub");
    expect(badges[1]!.textContent).toBe("9f2c1d");
  });

  it("external 条目：note 呈现、无 agent 徽章", () => {
    stateRef.current = createInitialSessionState();
    const { container } = ui();
    act(() => frameSink!(resultFrame()));
    const ext = container.querySelectorAll(".diff-file")[2]!;
    expect(ext.textContent).toContain("外部修改 ±120 行（粗估）");
    expect(ext.querySelectorAll(".diff-agent")).toHaveLength(0);
  });

  it("默认选首文件渲染 unified diff：+行 add 类 / −行 del 类 / hunk 头类；点击行切换", () => {
    stateRef.current = createInitialSessionState();
    const { container } = ui();
    act(() => frameSink!(resultFrame()));
    expect(container.querySelectorAll(".diff-view .dl-add")).toHaveLength(2);
    expect(container.querySelectorAll(".diff-view .dl-del")).toHaveLength(1);
    expect(container.querySelector(".diff-view")!.textContent).toContain("@@ -1,3 +1,4 @@");
    // 点击第二个文件 → 切换到 added 文件的 diff（+entire/+file）
    fireEvent.click(container.querySelectorAll(".diff-file")[1]!);
    expect(container.querySelector(".diff-view")!.textContent).toContain("entire");
  });
});

describe("DiffOverlay 交互与错误态", () => {
  it("Esc → onClose；点遮罩 → onClose", () => {
    stateRef.current = createInitialSessionState();
    const onClose = vi.fn();
    const { container } = ui(onClose);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector('[data-testid="diff-overlay"]')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("connection.error → 错误态呈现（不崩）", () => {
    stateRef.current = createInitialSessionState();
    const { container } = ui();
    act(() => frameSink!({ v: 0, type: "connection.error", payload: { message: "boom" } } as unknown as EventEnvelope));
    expect(container.querySelector(".diff-error")).not.toBeNull();
    expect(container.querySelector(".diff-error")!.textContent).toContain("boom");
  });
});
