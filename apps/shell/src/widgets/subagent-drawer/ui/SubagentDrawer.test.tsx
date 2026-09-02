// @vitest-environment jsdom
/**
 * SubAgent 抽屉组件测试（T4.3；CL-1 F1.2/F1.8；mock 帧驱动，不依赖 daemon）。
 *
 * - 载体：背板/✕/Esc 三路径关闭；打开即 agent.subscribe、关闭 agent.unsubscribe；
 * - 头部：实例 id/profile、模型 chip、状态 chip、kill 可用性随实例态；
 * - channel 五物种：lifecycle（warn/err 变色）/SA 消息（含流式光标）/thinking
 *   折叠/工具卡/steer 标记/closure 卡（done 绿 failed 红）；queued 空态 ch-hint；
 * - kill 两步状态机：首击确认态（3s 复原）/再击发 agent.kill/终态禁用优先；
 * - stalled 徽标：仅 running 显示（活动恢复/终态隐藏）；channel 对应 warn 行；
 * - 实例切换：channel 全量重渲染无残留；
 * - 滚动语义：stick-to-bottom——用户上滚暂停自动跟随、回底（≤40px 容差）恢复。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import { ToastProvider } from "@/shared/ui/Toast";
import type { EventEnvelope } from "@helix/protocol";
import {
  createInitialSessionState,
  sessionReducer,
  type SessionAction,
  type SessionState,
} from "@/entities/session/model/session-reducer";

// ── SessionContext mock（state 注入 + 实例命令 spy；selectIsGenerating 等真体）──

const killInstance = vi.fn();
const subscribeInstance = vi.fn();
const unsubscribeInstance = vi.fn();
const stateRef: { current: SessionState } = { current: createInitialSessionState() };
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return {
    ...orig,
    useSession: () => ({
      state: stateRef.current,
      killInstance,
      subscribeInstance,
      unsubscribeInstance,
    }),
  };
});

import SubagentDrawer from "./SubagentDrawer";

// ── mock 帧驱动 ─────────────────────────────────────────────

function play(events: SessionAction[]): SessionState {
  return events.reduce(sessionReducer, createInitialSessionState());
}

const ev = (event: EventEnvelope): SessionAction => ({ type: "event", event });

const welcome: SessionAction = ev({
  v: 0,
  type: "connection.welcome",
  payload: { sessionId: "s1", model: "claude-sonnet-4-5", agentState: "idle" },
});

const spawn = (id: string, model?: string): SessionAction =>
  ev({
    v: 0,
    type: "agent.spawned",
    payload: { agentId: id, task: `task ${id}`, profileKind: "subagent-worker", ...(model ? { model } : {}) },
  });

const saDelta = (iid: string, mid: string, d: string): SessionAction =>
  ev({ v: 0, type: "chat.stream.delta", instanceId: iid, payload: { messageId: mid, delta: d } });

const saMsg = (iid: string, id: string, role: "user" | "assistant", text: string, ts = 1): SessionAction =>
  ev({
    v: 0,
    type: "chat.message.completed",
    instanceId: iid,
    payload: { entry: { kind: "message", id, role, content: text, ts, instanceId: iid } },
  });

const toolStart = (iid: string, id: string): SessionAction =>
  ev({
    v: 0,
    type: "tool.call.started",
    instanceId: iid,
    payload: { entry: { kind: "tool-call", id, name: "read", args: "{}", state: "running", ts: 1, instanceId: iid } },
  });

const thinkDone = (iid: string): SessionAction =>
  ev({
    v: 0,
    type: "thinking.completed",
    payload: {
      entry: {
        kind: "thinking",
        id: `th-${iid}`,
        instanceId: iid,
        text: "thinking full text",
        durationMs: 6_000,
        reasoningTokens: 412,
        createdAt: "2026-08-16T14:02:30.000Z",
      },
    },
  });

const stall = (id: string, idleMs: number): SessionAction =>
  ev({ v: 0, type: "agent.stalled", payload: { agentId: id, idleMs } });

const complete = (id: string): SessionAction =>
  ev({
    v: 0,
    type: "agent.completed",
    payload: {
      agentId: id,
      closure: { status: "done", summary: "done summary", reportPath: ".helix/runs/x/report.md", findings: null, taskId: "T9" },
    },
  });

const kill = (id: string): SessionAction =>
  ev({
    v: 0,
    type: "agent.killed",
    payload: {
      agentId: id,
      closure: { status: "failed", summary: "terminated by user", reportPath: null, findings: null, taskId: null },
    },
  });

/** 运行中全物种实例（agent-run）。 */
const runningScenario = (): SessionAction[] => [
  welcome,
  spawn("agent-run", "provider/haiku"),
  thinkDone("agent-run"),
  saDelta("agent-run", "m-1", "partial output"),
  saMsg("agent-run", "m-1", "assistant", "SA full reply"),
  toolStart("agent-run", "t-1"),
  saMsg("agent-run", "m-2", "user", "steer injection text"),
];

function ui(agentId: string, onClose = vi.fn()) {
  return render(
    <I18nProvider>
      <ToastProvider>
        <SubagentDrawer agentId={agentId} onClose={onClose} />
      </ToastProvider>
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

// ── 载体与订阅 ─────────────────────────────────────────────

describe("抽屉载体（P-2 布局）", () => {
  it("打开即 agent.subscribe；卸载即 agent.unsubscribe（同一 agentId）", () => {
    stateRef.current = play(runningScenario());
    const { unmount } = ui("agent-run");
    expect(subscribeInstance).toHaveBeenCalledWith("agent-run");
    expect(subscribeInstance).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribeInstance).toHaveBeenCalledWith("agent-run");
  });

  it("背板点击 / ✕ / Esc 三路径关闭", () => {
    stateRef.current = play(runningScenario());
    const onClose = vi.fn();
    const { rerender } = ui("agent-run", onClose);
    fireEvent.click(document.querySelector(".drawer-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <I18nProvider>
        <ToastProvider>
          <SubagentDrawer agentId="agent-run" onClose={onClose} />
        </ToastProvider>
      </I18nProvider>,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "关闭抽屉" })[1]!); // ✕（背板同名取头内实例）
    expect(onClose).toHaveBeenCalledTimes(2);
    rerender(
      <I18nProvider>
        <ToastProvider>
          <SubagentDrawer agentId="agent-run" onClose={onClose} />
        </ToastProvider>
      </I18nProvider>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("头部四要素：实例 id·profile / 模型 chip / 状态 chip / 任务段与 instanceId meta", () => {
    stateRef.current = play(runningScenario());
    ui("agent-run");
    expect(document.querySelector(".d-id")!.textContent).toContain("agent-run");
    expect(document.querySelector(".d-id .prof")!.textContent).toContain("subagent-worker");
    expect(screen.getByText("provider/haiku")).toBeTruthy();
    expect(document.querySelector(".d-status.running")).toBeTruthy();
    expect(screen.getByText("task agent-run")).toBeTruthy();
    expect(screen.getByText(/agent_spawn/)).toBeTruthy(); // drawer.instanceMeta
  });
});

// ── channel 五物种 ────────────────────────────────────────

describe("channel 五物种单一时间线（F1.2）", () => {
  it("lifecycle/消息/thinking/工具/steer 混排渲染；warn 行变色", () => {
    stateRef.current = play([...runningScenario(), stall("agent-run", 372_000)]);
    ui("agent-run");
    expect(screen.getAllByText(/spawned/).length).toBeGreaterThan(0);
    expect(screen.getByText(/模型解析/)).toBeTruthy();
    expect(screen.getByText("SA full reply")).toBeTruthy();
    expect(document.querySelector(".fb-wrap")).toBeTruthy(); // thinking 折叠
    expect(document.querySelector(".tool-card.running")).toBeTruthy();
    expect(document.querySelector(".steer-mark")!.textContent).toContain("steer injection text");
    expect(document.querySelector(".lc-row.warn")!.textContent).toContain("stalled");
  });

  it("流式中间态：violet 气泡 + 流式光标", () => {
    stateRef.current = play([welcome, spawn("agent-s"), saDelta("agent-s", "m9", "streaming…")]);
    ui("agent-s");
    const live = document.querySelector(".ch-msg.live");
    expect(live).toBeTruthy();
    expect(live!.textContent).toContain("streaming…");
    expect(live!.querySelector(".stream-cursor")).toBeTruthy();
  });

  it("closure 卡五字段（done 绿）；reportPath 脚注", () => {
    stateRef.current = play([...runningScenario(), complete("agent-run")]);
    ui("agent-run");
    const card = document.querySelector(".closure-card")!;
    expect(card.className).not.toContain("failed");
    expect(card.textContent).toContain("done summary");
    expect(card.textContent).toContain("reportPath");
    expect(card.textContent).toContain(".helix/runs/x/report.md");
    expect(card.textContent).toContain("T9");
    const foot = document.querySelector(".d-foot")!;
    expect(foot.textContent).toContain(".helix/runs/x/report.md");
    expect(foot.textContent).toContain("daemon 单写队列");
  });

  it("queued 实例空 channel：ch-hint 产品空态 + kill 禁用", () => {
    stateRef.current = play([
      welcome,
      spawn("agent-q"),
      ev({ v: 0, type: "agent.queued", payload: { agentId: "agent-q", position: 2 } }),
    ]);
    ui("agent-q");
    expect(screen.getByText(/排队中 · 空位释放后自动开始执行/)).toBeTruthy();
    expect(document.querySelector(".ch-msg")).toBeNull();
    const killBtn = screen.getByRole("button", { name: "终止实例" }) as HTMLButtonElement;
    expect(killBtn.disabled).toBe(true);
  });

  it("实例切换全量重渲染：换 agentId 后无前一实例残留", () => {
    stateRef.current = play([...runningScenario(), spawn("agent-b"), saMsg("agent-b", "mb", "assistant", "B reply")]);
    const { rerender } = ui("agent-run");
    expect(screen.getByText("SA full reply")).toBeTruthy();
    rerender(
      <I18nProvider>
        <ToastProvider>
          <SubagentDrawer agentId="agent-b" onClose={vi.fn()} />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(screen.queryByText("SA full reply")).toBeNull();
    expect(screen.queryByText("steer injection text")).toBeNull();
    expect(screen.getByText("B reply")).toBeTruthy();
  });
});

// ── kill 两步状态机 ────────────────────────────────────────

describe("kill 两步（F1.2）", () => {
  /** 只 fake setTimeout（React 18 调度依赖 setImmediate/MessageChannel，全量 fake 会冻结渲染）*/
  const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  it("首击进入确认态；3s 未确认自动复原；再击发 agent.kill 并复原", () => {
    fakeTimers();
    stateRef.current = play(runningScenario());
    ui("agent-run");
    const btn = screen.getByRole("button", { name: "终止实例" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    const confirmBtn = screen.getByRole("button", { name: "确认终止？" }) as HTMLButtonElement;
    expect(confirmBtn.className).toContain("confirm");
    // 3s 未确认 → 自动复原（fake timer 回调内的 setState 需 act flush）
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByRole("button", { name: "终止实例" })).toBeTruthy();
    // 再走两步：确认后即发命令并复原
    fireEvent.click(screen.getByRole("button", { name: "终止实例" }));
    fireEvent.click(screen.getByRole("button", { name: "确认终止？" }));
    expect(killInstance).toHaveBeenCalledWith("agent-run");
    expect(killInstance).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "终止实例" })).toBeTruthy();
  });

  it("终态禁用优先于确认态：确认中实例转终态 → 按钮禁用且复原", () => {
    fakeTimers();
    stateRef.current = play(runningScenario());
    const { rerender } = ui("agent-run");
    fireEvent.click(screen.getByRole("button", { name: "终止实例" }));
    expect(screen.getByRole("button", { name: "确认终止？" })).toBeTruthy();
    // agent.killed 到达（同一状态源）：状态 chip failed + terminated 行 + closure failed 卡
    stateRef.current = play([...runningScenario(), kill("agent-run")]);
    rerender(
      <I18nProvider>
        <ToastProvider>
          <SubagentDrawer agentId="agent-run" onClose={vi.fn()} />
        </ToastProvider>
      </I18nProvider>,
    );
    const btn = screen.getByRole("button", { name: "终止实例" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(document.querySelector(".d-status.failed")).toBeTruthy();
    expect(document.querySelector(".lc-row.err")!.textContent).toContain("terminated");
    const closureCard = document.querySelector(".closure-card.failed")!;
    expect(closureCard.textContent).toContain("terminated by user");
    expect(screen.queryByText("确认终止？")).toBeNull();
  });

  it("done 实例 kill 禁用", () => {
    stateRef.current = play([...runningScenario(), complete("agent-run")]);
    ui("agent-run");
    const btn = screen.getByRole("button", { name: "终止实例" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

// ── stalled 徽标（F1.8） ───────────────────────────────────

describe("stalled 徽标（F1.8）", () => {
  it("仅 running 显示（idle 时长）；活动恢复隐藏；终态强制隐藏", () => {
    // running + stalled → 显示
    stateRef.current = play([...runningScenario(), stall("agent-run", 372_000)]);
    const { rerender } = ui("agent-run");
    const badge = document.querySelector(".d-stalled")!;
    expect(badge.textContent).toContain("stalled · idle");
    expect(badge.textContent).toMatch(/6m|372/);
    // 活动恢复（delta 清 stalledMs）→ 隐藏
    stateRef.current = play([...runningScenario(), stall("agent-run", 372_000), saDelta("agent-run", "m-3", "active again")]);
    rerender(
      <I18nProvider>
        <ToastProvider>
          <SubagentDrawer agentId="agent-run" onClose={vi.fn()} />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(document.querySelector(".d-stalled.show")).toBeNull();
    // 终态 → 强制隐藏
    stateRef.current = play([...runningScenario(), stall("agent-run", 372_000), kill("agent-run")]);
    rerender(
      <I18nProvider>
        <ToastProvider>
          <SubagentDrawer agentId="agent-run" onClose={vi.fn()} />
        </ToastProvider>
      </I18nProvider>,
    );
    expect(document.querySelector(".d-stalled.show")).toBeNull();
    // 无倒计时/自动终止：stalled 后 channel 仍只有事件驱动的行
    const lcRows = document.querySelectorAll(".lc-row").length;
    expect(lcRows).toBeGreaterThanOrEqual(3); // spawned/模型解析/terminated（无自动终止行）
  });
});

// ── 滚动语义（stick-to-bottom 用户意图感知） ──────────────────

describe("滚动语义（用户意图感知贴底）", () => {
  /** jsdom 无布局：在 .d-body 实例上覆写 scrollHeight/clientHeight 驱动滚动数学。 */
  function fakeScrollGeom(el: HTMLElement, scrollH: number, clientH: number) {
    Object.defineProperty(el, "scrollHeight", { value: scrollH, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: clientH, configurable: true });
  }

  const rerenderDrawer = (rerender: (node: React.ReactElement) => void) =>
    rerender(
      <I18nProvider>
        <ToastProvider>
          <SubagentDrawer agentId="agent-run" onClose={vi.fn()} />
        </ToastProvider>
      </I18nProvider>,
    );

  it("贴底时新内容自动跟随；用户上滚后流式新内容不再拽回底部（scrollTop 保持）", () => {
    stateRef.current = play(runningScenario());
    const { rerender } = ui("agent-run");
    const el = document.querySelector(".d-body") as HTMLDivElement;
    fakeScrollGeom(el, 2000, 600);
    // 初始贴底态（atBottomRef 缺省 true）→ 新事件到达 → 跟随贴底
    stateRef.current = play([...runningScenario(), saDelta("agent-run", "m-1", " first tail")]);
    rerenderDrawer(rerender);
    expect(el.scrollTop).toBe(2000);
    // 用户上滚浏览历史（距底 1100 > 40 容差）→ 暂停跟随
    el.scrollTop = 300;
    fireEvent.scroll(el);
    // 流式增量继续到达（stream.text 高频变更）→ 不打扰用户浏览位置
    stateRef.current = play([
      ...runningScenario(),
      saDelta("agent-run", "m-1", " first tail"),
      saDelta("agent-run", "m-1", " second tail"),
    ]);
    rerenderDrawer(rerender);
    expect(el.scrollTop).toBe(300);
  });

  it("回到底部（距底 ≤40px 容差）后恢复自动跟随", () => {
    stateRef.current = play(runningScenario());
    const { rerender } = ui("agent-run");
    const el = document.querySelector(".d-body") as HTMLDivElement;
    fakeScrollGeom(el, 2000, 600);
    el.scrollTop = 300;
    fireEvent.scroll(el); // 上滚 → 暂停
    el.scrollTop = 1970; // 距底 30 ≤ 40 → 恢复贴底判定
    fireEvent.scroll(el);
    stateRef.current = play([...runningScenario(), saDelta("agent-run", "m-1", " tail")]);
    rerenderDrawer(rerender);
    expect(el.scrollTop).toBe(2000);
  });
});
