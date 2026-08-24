// @vitest-environment jsdom
/**
 * 统计徽标 + usage popover 测试（F3.3/F3.4；test-design §2.3）。
 *
 * - deriveUsageRows：行投影纯函数（main + instances join + compaction 独立行；
 *   done 行 cache sub / main 行 reasoning sub / compaction 行 compactSub），
 *   mock 帧驱动 reducer 状态（welcome、agent 事件族、usage.recorded、compaction.completed）；
 * - 徽标：fmtTokens 档位渲染（档位边界已由 format.test.ts 守护）、值变更 flash
 *   层挂载、流式中冻结（delta 不触碰 usage → 值不变无 flash）；
 * - popover 开合状态机：点外部 / Esc 关闭、徽标点击交给 toggle 不误关、
 *   SubAgent 行 onOpenInstance 回调（T4.3 占位）、compaction 行锚点滚动；
 * - 数字自洽：Σ行 tokens/cost = 徽标值 = state.usage.total（单一状态源）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/shared/i18n";
import type { EventEnvelope, UsageDto } from "@helix/protocol";
import { createInitialSessionState, sessionReducer, type SessionState } from "@/entities/session/model/session-reducer";

// ── SessionContext mock（state 注入；selectIsGenerating 等保持真体）──
const stateRef: { current: SessionState } = { current: createInitialSessionState() };
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return { ...orig, useSession: () => ({ state: stateRef.current }) };
});

import { StatsBadge, UsagePopover, deriveUsageRows } from "./SessionStats";

// ── mock 帧驱动（契约 protocol-v0.1 §5/§6 形状）──────────────

function play(events: EventEnvelope[]): SessionState {
  return events.reduce(
    (s, e) => sessionReducer(s, { type: "event", event: e }),
    createInitialSessionState(),
  );
}

const welcome: EventEnvelope = {
  v: 0,
  type: "connection.welcome",
  payload: { sessionId: "s1", model: "claude-sonnet-4-5", agentState: "idle" },
};

function usage(over: Partial<UsageDto> = {}): UsageDto {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0, ...over };
}

/** 剧本：main turn + agent-1 done turn + compaction 入账（原型 INSTANCES 口径子集）。 */
const SCENARIO: EventEnvelope[] = [
  welcome,
  { v: 0, type: "agent.spawned", payload: { agentId: "agent-1", task: "补齐单测", profileKind: "subagent-worker" } },
  { v: 0, type: "agent.completed", payload: { agentId: "agent-1", closure: { status: "done", summary: "14 例全绿", reportPath: null, findings: null, taskId: null } } },
  { v: 0, type: "usage.recorded", payload: { instanceId: "main", usage: usage({ reasoning: 8_400, totalTokens: 512_000, cost: 0.31 }), source: "turn" } },
  { v: 0, type: "usage.recorded", payload: { instanceId: "agent-1", usage: usage({ cacheRead: 89_000, cacheWrite: 12_000, totalTokens: 284_000, cost: 0.19 }), source: "turn" } },
  {
    v: 0,
    type: "compaction.completed",
    payload: {
      entry: {
        kind: "compaction",
        id: "compact-1",
        instanceId: "main",
        tokensBefore: 340_000,
        tokensAfter: 20_000,
        summary: "会话前段摘要",
        usage: usage({ totalTokens: 32_000, cost: 0.11 }),
        createdAt: new Date(2026, 7, 16, 14, 5).toISOString(),
      },
    },
  },
  { v: 0, type: "usage.recorded", payload: { instanceId: "main", usage: usage({ totalTokens: 32_000, cost: 0.11 }), source: "compaction" } },
];

function ui(node: React.ReactElement) {
  return render(<I18nProvider>{node}</I18nProvider>);
}

afterEach(cleanup);

// jsdom navigator.language 默认 en-US：钉 zh-CN（产品断言语言，AG-14 白名单键）
localStorage.setItem("helix-lang", "zh-CN");

// ── deriveUsageRows（纯函数）──────────────────────────────

describe("deriveUsageRows（F3.4 行投影）", () => {
  it("初始态：仅 main 行（idle、零账、无 sub）", () => {
    const rows = deriveUsageRows(play([welcome]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "main", chip: "idle", tokens: 0, cost: 0 });
    expect(rows[0]!.sub).toBeUndefined();
  });

  it("main + done 实例 + compaction 独立行：kind/chip/sub/model 继承与顺序", () => {
    const rows = deriveUsageRows(play(SCENARIO));
    expect(rows.map((r) => r.id)).toEqual(["main", "agent-1", "compaction"]);
    const [main, agent, compact] = rows;
    // main：reasoning sub（Q-11③）；model 未声明继承会话模型（AD-6）
    expect(main!.sub).toEqual({ key: "reasoningSub", vars: { n: "8k" } });
    expect(main!.model).toBe("claude-sonnet-4-5");
    // agent-1：done chip + cache R/W sub + 抽屉行尾动作
    expect(agent).toMatchObject({ chip: "done", chipLabel: "done", tokens: 284_000, cost: 0.19 });
    expect(agent!.sub).toEqual({ key: "cacheSub", vars: { r: "89k", w: "12k" } });
    expect(agent!.action).toEqual({ type: "drawer", instanceId: "agent-1" });
    // compaction：账目小计 + 最近里程碑归属说明 + 锚点滚动动作
    expect(compact).toMatchObject({ chip: "done", tokens: 32_000, cost: 0.11 });
    expect(compact!.sub).toEqual({ key: "compactSub", vars: { before: "340k", after: "20k" } });
    expect(compact!.action).toEqual({ type: "compaction" });
  });

  it("数字自洽：Σ实例行 tokens/cost = 徽标值（state.usage.total，单一状态源）", () => {
    // 【口径统一修正，AF-2/T3.1】compaction 计入实例小计（对齐 daemon，
    // AD-9③）后，Σ求和面 = 实例行（main 行含 compaction 贡献）；compaction
    // 行是 main 行的子集视图（信息行），不再叠加进 Σ（否则双计）。
    const s = play(SCENARIO);
    const rows = deriveUsageRows(s);
    const instanceRows = rows.filter((r) => r.id !== "compaction");
    const sumTokens = instanceRows.reduce((a, r) => a + r.tokens, 0);
    const sumCost = instanceRows.reduce((a, r) => a + r.cost, 0);
    expect(sumTokens).toBe(s.usage.total.totalTokens); // 828_000（main 544k 含 compaction 32k + agent 284k）
    expect(sumCost).toBeCloseTo(s.usage.total.cost, 10); // 0.61
    // compaction 行 = 独立小计（⊆ total，不再与实例行求和叠加）
    const compactRow = rows.find((r) => r.id === "compaction")!;
    expect(compactRow.tokens).toBe(s.usage.compaction.totalTokens); // 32_000
  });

  it("running 实例无 cache sub（done 行专属）；compaction 未发生 → 无独立行", () => {
    const s = play([
      welcome,
      { v: 0, type: "agent.spawned", payload: { agentId: "agent-2", task: "扫描", profileKind: "subagent-worker" } },
      { v: 0, type: "usage.recorded", payload: { instanceId: "agent-2", usage: usage({ cacheRead: 1_000, cacheWrite: 500, totalTokens: 4_000, cost: 0.01 }), source: "turn" } },
    ]);
    const rows = deriveUsageRows(s);
    expect(rows.map((r) => r.id)).toEqual(["main", "agent-2"]);
    expect(rows[1]!.chip).toBe("running");
    expect(rows[1]!.sub).toBeUndefined();
  });

  it("T10c 新形态：快照习得主实例 id（kind=main）→ main 行按 agent-<hex> 取账与展示", () => {
    // 写侧现行契约：main 实例 id = agent-<唯一串>（usage.recorded 同 id 入账）；
    // 快照 instances kind=main 条目是 shell 习得源，main 行 id/账目跟随实际 id
    const mainId = "agent-m1";
    const s = play([
      welcome,
      {
        v: 0,
        type: "session.snapshot",
        payload: {
          snapshot: {
            sessionId: "s1",
            model: "claude-sonnet-4-5",
            agentState: "idle",
            revision: 1,
            entries: [],
            instances: [
              { instanceId: mainId, kind: "main", profileKind: "main-session", state: "running", createdAt: "2026-08-16T14:00:00.000Z" },
            ],
          },
        },
      },
      { v: 0, type: "usage.recorded", payload: { instanceId: mainId, usage: usage({ reasoning: 8_400, totalTokens: 512_000, cost: 0.31 }), source: "turn" } },
    ]);
    const rows = deriveUsageRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: mainId, main: true, tokens: 512_000, cost: 0.31 });
    expect(rows[0]!.sub).toEqual({ key: "reasoningSub", vars: { n: "8k" } });
  });
});

// ── StatsBadge（F3.3）─────────────────────────────────────

describe("StatsBadge（F3.3 徽标）", () => {
  it("初始渲染 0 tok · $0.00；无 flash 层", () => {
    stateRef.current = play([welcome]);
    ui(<StatsBadge open={false} onToggle={() => {}} />);
    expect(screen.getByText("0 tok · $0.00")).toBeTruthy();
    expect(document.querySelector(".sb-flash")).toBeNull();
  });

  it("usage.recorded 到达 → 值刷新（828k tok · $0.61）+ flash 辉光层挂载", () => {
    stateRef.current = play([welcome]);
    const { rerender } = ui(<StatsBadge open={false} onToggle={() => {}} />);
    stateRef.current = play(SCENARIO);
    rerender(<I18nProvider><StatsBadge open={false} onToggle={() => {}} /></I18nProvider>);
    expect(screen.getByText("828k tok · $0.61")).toBeTruthy();
    expect(document.querySelector('[data-flash="on"]')).not.toBeNull();
  });

  it("流式中冻结：delta 到达但 usage 槽位不变 → 徽标值与 flash 均不变", () => {
    stateRef.current = play(SCENARIO);
    const { rerender } = ui(<StatsBadge open={false} onToggle={() => {}} />);
    const before = screen.getByText("828k tok · $0.61").textContent;
    // 流式 delta（含主线 chat 流与 thinking 流）不触碰 usage（reducer 冻结保证）
    stateRef.current = play([
      ...SCENARIO,
      { v: 0, type: "chat.stream.delta", payload: { messageId: "m1", delta: "回复中" } },
      { v: 0, type: "thinking.stream.delta", payload: { instanceId: "main", delta: "思考中" } },
    ]);
    rerender(<I18nProvider><StatsBadge open={false} onToggle={() => {}} /></I18nProvider>);
    expect(screen.getByText("828k tok · $0.61").textContent).toBe(before);
    expect(document.querySelector('[data-flash="on"]')).toBeNull();
  });

  it("aria-expanded 随 open prop 维护", () => {
    stateRef.current = play([welcome]);
    ui(<StatsBadge open onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: /tok/ }).getAttribute("aria-expanded")).toBe("true");
  });
});

// ── UsagePopover（F3.4；开合状态机）───────────────────────

describe("UsagePopover（F3.4 popover）", () => {
  it("行结构渲染：标题/合计/行 id·kind·model·tokens·cost/chip 文案/sub 行", () => {
    stateRef.current = play(SCENARIO);
    ui(<UsagePopover onClose={() => {}} />);
    expect(screen.getByText("会话账目 · 分实例")).toBeTruthy();
    expect(screen.getByText("828k tok · $0.61", { selector: ".sp-title .total" })).toBeTruthy();
    // main 行（div，无动作）与 compaction 归属说明
    expect(document.querySelector('[data-row-id="main"]')!.textContent).toContain("主会话");
    expect(document.querySelector('[data-row-id="main"]')!.textContent).toContain("空闲");
    expect(screen.getByText("reasoning 8k")).toBeTruthy();
    expect(screen.getByText("cache R 89k · W 12k")).toBeTruthy();
    expect(screen.getByText("main 340k→20k")).toBeTruthy();
    expect(screen.getByText(/turn 完成时刷新 · 流式中账面冻结/)).toBeTruthy();
  });

  it("点外部关闭（document click）；Esc 关闭", () => {
    stateRef.current = play([welcome]);
    const onClose = vi.fn();
    ui(<UsagePopover onClose={onClose} />);
    fireEvent.click(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(document, { key: "a" });
    expect(onClose).toHaveBeenCalledTimes(2); // 非 Esc 不关
  });

  it("徽标自身点击交给 toggle：.stats-btn 命中不触发关闭", () => {
    stateRef.current = play([welcome]);
    const onClose = vi.fn();
    ui(<UsagePopover onClose={onClose} />);
    const badge = document.createElement("button");
    badge.className = "stats-btn";
    document.body.appendChild(badge);
    try {
      fireEvent.click(badge);
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      badge.remove();
    }
  });

  it("SubAgent 行尾跳转回调：onOpenInstance(agentId) + 关闭（T4.3 占位接线）", () => {
    stateRef.current = play(SCENARIO);
    const onOpenInstance = vi.fn();
    const onClose = vi.fn();
    ui(<UsagePopover onClose={onClose} onOpenInstance={onOpenInstance} />);
    fireEvent.click(screen.getByRole("button", { name: /agent-1/ }));
    expect(onOpenInstance).toHaveBeenCalledWith("agent-1");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("compaction 行尾锚点滚动：scrollIntoView 到最后一条 compaction 里程碑条", () => {
    stateRef.current = play(SCENARIO);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const anchor = document.createElement("div");
    anchor.className = "fb-wrap";
    anchor.dataset.kind = "compaction";
    document.body.appendChild(anchor);
    try {
      ui(<UsagePopover onClose={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /compaction/ }));
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      anchor.remove();
    }
  });
});
