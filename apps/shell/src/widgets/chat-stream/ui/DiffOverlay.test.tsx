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
/** sendDiffGet 返回开关（code-review M：send false 交代）——缺省 true。 */
let sendOk = true;
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: stateRef.current,
      sendDiffGet: (payload: { live?: boolean; turnId?: string }) => {
        sent.push({ payload });
        return sendOk;
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
  sendOk = true;
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

// ── code-review M 族（TR-168）：send 消费 + connection.error 单飞门控。──
describe("DiffOverlay：code-review M（send 消费 + 单飞门控）", () => {
  it("sendDiffGet 返回 false（断线窗口）→ failed 态交代（不永挂 pending）", () => {
    sendOk = false;
    render(<I18nProvider><DiffOverlay onClose={() => {}} /></I18nProvider>);
    expect(document.querySelector('[data-testid="diff-error"]')).not.toBeNull();
  });

  it("connection.error 单飞门控：done 视图不被无关 error 帧误判（头注释自称单飞——现补上实现）", () => {
    stateRef.current = createInitialSessionState();
    ui();
    act(() => frameSink!(resultFrame()));
    expect(document.querySelector('[data-testid="diff-error"]')).toBeNull(); // done 视图
    act(() => frameSink!({ type: "connection.error", payload: { message: "无关命令失败" } } as unknown as EventEnvelope));
    expect(document.querySelector('[data-testid="diff-error"]')).toBeNull(); // 不消费（无 pending）
  });
});

// ── code-review 低危组9：result 帧保留 selected + 尾空行剥离。──
describe("DiffOverlay：code-review 低危组9", () => {
  it("后续 result 帧保留原 selected（live 多帧不闪回首项）；files 收缩越界钳到末项", () => {
    stateRef.current = createInitialSessionState();
    const { container } = ui();
    act(() => frameSink!(resultFrame()));
    // 选第 2 个文件（b.ts）
    fireEvent.click(container.querySelectorAll(".diff-file")[1]!);
    expect(container.querySelector(".diff-view")!.textContent).toContain("entire");
    // 同长度刷新帧：选中保持
    act(() => frameSink!(resultFrame()));
    expect(container.querySelector(".diff-view")!.textContent).toContain("entire");
    // 收缩到 1 文件的刷新帧：越界钳到末项（首项 a.ts）
    act(() =>
      frameSink!({
        v: 0,
        type: "diff.get.result",
        sessionId: "s1",
        payload: { files: [FILES[0]!], summary: { adds: 10, dels: 2 } },
      } as unknown as EventEnvelope),
    );
    expect(container.querySelector(".diff-view")!.textContent).toContain("@@ -1,3 +1,4 @@");
    // 空文件表：钳到 0 不崩
    act(() =>
      frameSink!({
        v: 0,
        type: "diff.get.result",
        sessionId: "s1",
        payload: { files: [], summary: { adds: 0, dels: 0 } },
      } as unknown as EventEnvelope),
    );
    expect(container.querySelector(".diff-empty")).not.toBeNull();
  });

  it("尾空行只剥末尾（正文空行保留）：diff 文本尾部多换行不产生多余空行，上下文空行仍在", () => {
    stateRef.current = createInitialSessionState();
    const { container } = ui();
    act(() =>
      frameSink!({
        v: 0,
        type: "diff.get.result",
        sessionId: "s1",
        payload: {
          files: [
            {
              path: "/w/src/c.ts",
              status: "modified" as const,
              adds: 1,
              dels: 0,
              // hunk 头 + 一行上下文 + 空上下文行（正文空行）+ 新增行 + 尾部三连换行
              diff: "@@ -1,2 +1,3 @@\n ctx\n\n+add\n\n\n\n",
              agents: ["main"],
            },
          ],
          summary: { adds: 1, dels: 0 },
        },
      } as unknown as EventEnvelope),
    );
    const lines = Array.from(container.querySelectorAll(".diff-view > span"));
    // 每行 span 尾渲染 \n（源码 {l}{"\n"}）——断言前剥行尾换行
    // split 后行序：hunk / " ctx" / ""（正文空行保留）/ "+add" ——尾部三连换行仅产生零空行
    expect(lines.map((l) => l.textContent?.replace(/\n$/, ""))).toEqual(["@@ -1,2 +1,3 @@", " ctx", "", "+add"]);
  });
});
