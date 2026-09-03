// @vitest-environment jsdom
/**
 * P-1 TracePage 组件测试（CL-5；T2.2 RED 清单 7 + 五态组件面 + 上下文卡降级）。
 *
 * vi.mock SessionContext 先例（ChatPage.test.tsx）：topology.list 供 sidebar 会话列表，
 * sendTraceQuery / subscribeTraceFrames 为 trace 查询通道（连接私有读面）。
 * 帧注入 = 捕获的订阅回调直接回放（trace.query.result / connection.error）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type {
  EventEnvelope,
  TraceEventRow,
  TraceInstanceRecord,
  TraceQueryPayload,
  TraceQueryResultPayload,
} from "@helix/protocol";
import { buildTraceQuery, TRACE_PAGE_SIZE, type TraceFilter } from "./model/trace-model";

// ── SessionContext mock（页面域消费面；逐用例可变）─────────

const TS0 = Date.parse("2026-08-19T14:00:00.000+08:00");

const SESSIONS = [
  { sessionId: "ses_a", title: "M4 收口", lastActivityAt: 2, runState: "idle" as const, loaded: true },
  { sessionId: "ses_b", title: "空会话", lastActivityAt: 1, runState: "idle" as const, loaded: true },
];

const MAIN_SNAPSHOT = {
  systemPrompt: "LINE1\nLINE2\nLINE3\nLINE4\nLINE5",
  tools: ["read", "write", "edit", "bash"],
  model: "zhipu/glm-4.6",
  compaction: { enabled: true, reserveTokens: 96000, keepRecentTokens: 32000 },
};
const SUB_SNAPSHOT = {
  systemPrompt: "SUB PROMPT BODY",
  tools: ["read", "grep"],
  model: "zai/glm-5.3",
};

const INSTANCES: TraceInstanceRecord[] = [
  {
    instanceId: "main",
    agentKind: "main",
    profileKind: "main-session",
    model: "zhipu/glm-4.6",
    status: "running",
    startedAt: new Date(TS0).toISOString(),
    eventCount: 10,
    snapshot: MAIN_SNAPSHOT,
    snapshotMissing: false,
    currentModel: "deepseek/deepseek-chat",
    modelTimeline: [
      { from: "zhipu/glm-4.6", to: "deepseek/deepseek-chat", at: new Date(TS0 + 50_000).toISOString() },
    ],
  },
  {
    instanceId: "agt_F1",
    agentKind: "subagent",
    profileKind: "phase-coder",
    model: "zai/glm-5.3",
    status: "failed",
    startedAt: new Date(TS0 + 1000).toISOString(),
    endedAt: new Date(TS0 + 61_000).toISOString(),
    task: "扩展 scriptedEngine 的 error 形态",
    eventCount: 5,
    snapshot: SUB_SNAPSHOT,
    snapshotMissing: false,
  },
  {
    instanceId: "agt_K6",
    agentKind: "subagent",
    profileKind: "phase-explorer",
    status: "completed",
    startedAt: new Date(TS0 + 2000).toISOString(),
    endedAt: new Date(TS0 + 30_000).toISOString(),
    eventCount: 3,
    snapshotMissing: true,
  },
];

function mkRow(id: number, over: Partial<TraceEventRow> = {}): TraceEventRow {
  return {
    id,
    ts: new Date(TS0 + id * 1000).toISOString(),
    sessionId: "ses_a",
    instanceId: "main",
    agentKind: "main",
    type: "message.completed",
    payload: { role: "assistant", text: `msg-${id}` },
    ...over,
  };
}

interface MockSession {
  conn: "connecting" | "connected" | "disconnected" | "error";
  activeSessionId: string | null;
  sentQueries: TraceQueryPayload[];
  sendOk: boolean;
  listeners: ((e: EventEnvelope) => void)[];
  taskListeners: ((e: EventEnvelope) => void)[];
  /** M42：会话清单可变位（空清单 → requestSessionList 请求路径测试）。 */
  list: typeof SESSIONS;
}

const mock: MockSession = {
  conn: "connected",
  activeSessionId: "ses_a",
  sentQueries: [],
  sendOk: true,
  listeners: [],
  taskListeners: [],
  list: SESSIONS,
};
const requestSessionList = vi.fn();
const retry = vi.fn();

vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: { conn: mock.conn, sessionId: mock.activeSessionId },
      topology: { active: { conn: mock.conn, sessionId: mock.activeSessionId }, background: {}, list: mock.list },
      requestSessionList,
      retry,
      sendTraceQuery: (payload: TraceQueryPayload) => {
        mock.sentQueries.push(payload);
        return mock.sendOk;
      },
      subscribeTraceFrames: (cb: (e: EventEnvelope) => void) => {
        mock.listeners.push(cb);
        return () => {
          mock.listeners = mock.listeners.filter((l) => l !== cb);
        };
      },
      // 任务会话清单面（B：trace 纳入 task:<jobId> 会话）——mock 零任务形态
      sendTaskList: () => true,
      subscribeTaskFrames: (cb: (e: EventEnvelope) => void) => {
        mock.taskListeners.push(cb);
        return () => {
          mock.taskListeners = mock.taskListeners.filter((l) => l !== cb);
        };
      },
    }),
  };
});

import TracePage from "./TracePage";

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

function ui() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <TracePage path="/trace" />
      </ToastProvider>
    </I18nProvider>,
  );
}

/** 回放一条 trace.query.result（filterEcho 与最近发送的查询对齐；可覆盖）。 */
function feedResult(over: Partial<TraceQueryResultPayload> = {}) {
  const sent = mock.sentQueries[mock.sentQueries.length - 1]!;
  const filter: TraceFilter = {
    sessionId: sent.sessionId,
    instanceId: sent.instanceIds?.[0] ?? null,
    types: sent.types ?? null,
    rangeSec: null,
  };
  const echo = over.filterEcho ?? buildTraceQuery(filter, null, sent.page?.beforeId ?? null).echo;
  const payload: TraceQueryResultPayload = {
    filterEcho: echo,
    instances: INSTANCES,
    events: [mkRow(3), mkRow(2), mkRow(1)],
    page: { loaded: 3, total: 3, hasMore: false },
    ...over,
  };
  const frame = { v: "0.11", type: "trace.query.result", sessionId: sent.sessionId, channel: "trace", payload } as EventEnvelope;
  for (const l of mock.listeners) l(frame);
}

function feedConnError(message: string) {
  const frame = {
    v: "0.11",
    type: "connection.error",
    channel: "notification",
    sessionId: "__system__",
    payload: { code: "command.invalid_payload", message },
  } as unknown as EventEnvelope;
  for (const l of mock.listeners) l(frame);
}

afterEach(() => {
  cleanup();
  mock.conn = "connected";
  mock.activeSessionId = "ses_a";
  mock.sentQueries = [];
  mock.sendOk = true;
  mock.listeners = [];
  mock.taskListeners = [];
  mock.list = SESSIONS;
  vi.clearAllMocks();
});

describe("P-1 TracePage 组件（控制条 / 表头 / 行展开 / 状态面）", () => {
  it("AppLayout 壳 + sidebar 上下分区（会话/实例清单）+ 控制条两件（无 session 下拉）；进页自动单飞查询", () => {
    const { container } = ui();
    // S3b：壳 = AppLayout（header 页名 / sidebar 槽）
    expect(document.querySelector(".app-header .p1-title")!.textContent).toBe("事件追溯");
    // sidebar 上分区：会话清单（清单注入）+ 当前会话 cyan 激活态
    const sb = container.querySelector("[data-trace-sidebar]") as HTMLElement;
    expect(sb).toBeTruthy();
    const sesList = sb.querySelector(".tsb-list") as HTMLElement;
    const sesItems = within(sesList).getAllByRole("button");
    expect(sesItems.map((b) => (b as HTMLElement).dataset.sessionId)).toEqual(["ses_a", "ses_b"]);
    expect(sesItems[0]!.textContent).toContain("M4 收口");
    expect(sesItems[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(sesItems[1]!.getAttribute("aria-pressed")).toBe("false");
    // 控制条：session 下拉退役（会话选择由 sidebar 承担）+ 时间范围四档 + 类型 chips 八枚
    expect(document.querySelector("#p1-sel-session")).toBeNull();
    const rangeSel = screen.getByLabelText("时间范围") as HTMLSelectElement;
    expect(within(rangeSel).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "全部时间",
      "最近 1 小时",
      "最近 15 分钟",
      "最近 5 分钟",
    ]);
    const chips = within(screen.getByRole("group", { name: "事件类型多选" })).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual([
      "message",
      "tool",
      "thinking",
      "usage",
      "lifecycle",
      "engine.error",
      "compaction.completed",
      "model.changed",
    ]);
    // 进页默认选中活跃会话并发起全量查询（单飞：一页一查）
    expect(mock.sentQueries.length).toBe(1);
    expect(mock.sentQueries[0]).toMatchObject({ sessionId: "ses_a", page: { limit: TRACE_PAGE_SIZE } });
    expect(mock.sentQueries[0]!.instanceIds).toBeUndefined();
    expect(mock.sentQueries[0]!.types).toBeUndefined();
    // loading = 同形骨架（非 spinner）
    expect(document.querySelectorAll(".p1-skel-row").length).toBeGreaterThan(0);
    expect(requestSessionList).not.toHaveBeenCalled(); // 清单已就绪：未请求态才发
  });

  it("sidebar 会话切换：点击其他会话 = session 域全量重置查询（筛选归零）+ 激活态跟随", () => {
    ui();
    act(() => feedResult());
    fireEvent.click(screen.getByRole("button", { name: /空会话/ }));
    expect(mock.sentQueries.length).toBe(2);
    expect(mock.sentQueries[1]).toMatchObject({ sessionId: "ses_b", page: { limit: TRACE_PAGE_SIZE } });
    expect(mock.sentQueries[1]!.instanceIds).toBeUndefined(); // 切会话筛选归零
    expect(mock.sentQueries[1]!.types).toBeUndefined();
    const items = document.querySelectorAll(".tsb-ses");
    expect(items[0]!.getAttribute("aria-pressed")).toBe("false");
    expect(items[1]!.getAttribute("aria-pressed")).toBe("true"); // 激活态随查询即时切换
  });

  it("任务会话入侧栏（B）：task.list.result → task:<jobId> 条目排前 + 类型徽章 + 点击发起 task 会话查询", () => {
    ui();
    act(() => feedResult());
    // 推任务清单（task.list.result 点对点回执，宽松形状同 TasksPage 先例）
    act(() => {
      for (const cb of mock.taskListeners) {
        cb({
          v: 1,
          type: "task.list.result",
          payload: {
            tasks: [
              {
                jobId: "job-x1",
                type: "code-review",
                title: "代码评审：daemon 任务域",
                status: "done",
                projects: ["helix"],
                createdBy: "page",
                createdAt: new Date(TS0).toISOString(),
                updatedAt: new Date(TS0 + 60_000).toISOString(),
                progress: null,
              },
            ],
          },
        } as unknown as EventEnvelope);
      }
    });
    // 侧栏：任务会话排前 + 徽章渲染
    const items = document.querySelectorAll(".tsb-ses");
    expect(items[0]!.getAttribute("data-session-id")).toBe("task:job-x1");
    const badge = items[0]!.querySelector(".tsb-task-badge");
    expect(badge?.textContent).toBe("code-review");
    expect(items[0]!.textContent).toContain("代码评审：daemon 任务域");
    // 点击任务会话 → session 域查询（task:<jobId> 直查 domain_events）
    fireEvent.click(items[0]!);
    expect(mock.sentQueries.some((q) => q.sessionId === "task:job-x1")).toBe(true);
  });

  it("success：混排表头四列（时间/实例/类型/摘要）+ 命中计数 + 行展开 payload（手风琴 + aria-expanded）", () => {
    ui();
    act(() => feedResult());
    const thead = document.querySelector(".p1-thead")!;
    expect(["时间", "实例", "类型", "摘要"].every((w) => thead.textContent!.includes(w))).toBe(true);
    expect(thead.textContent).toContain("命中 3 条");
    const rows = screen.getAllByRole("button", { name: /msg-/ });
    expect(rows.length).toBe(3);
    // 行展开：payload JSON 可见 + aria-expanded
    fireEvent.click(rows[0]!);
    expect(rows[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/"role": "assistant"/)).toBeTruthy();
    // 手风琴单开：开第二行收第一行
    fireEvent.click(rows[1]!);
    expect(rows[1]!.getAttribute("aria-expanded")).toBe("true");
    expect(rows[0]!.getAttribute("aria-expanded")).toBe("false");
    // 再点收起
    fireEvent.click(rows[1]!);
    expect(rows[1]!.getAttribute("aria-expanded")).toBe("false");
  });

  it("选中实例 → 详情视图（三列无实例列 + 上下文卡）；「全部实例」回混排", () => {
    ui();
    act(() => feedResult());
    fireEvent.click(screen.getByRole("button", { name: /agt_F1/ }));
    expect(mock.sentQueries.length).toBe(2);
    expect(mock.sentQueries[1]!.instanceIds).toEqual(["agt_F1"]);
    act(() => feedResult({ events: [mkRow(5, { instanceId: "agt_F1", agentKind: "subagent" })], page: { loaded: 1, total: 1, hasMore: false } }));
    const thead = document.querySelector(".p1-thead")!;
    expect(thead.textContent).not.toContain("实例");
    // 上下文卡：快照双段
    const ctx = screen.getByLabelText("执行上下文");
    expect(ctx.textContent).toContain("扩展 scriptedEngine 的 error 形态"); // spawn task blockquote
    expect(ctx.textContent).toContain("SUB PROMPT BODY");
    expect(ctx.textContent).toContain("zai/glm-5.3");
    // 回全部实例
    fireEvent.click(screen.getByRole("button", { name: /全部实例/ }));
    expect(mock.sentQueries.length).toBe(3);
    expect(mock.sentQueries[2]!.instanceIds).toBeUndefined();
  });

  it("上下文卡：主实例双段（快照 + 变更轨迹当前值高亮）；systemPrompt 折叠展开；快照缺失降级", () => {
    ui();
    act(() => feedResult());
    // 主实例：modelTimeline → 变更轨迹 + 当前高亮 + compaction 参数
    fireEvent.click(screen.getByRole("button", { name: /主实例/ }));
    act(() => feedResult({ events: [mkRow(9)], page: { loaded: 1, total: 1, hasMore: false } }));
    const ctx = screen.getByLabelText("执行上下文");
    expect(ctx.textContent).toContain("变更轨迹");
    expect(ctx.textContent).toContain("zhipu/glm-4.6");
    expect(ctx.textContent).toContain("deepseek/deepseek-chat");
    expect(ctx.querySelector(".tl-cur")!.textContent).toContain("deepseek/deepseek-chat");
    expect(ctx.textContent).toContain("compaction");
    // systemPrompt 折叠 3 行 → 展开全文
    const body = ctx.querySelector(".cp-body")!;
    expect(body.classList.contains("folded")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "展开全文" }));
    expect(ctx.querySelector(".cp-body")!.classList.contains("folded")).toBe(false);
    // 快照缺失降级：不 throw、卡保留 + 缺失标注
    fireEvent.click(screen.getByRole("button", { name: /agt_K6/ }));
    act(() => feedResult({ events: [], page: { loaded: 0, total: 0, hasMore: false } }));
    const ctx2 = screen.getByLabelText("执行上下文");
    expect(ctx2.textContent).toContain("快照缺失");
    expect(ctx2.textContent).toContain("agt_K6");
  });

  it("五态互斥：error（role=alert + 重试）→ 重试重发；empty 双 flavor；断连 overlay 正交", () => {
    ui();
    // error：在途查询收到 connection.error
    act(() => feedConnError("trace.query: domain_events 索引不可用 (SQLITE_BUSY)"));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("事件查询失败");
    expect(alert.textContent).toContain("SQLITE_BUSY");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(mock.sentQueries.length).toBe(2);
    // empty flavor 1：会话无事件（无筛选 echo）
    act(() => feedResult({ events: [], page: { loaded: 0, total: 0, hasMore: false } }));
    expect(screen.getByText("该会话暂无事件记录")).toBeTruthy();
    // empty flavor 2：筛选后空（类型 chip 过滤下推）
    fireEvent.click(screen.getByRole("button", { name: "engine.error" }));
    expect(mock.sentQueries[2]!.types).toEqual(["engine.error"]);
    act(() => feedResult({ events: [], page: { loaded: 0, total: 0, hasMore: false } }));
    expect(screen.getByText("当前筛选无匹配事件")).toBeTruthy();
    // 断连 overlay：正交层（压住内容区，重连入口）
    mock.conn = "disconnected";
    ui();
    expect(screen.getAllByText("连接已断开").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "重新连接" }).length).toBeGreaterThan(0);
  });

  it("分页：加载更多步进 beforeId 游标 → 追加；加载完收口「已加载全部」禁用", () => {
    ui();
    const rows1 = [mkRow(100), mkRow(99), mkRow(98)];
    act(() => feedResult({ events: rows1, page: { loaded: 3, total: 6, hasMore: true } }));
    expect(document.querySelector(".p1-foot")!.textContent).toContain("已加载 3 / 6 条");
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(mock.sentQueries.length).toBe(2);
    expect(mock.sentQueries[1]!.page).toEqual({ limit: TRACE_PAGE_SIZE, beforeId: 98 });
    act(() =>
      feedResult({
        events: [mkRow(97), mkRow(96), mkRow(95)],
        page: { loaded: 3, total: 6, hasMore: false },
      }),
    );
    expect(document.querySelector(".p1-foot")!.textContent).toContain("已加载 6 / 6 条");
    const more = screen.getByRole("button", { name: "已加载全部" }) as HTMLButtonElement;
    expect(more.disabled).toBe(true);
  });

  it("engine.error 行 error 色系类 + 类型 chip 过滤下推 daemon（前端不本地过滤）", () => {
    ui();
    act(() =>
      feedResult({
        events: [
          mkRow(2, { type: "engine.error", instanceId: "agt_F1", agentKind: "subagent", payload: { provider: "zai", model: "glm-5.3", status: 429, message: "quota" } }),
          mkRow(1),
        ],
        page: { loaded: 2, total: 2, hasMore: false },
      }),
    );
    expect(document.querySelector(".p1-entry.err-row")).toBeTruthy();
    expect(document.querySelector(".p1-tt-engineerr")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "engine.error" }));
    const sent = mock.sentQueries[1]!;
    expect(sent.types).toEqual(["engine.error"]); // 下推：types 进查询 payload
  });
});

describe("M42 会话清单请求位（requestedListRef）失败/断连恢复", () => {
  it("空清单首次请求后断连 → 重连重拉（ref 断连清位，清单不再永不重拉）", () => {
    mock.list = [];
    const view = ui();
    expect(requestSessionList).toHaveBeenCalledTimes(1);
    // 回执未达先断连
    mock.conn = "disconnected";
    view.rerender(
      <I18nProvider>
        <ToastProvider>
          <TracePage path="/trace" />
        </ToastProvider>
      </I18nProvider>,
    );
    // 重连（清单仍空）→ 允许再次请求
    mock.conn = "connected";
    view.rerender(
      <I18nProvider>
        <ToastProvider>
          <TracePage path="/trace" />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(requestSessionList).toHaveBeenCalledTimes(2);
    // 同一 connected 周期内不重复发（单飞去重保持）
    view.rerender(
      <I18nProvider>
        <ToastProvider>
          <TracePage path="/trace" />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(requestSessionList).toHaveBeenCalledTimes(2);
  });
});
