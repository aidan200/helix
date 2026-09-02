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
import type { CatalogModel, EventEnvelope, UsageDto } from "@helix/protocol";
import { createInitialSessionState, sessionReducer, type SessionState } from "@/entities/session/model/session-reducer";

// ── SessionContext mock（state 注入；selectIsGenerating 等保持真体）──
const stateRef: { current: SessionState } = { current: createInitialSessionState() };
// 模型目录常驻（UsagePopover 从 topology.modelConfig.catalog 注入 deriveUsageRows）
const topologyRef = {
  current: { modelConfig: { catalog: { models: [] as CatalogModel[] } } },
};
vi.mock("@/entities/session/SessionContext", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/entities/session/SessionContext")>();
  return { ...orig, useSession: () => ({ state: stateRef.current, topology: topologyRef.current }) };
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

/** 目录（contextWindow 分母面）：main 会话 200k 窗 · agent-1 模型 400k 窗。 */
function catalogModel(id: string, contextWindow: number): CatalogModel {
  return {
    id,
    providerId: id.split("/")[0]!,
    contextWindow,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    source: "builtin",
    reasoning: true,
    thinkingLevels: [],
  };
}
const CATALOG: CatalogModel[] = [
  catalogModel("anthropic/claude-sonnet-4-5", 200_000),
  catalogModel("openai/gpt-5-mini", 400_000),
];

/** 剧本：main turn（水位 142k）+ agent-1 done turn（水位 96k）+ compaction
 *  （main 归位 20k）+ 摘要调用入账（不覆盖水位）。 */
const SCENARIO: EventEnvelope[] = [
  welcome,
  { v: 0, type: "agent.spawned", payload: { agentId: "agent-1", task: "补齐单测", profileKind: "subagent-worker", model: "openai/gpt-5-mini" } },
  { v: 0, type: "agent.completed", payload: { agentId: "agent-1", closure: { status: "done", summary: "14 例全绿", reportPath: null, findings: null, taskId: null } } },
  { v: 0, type: "usage.recorded", payload: { instanceId: "main", usage: usage({ reasoning: 8_400, totalTokens: 142_000, cost: 0.31 }), source: "turn" } },
  { v: 0, type: "usage.recorded", payload: { instanceId: "agent-1", usage: usage({ cacheRead: 89_000, cacheWrite: 12_000, totalTokens: 96_000, cost: 0.19 }), source: "turn" } },
  {
    v: 0,
    type: "compaction.completed",
    payload: {
      entry: {
        kind: "compaction",
        id: "compact-1",
        instanceId: "main",
        tokensBefore: 150_000,
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
  it("初始态：仅 main 行（idle、零账、无 sub、无上下文占比）", () => {
    const rows = deriveUsageRows(play([welcome]), CATALOG);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "main", chip: "idle", tokens: 0, cost: 0 });
    expect(rows[0]!.pct).toBeUndefined(); // 无水位 → 无占比
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
    expect(agent).toMatchObject({ chip: "done", chipLabel: "done", tokens: 96_000, cost: 0.19 });
    expect(agent!.model).toBe("openai/gpt-5-mini"); // spawn 声明模型（分母 = 自身窗口）
    expect(agent!.sub).toEqual({ key: "cacheSub", vars: { r: "89k", w: "12k" } });
    expect(agent!.action).toEqual({ type: "drawer", instanceId: "agent-1" });
    // compaction：账目小计 + 最近里程碑归属说明 + 锚点滚动动作
    expect(compact).toMatchObject({ chip: "done", tokens: 32_000, cost: 0.11 });
    expect(compact!.sub).toEqual({ key: "compactSub", vars: { before: "150k", after: "20k" } });
    expect(compact!.action).toEqual({ type: "compaction" });
  });

  it("上下文占用比：pct = 水位/行模型窗口（各模型独立分母）；compaction 行无 pct", () => {
    const rows = deriveUsageRows(play(SCENARIO), CATALOG);
    const [main, agent, compact] = rows;
    // main：turn 水位 142k → compaction.completed 归位 tokensAfter 20k（200k 窗 → 10%）；
    // 随后的 usage.recorded(source=compaction) 不覆盖水位
    expect(main!.pct).toBeCloseTo((20_000 / 200_000) * 100, 6); // 10%
    expect(main).toMatchObject({ ctxTokens: 20_000, ctxWindow: 200_000 });
    // agent-1：水位 96k（最近 turn totalTokens）÷ 自身模型 400k 窗 → 24%（与会话模型分母无关）
    expect(agent!.pct).toBeCloseTo((96_000 / 400_000) * 100, 6); // 24%
    expect(agent).toMatchObject({ ctxTokens: 96_000, ctxWindow: 400_000 });
    // compaction 行 = 账目子集视图，上下文口径不适用
    expect(compact!.pct).toBeUndefined();
  });

  it("降级：目录未注入/模型不在目录/水位未知 → pct undefined", () => {
    const s = play(SCENARIO);
    // 目录未注入（catalog 未拉取）：全行降级
    for (const r of deriveUsageRows(s)) expect(r.pct).toBeUndefined();
    // 模型不在目录（main 会话模型无目录条目）：main 降级，agent-1 正常
    const rows = deriveUsageRows(s, [CATALOG[1]!]);
    expect(rows[0]!.pct).toBeUndefined();
    expect(rows[1]!.pct).toBeCloseTo(24, 6);
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
    expect(sumTokens).toBe(s.usage.total.totalTokens); // 270_000（main 174k 含 compaction 32k + agent 96k）
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

  it("快照恢复兜底：最后一条 compaction entry 的 tokensAfter → main 水位（重连后无 turn 前可显示）", () => {
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
            entries: [
              {
                kind: "compaction",
                id: "compact-1",
                instanceId: "main",
                tokensBefore: 150_000,
                tokensAfter: 24_000,
                summary: "前段摘要",
                usage: usage({ totalTokens: 32_000, cost: 0.11 }),
                createdAt: "2026-08-16T14:05:00.000Z",
              },
            ],
            instances: [
              { instanceId: "main", kind: "main", profileKind: "main-session", state: "running", createdAt: "2026-08-16T14:00:00.000Z" },
            ],
          },
        },
      },
    ]);
    const rows = deriveUsageRows(s, CATALOG);
    expect(rows[0]!.pct).toBeCloseTo((24_000 / 200_000) * 100, 6); // 12%
    expect(rows[0]).toMatchObject({ ctxTokens: 24_000, ctxWindow: 200_000 });
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
    expect(screen.getByText("270k tok · $0.61")).toBeTruthy();
    expect(document.querySelector('[data-flash="on"]')).not.toBeNull();
  });

  it("流式中冻结：delta 到达但 usage 槽位不变 → 徽标值与 flash 均不变", () => {
    stateRef.current = play(SCENARIO);
    const { rerender } = ui(<StatsBadge open={false} onToggle={() => {}} />);
    const before = screen.getByText("270k tok · $0.61").textContent;
    // 流式 delta（含主线 chat 流与 thinking 流）不触碰 usage（reducer 冻结保证）
    stateRef.current = play([
      ...SCENARIO,
      { v: 0, type: "chat.stream.delta", payload: { messageId: "m1", delta: "回复中" } },
      { v: 0, type: "thinking.stream.delta", payload: { instanceId: "main", delta: "思考中" } },
    ]);
    rerender(<I18nProvider><StatsBadge open={false} onToggle={() => {}} /></I18nProvider>);
    expect(screen.getByText("270k tok · $0.61").textContent).toBe(before);
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
    topologyRef.current = { modelConfig: { catalog: { models: CATALOG } } };
    ui(<UsagePopover onClose={() => {}} />);
    expect(screen.getByText("会话账目 · 分实例")).toBeTruthy();
    // 头部概要：会话合计 + 当前会话 agent（main）的窗口占用（剧本 main 10%）
    const totalEl = document.querySelector(".sp-title .total")!;
    expect(totalEl.textContent).toContain("270k tok · $0.61");
    expect(totalEl.textContent).toContain("ctx 10%");
    expect(document.querySelector(".sp-title .total .ctx")!.getAttribute("title")).toBe("20k / 200k");
    // main 行（div，无动作）与 compaction 归属说明
    expect(document.querySelector('[data-row-id="main"]')!.textContent).toContain("主会话");
    expect(document.querySelector('[data-row-id="main"]')!.textContent).toContain("空闲");
    // 每行上下文占用比（水位/行模型窗口）：main 10%（compaction 归位 20k/200k）·
    // agent-1 24%（96k/400k）· compaction 行降级 “—”；title 携带分子/分母
    expect(document.querySelector('[data-row-id="main"]')!.textContent).toContain("10%");
    expect(document.querySelector('[data-row-id="main"] .pct')!.getAttribute("title")).toBe("20k / 200k");
    expect(document.querySelector('[data-row-id="agent-1"]')!.textContent).toContain("24%");
    expect(document.querySelector('[data-row-id="agent-1"] .pct')!.getAttribute("title")).toBe("96k / 400k");
    expect(document.querySelector('[data-row-id="compaction"] .pct')!.textContent).toBe("—");
    expect(screen.getByText("reasoning 8k")).toBeTruthy();
    expect(screen.getByText("cache R 89k · W 12k")).toBeTruthy();
    expect(screen.getByText("main 150k→20k")).toBeTruthy();
  });

  it("降级：目录未拉取 → 头部不显示 ctx（保持合计干净）", () => {
    stateRef.current = play(SCENARIO);
    topologyRef.current = { modelConfig: { catalog: { models: [] } } };
    ui(<UsagePopover onClose={() => {}} />);
    expect(document.querySelector(".sp-title .total")!.textContent).toBe("270k tok · $0.61");
    expect(document.querySelector(".sp-title .total .ctx")).toBeNull();
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
