/**
 * session-reducer v0.1 投影测试（契约 protocol-v0.1.md §7 前端投影约定；CL-1）。
 *
 * 机械判据（test-design §2.1 F1.1 shell unit 行 + §1.1 unit-⑧）：
 * ① agent.* 状态机：四态互斥单值 / 终态吸收（不回 running）/ 重派 = 新 agentId
 *    新卡并存（F1.9）/ queued 位次只消费事件重发 / stalled 非状态迁移；
 * ② instanceId 分流（缺省 = main）：main 进消息流；SubAgent delta 只更新
 *    卡片 streaming 摘要尾窗；SubAgent 消息/工具不进主消息流（F1.6）；
 * ③ thinking/compaction/usage 状态槽位：thinking 流式累积与 completed 落账、
 *    账目仅由 usage.recorded/快照驱动（流式冻结、entry.usage 不双计）；
 * ④ 快照 additive：instances 重建卡片（含 cancelled 恢复态，AD-10）、usage
 *    重建账目、新 kind entries 入流；
 * ⑤ 重放幂等：同序列重放深度相等；前缀 + daemon 快照 + 增量 = 纯重放。
 */
import { describe, expect, it } from "vitest";
import type {
  AgentInstanceDto,
  ClosureDto,
  CompactionEntryDto,
  EntryDto,
  EventEnvelope,
  InstanceState,
  MessageEntryDto,
  SessionSnapshotDto,
  ThinkingEntryDto,
  UsageDto,
} from "@helix/protocol";
import {
  createInitialSessionState,
  sessionReducer,
  type SessionAction,
  type SessionState,
} from "./session-reducer";

// ── 构造工具（mock 帧直引 @helix/protocol 类型）──────────────

function ev(event: EventEnvelope): SessionAction {
  return { type: "event", event };
}

function msg(id: string, role: "user" | "assistant", content: string, ts: number): MessageEntryDto {
  return { kind: "message", id, role, content, ts };
}

function closure(status: "done" | "failed", summary: string): ClosureDto {
  return { status, summary, reportPath: null, findings: null, taskId: null };
}

function usage(over: Partial<UsageDto> = {}): UsageDto {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: 0,
    ...over,
  };
}

const welcome = (): SessionAction =>
  ev({
    v: 0,
    type: "connection.welcome",
    payload: { sessionId: "sess-1", model: "claude-sonnet-4-5", agentState: "idle" },
  });

const spawned = (agentId: string, over: Record<string, never> | undefined = undefined): SessionAction =>
  ev({
    v: 0,
    type: "agent.spawned",
    payload: { agentId, task: `task of ${agentId}`, profileKind: "subagent-worker", ...over },
  });

const queued = (agentId: string, position: number): SessionAction =>
  ev({ v: 0, type: "agent.queued", payload: { agentId, position } });

const started = (agentId: string): SessionAction =>
  ev({ v: 0, type: "agent.started", payload: { agentId } });

const stalled = (agentId: string, idleMs: number): SessionAction =>
  ev({ v: 0, type: "agent.stalled", payload: { agentId, idleMs } });

const completed = (agentId: string, cl: ClosureDto): SessionAction =>
  ev({ v: 0, type: "agent.completed", payload: { agentId, closure: cl } });

const failed = (agentId: string, error: string, cl: ClosureDto): SessionAction =>
  ev({ v: 0, type: "agent.failed", payload: { agentId, error, closure: cl } });

const killed = (agentId: string, cl: ClosureDto): SessionAction =>
  ev({ v: 0, type: "agent.killed", payload: { agentId, closure: cl } });

/** SubAgent 实例的 chat delta（信封 instanceId 分流依据，契约 §3）。 */
const saDelta = (instanceId: string, messageId: string, delta: string): SessionAction =>
  ev({
    v: 0,
    type: "chat.stream.delta",
    instanceId,
    payload: { messageId, delta },
  });

const mainDelta = (messageId: string, delta: string): SessionAction =>
  ev({ v: 0, type: "chat.stream.delta", payload: { messageId, delta } });

const usageRecorded = (
  instanceId: string,
  u: UsageDto,
  source: "turn" | "compaction",
): SessionAction => ev({ v: 0, type: "usage.recorded", payload: { instanceId, usage: u, source } });

const thinkDelta = (instanceId: string, delta: string): SessionAction =>
  ev({ v: 0, type: "thinking.stream.delta", payload: { instanceId, delta } });

const thinkCompleted = (entry: ThinkingEntryDto): SessionAction =>
  ev({ v: 0, type: "thinking.completed", payload: { entry } });

const compactionCompleted = (entry: CompactionEntryDto): SessionAction =>
  ev({ v: 0, type: "compaction.completed", payload: { entry } });

function thinkEntry(id: string, instanceId: string, text: string): ThinkingEntryDto {
  return { kind: "thinking", id, instanceId, text, durationMs: 12_000, reasoningTokens: 847, createdAt: "2026-08-16T14:02:00.000Z" };
}

function compactEntry(id: string, instanceId: string, u: UsageDto): CompactionEntryDto {
  return {
    kind: "compaction",
    id,
    instanceId,
    tokensBefore: 340_000,
    tokensAfter: 20_000,
    summary: "会话前段摘要",
    usage: u,
    createdAt: "2026-08-16T14:05:00.000Z",
  };
}

function inst(instanceId: string, state: InstanceState, over: Partial<AgentInstanceDto> = {}): AgentInstanceDto {
  return {
    instanceId,
    kind: instanceId === "main" ? "main" : "subagent",
    profileKind: instanceId === "main" ? "main-session" : "subagent-worker",
    state,
    createdAt: "2026-08-16T14:00:00.000Z",
    ...over,
  };
}

const snapshotOf = (entries: EntryDto[], opts?: Partial<SessionSnapshotDto>): SessionAction =>
  ev({
    v: 0,
    type: "session.snapshot",
    payload: {
      snapshot: {
        sessionId: "sess-1",
        model: "claude-sonnet-4-5",
        agentState: "idle",
        revision: entries.length,
        entries,
        ...opts,
      },
    },
  });

function run(actions: SessionAction[], from?: SessionState): SessionState {
  return actions.reduce(sessionReducer, from ?? createInitialSessionState());
}

const base = (): SessionState => run([welcome(), snapshotOf([])]);

/** 卡片按 instanceId 查找（测试断言便捷面）。 */
function cardOf(s: SessionState, instanceId: string) {
  return s.instances.find((c) => c.instanceId === instanceId);
}

// ── ① agent.* 状态机（四态互斥）──────────────────────────────

describe("F1.1 agent.* 状态机", () => {
  it("spawned 秒回出卡（预算内直跑主路径）；started → running；completed → done（closure 入卡）", () => {
    const s = run([spawned("agent-1"), started("agent-1"), completed("agent-1", closure("done", "单测补齐完成"))], base());
    const card = cardOf(s, "agent-1");
    expect(card).toBeDefined();
    expect(card?.state).toBe("done");
    expect(card?.closure).toEqual(closure("done", "单测补齐完成"));
    expect(s.instances).toHaveLength(1); // 单卡单值（互斥由 state 单字段承载）
  });

  it("超限路径：spawned 后 agent.queued 带 position；位次随出队重发递减（只消费事件，不自行计算）", () => {
    const s = run([spawned("agent-5"), queued("agent-5", 2)], base());
    expect(cardOf(s, "agent-5")?.state).toBe("queued");
    expect(cardOf(s, "agent-5")?.queuedPosition).toBe(2);
    const dec = run([queued("agent-5", 1)], s);
    expect(cardOf(dec, "agent-5")?.queuedPosition).toBe(1);
    const out = run([queued("agent-5", 1), started("agent-5")], dec);
    expect(cardOf(out, "agent-5")?.state).toBe("running");
  });

  it("stalled 非状态迁移：仍 running，可再次发生（idleMs 更新）", () => {
    const s = run([spawned("agent-2"), stalled("agent-2", 30_000)], base());
    expect(cardOf(s, "agent-2")?.state).toBe("running");
    expect(cardOf(s, "agent-2")?.stalledMs).toBe(30_000);
    const again = run([stalled("agent-2", 60_000)], s);
    expect(cardOf(again, "agent-2")?.state).toBe("running");
    expect(cardOf(again, "agent-2")?.stalledMs).toBe(60_000);
  });

  it("终态吸收：completed 后迟到的 started/queued/stalled/failed 不改 done（终态不回 running）", () => {
    const done = run(
      [spawned("agent-1"), completed("agent-1", closure("done", "完成"))],
      base(),
    );
    const late = run(
      [
        started("agent-1"),
        queued("agent-1", 1),
        stalled("agent-1", 9_000),
        failed("agent-1", "late crash", closure("failed", "迟到失败")),
      ],
      done,
    );
    const card = cardOf(late, "agent-1");
    expect(card?.state).toBe("done");
    expect(card?.closure).toEqual(closure("done", "完成"));
    expect(card?.stalledMs).toBeUndefined();
  });

  it("failed：error 与 closure 入卡；killed：failed 态 + terminated 交代标记（不设第五态）", () => {
    const crashed = run(
      [spawned("agent-4"), failed("agent-4", "子进程异常退出 · exit 137", closure("failed", "崩溃隔离"))],
      base(),
    );
    expect(cardOf(crashed, "agent-4")?.state).toBe("failed");
    expect(cardOf(crashed, "agent-4")?.error).toBe("子进程异常退出 · exit 137");

    const userKilled = run(
      [spawned("agent-3"), killed("agent-3", closure("failed", "用户终止"))],
      base(),
    );
    expect(cardOf(userKilled, "agent-3")?.state).toBe("failed");
    expect(cardOf(userKilled, "agent-3")?.terminated).toBe(true);
  });

  it("重派 = 新 agentId 新卡并存（F1.9 非线性红线：实例不复活）", () => {
    const s = run(
      [
        spawned("agent-1"),
        completed("agent-1", closure("done", "旧实例交付")),
        spawned("agent-6"),
        started("agent-6"),
      ],
      base(),
    );
    expect(s.instances.map((c) => [c.instanceId, c.state])).toEqual([
      ["agent-1", "done"],
      ["agent-6", "running"],
    ]);
  });

  it("spawn 秒回 toast 槽位：spawned 置位（一次性，UI 消费后置空）", () => {
    const s = run([spawned("agent-6")], base());
    expect(s.spawnToast).toEqual({ instanceId: "agent-6", profileKind: "subagent-worker" });
    const consumed = run([{ type: "ui/consume-spawn-toast" }], s);
    expect(consumed.spawnToast).toBeNull();
  });
});

// ── ② instanceId 分流（缺省 = main）─────────────────────────

describe("instanceId 分流（§7 主线/实例分流）", () => {
  it("SubAgent delta 只进卡片 streaming 摘要尾窗（滚动截断 120 字），主线 streaming 不受扰", () => {
    const s0 = run([spawned("agent-2"), started("agent-2")], base());
    const s1 = run([saDelta("agent-2", "m-sa", "tokens.css 26 个色彩变量双主题逐档换算中")], s0);
    expect(s1.streaming).toBeNull(); // 主消息流零混入
    expect(cardOf(s1, "agent-2")?.streamSummary).toBe("tokens.css 26 个色彩变量双主题逐档换算中");

    const long = "x".repeat(200);
    const s2 = run([saDelta("agent-2", "m-sa", long)], s1);
    expect(cardOf(s2, "agent-2")?.streamSummary).toHaveLength(120); // 尾窗截断
    expect(cardOf(s2, "agent-2")?.streamSummary.startsWith("x")).toBe(true);
  });

  it("SubAgent chat.message.completed 定稿摘要、不进主消息流 entries", () => {
    const s0 = run([spawned("agent-2"), started("agent-2"), saDelta("agent-2", "m-sa", "流式中…")], base());
    const done = run(
      [
        ev({
          v: 0,
          type: "chat.message.completed",
          instanceId: "agent-2",
          payload: {
            entry: { ...msg("m-sa", "assistant", "最终回复全文（定稿摘要取其尾窗）", 7), instanceId: "agent-2" },
          },
        }),
      ],
      s0,
    );
    expect(done.entries.some((e) => e.id === "m-sa")).toBe(false); // 不进主消息流
    expect(cardOf(done, "agent-2")?.streamSummary).toBe("最终回复全文（定稿摘要取其尾窗）");
  });

  it("SubAgent 工具调用不进主线 entries（F1.6：只进 per-instance）", () => {
    const s = run(
      [
        spawned("agent-2"),
        started("agent-2"),
        ev({
          v: 0,
          type: "tool.call.started",
          instanceId: "agent-2",
          payload: {
            entry: {
              kind: "tool-call",
              id: "tc-sa",
              name: "grep",
              args: "{}",
              state: "running",
              ts: 8,
              instanceId: "agent-2",
            },
          },
        }),
      ],
      base(),
    );
    expect(s.entries).toEqual([]);
  });

  it("main（缺省/显式）delta 与消息照旧进主消息流（既有行为不回归）", () => {
    const implicit = run([mainDelta("t1", "Hel")], base());
    expect(implicit.streaming).toEqual({ messageId: "t1", text: "Hel" });
    const explicit = run(
      [ev({ v: 0, type: "chat.stream.delta", instanceId: "main", payload: { messageId: "t1", delta: "Hel" } })],
      base(),
    );
    expect(explicit.streaming).toEqual({ messageId: "t1", text: "Hel" });
  });

  it("终态实例的迟到 delta 被吸收（摘要保持定稿）", () => {
    const s = run(
      [spawned("agent-1"), completed("agent-1", closure("done", "完成")), saDelta("agent-1", "m-late", "迟到增量")],
      base(),
    );
    expect(cardOf(s, "agent-1")?.streamSummary).toBe("");
  });
});

// ── ③ thinking/compaction/usage 状态槽位（渲染归 T4.2）──────

describe("thinking/compaction/usage 状态槽位", () => {
  it("thinking.stream.delta 按 instanceId 累积（多实例并存）；completed 落 Entry 并清槽", () => {
    const s0 = run(
      [
        thinkDelta("main", "盘点当前态…"),
        thinkDelta("agent-2", "收到 steer…"),
        thinkDelta("main", "这轮回复要交代队列位次。"),
      ],
      base(),
    );
    expect(s0.thinkingStreams["main"]).toBe("盘点当前态…这轮回复要交代队列位次。");
    expect(s0.thinkingStreams["agent-2"]).toBe("收到 steer…");

    const s1 = run([thinkCompleted(thinkEntry("th-1", "main", "全文"))], s0);
    expect(s1.thinkingStreams["main"]).toBeUndefined();
    expect(s1.thinkingStreams["agent-2"]).toBe("收到 steer…"); // 他实例不受扰
    const entry = s1.entries.find((e) => e.id === "th-1");
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("thinking");
  });

  it("compaction.completed 落 Entry（新 kind 入流，渲染归 T4.2）", () => {
    const s = run([compactionCompleted(compactEntry("cp-1", "main", usage({ totalTokens: 32_000, cost: 0.11 })))], base());
    const entry = s.entries.find((e) => e.id === "cp-1");
    expect(entry?.kind).toBe("compaction");
  });

  it("usage 聚合：turn 源累计 per-instance 小计与 total；compaction 源只进 compaction 小计（total = Σ实例 + compaction）", () => {
    // cost 用二进制精确值（0.25/0.5/0.125/0.0625），避开浮点累加噪声
    const s0 = run(
      [
        usageRecorded("main", usage({ totalTokens: 40, cost: 0.25 }), "turn"),
        usageRecorded("agent-1", usage({ totalTokens: 8, cost: 0.5 }), "turn"),
        usageRecorded("main", usage({ totalTokens: 12, cost: 0.125 }), "turn"),
      ],
      base(),
    );
    expect(s0.usage.byInstance["main"]).toEqual(usage({ totalTokens: 52, cost: 0.375 }));
    expect(s0.usage.byInstance["agent-1"]).toEqual(usage({ totalTokens: 8, cost: 0.5 }));
    expect(s0.usage.total).toEqual(usage({ totalTokens: 60, cost: 0.875 }));
    expect(s0.usage.compaction).toEqual(usage());

    const s1 = run(
      [usageRecorded("main", usage({ totalTokens: 32, cost: 0.0625 }), "compaction")],
      s0,
    );
    expect(s1.usage.compaction).toEqual(usage({ totalTokens: 32, cost: 0.0625 }));
    expect(s1.usage.byInstance["main"]).toEqual(usage({ totalTokens: 52, cost: 0.375 })); // 不双计
    expect(s1.usage.total).toEqual(usage({ totalTokens: 92, cost: 0.9375 })); // Σ实例 + compaction
  });

  it("流式中账面冻结：chat/thinking delta 不触碰 usage（仅 usage.recorded/快照驱动）", () => {
    const s0 = run([usageRecorded("main", usage({ totalTokens: 40 }), "turn")], base());
    const streaming = run(
      [
        mainDelta("t1", "长回复增量"),
        thinkDelta("main", "思考增量"),
        saDelta("agent-9", "m-sa", "SubAgent 增量"),
      ],
      s0,
    );
    expect(streaming.usage).toEqual(s0.usage);
  });

  it("compaction.completed 的 entry.usage 不入账（避免与 usage.recorded 双计；账目唯一驱动 = usage.recorded/快照）", () => {
    const s = run([compactionCompleted(compactEntry("cp-1", "main", usage({ totalTokens: 32_000, cost: 0.11 })))], base());
    expect(s.usage.total).toEqual(usage());
    expect(s.usage.compaction).toEqual(usage());
  });
});

// ── ④ 快照 additive 投影（instances/usage/新 kind entries）──

describe("快照 additive 投影", () => {
  it("instances 重建卡片：终态带 closure、queued 带位次、running 复位流式摘要（DTO 无摘要字段）", () => {
    const s = run(
      [
        snapshotOf([], {
          instances: [
            inst("agent-1", "done", { closure: closure("done", "单测补齐完成") }),
            inst("agent-4", "failed", { closure: closure("failed", "崩溃隔离") }),
            inst("agent-5", "queued", { queuedPosition: 1 }),
            inst("agent-2", "running"),
          ],
        }),
      ],
      base(),
    );
    expect(s.instances.map((c) => [c.instanceId, c.state])).toEqual([
      ["agent-1", "done"],
      ["agent-4", "failed"],
      ["agent-5", "queued"],
      ["agent-2", "running"],
    ]);
    expect(cardOf(s, "agent-1")?.closure?.summary).toBe("单测补齐完成");
    expect(cardOf(s, "agent-5")?.queuedPosition).toBe(1);
    expect(cardOf(s, "agent-2")?.streamSummary).toBe("");
  });

  it("cancelled 恢复态（AD-10）：queued 重启收口为 cancelled，区别于 failed", () => {
    const s = run(
      [
        spawned("agent-5"),
        queued("agent-5", 2),
        snapshotOf([], { instances: [inst("agent-5", "cancelled")] }),
      ],
      base(),
    );
    const card = cardOf(s, "agent-5");
    expect(card?.state).toBe("cancelled");
    expect(card?.queuedPosition).toBeUndefined(); // 清队语义
  });

  it("usage 重建账目（快照为权威）；缺省字段 = 零账面（旧剧本兼容）", () => {
    const withUsage = run(
      [
        snapshotOf([], {
          instances: [inst("main", "running", { usage: usage({ totalTokens: 800_000, cost: 0.5 }) })],
          usage: {
            total: usage({ totalTokens: 832_000, cost: 0.61 }),
            compaction: usage({ totalTokens: 32_000, cost: 0.11 }),
          },
        }),
      ],
      base(),
    );
    expect(withUsage.usage.total).toEqual(usage({ totalTokens: 832_000, cost: 0.61 }));
    expect(withUsage.usage.compaction).toEqual(usage({ totalTokens: 32_000, cost: 0.11 }));
    expect(withUsage.usage.byInstance["main"]).toEqual(usage({ totalTokens: 800_000, cost: 0.5 }));

    const legacy = run([snapshotOf([])], base());
    expect(legacy.usage.total).toEqual(usage());
  });

  it("快照后账目续增量：以快照权威值为基线累计", () => {
    const s = run(
      [
        snapshotOf([], {
          usage: {
            total: usage({ totalTokens: 100 }),
            compaction: usage(),
          },
        }),
        usageRecorded("agent-1", usage({ totalTokens: 7 }), "turn"),
      ],
      base(),
    );
    expect(s.usage.total).toEqual(usage({ totalTokens: 107 }));
    expect(s.usage.byInstance["agent-1"]).toEqual(usage({ totalTokens: 7 }));
  });

  it("新 kind entries（thinking/compaction）随快照入流；快照清 thinking 流式槽（落盘终态）", () => {
    const s = run(
      [
        thinkDelta("main", "进行中思考…"),
        snapshotOf([
          msg("m1", "user", "查一下", 1),
          thinkEntry("th-1", "main", "已落盘思考全文"),
          compactEntry("cp-1", "main", usage()),
        ] as EntryDto[]),
      ],
      base(),
    );
    expect(s.thinkingStreams).toEqual({});
    expect(s.entries.map((e) => e.kind)).toEqual(["message", "thinking", "compaction"]);
  });
});

// ── ⑤ 重放幂等（v0.1 扩展）──────────────────────────────────

describe("重放幂等（v0.1 全事件面）", () => {
  const fullSequence = (): SessionAction[] => [
    welcome(),
    snapshotOf([]),
    spawned("agent-1"),
    spawned("agent-2"),
    queued("agent-2", 2),
    queued("agent-2", 1),
    started("agent-1"),
    stalled("agent-1", 30_000),
    saDelta("agent-1", "m-sa-1", "正在补齐 daemon 单测…"),
    saDelta("agent-1", "m-sa-1", "14 例已全绿。"),
    thinkDelta("main", "盘点当前态…"),
    thinkCompleted(thinkEntry("th-1", "main", "已定稿思考全文（完成态落 Entry）")),
    usageRecorded("agent-1", usage({ totalTokens: 8, cost: 0.02 }), "turn"),
    compactionCompleted(compactEntry("cp-1", "main", usage({ totalTokens: 32_000, cost: 0.11 }))),
    usageRecorded("main", usage({ totalTokens: 32, cost: 0.11 }), "compaction"),
    completed("agent-1", closure("done", "单测补齐完成")),
    { type: "ui/send", text: "补充：只看 ts 字段", mode: "steer", ts: 5 },
    ev({ v: 0, type: "steer.queued", payload: { entryId: "st1" } }),
    ev({ v: 0, type: "chat.turn.completed", payload: { turnId: "t1", reason: "completed" } }),
    ev({ v: 0, type: "steer.drained", payload: { entryId: "st1" } }),
    killed("agent-9", closure("failed", "用户终止")),
  ];

  it("同一含新事件序列重放两次，最终状态深度一致", () => {
    const first = run(fullSequence());
    const second = run(fullSequence());
    expect(second).toEqual(first);
  });

  it("前缀投影 + daemon 快照（含 instances/usage/新 kind）+ 增量 = 纯重放（重连恢复语义）", () => {
    const actions = fullSequence();
    // k：agent-1 running→done（closure 已入卡）/ stalled 已复位；agent-2 queued#1；
    // thinking 已落 Entry（流式槽空）、compaction/账目已发生——k 边界临时态平静
    const k = 16;
    const prefix = run(actions.slice(0, k));

    /** 从投影态构造 daemon 快照（模拟 T2.x toSnapshotDto 重连下发；流式摘要非 DTO 字段不携带；
     *  instances[].usage 按契约 §6.2 携带该实例累计（turn 源账面），重连后 byInstance 可重建）。 */
    const daemonSnapshot: SessionAction = snapshotOf(prefix.entries, {
      model: prefix.model,
      agentState: prefix.agentState,
      instances: prefix.instances.map((c) =>
        inst(c.instanceId, c.state, {
          task: c.task,
          profileKind: c.profileKind,
          ...(c.queuedPosition !== undefined ? { queuedPosition: c.queuedPosition } : {}),
          ...(c.closure ? { closure: c.closure } : {}),
          ...(prefix.usage.byInstance[c.instanceId]
            ? { usage: prefix.usage.byInstance[c.instanceId] }
            : {}),
        }),
      ),
      usage: { total: prefix.usage.total, compaction: prefix.usage.compaction },
    });

    const merged = run([...actions.slice(0, k), daemonSnapshot, ...actions.slice(k)]);
    const full = run(actions);

    expect(merged.instances).toEqual(full.instances);
    expect(merged.usage).toEqual(full.usage);
    expect(merged.entries).toEqual(full.entries);
    expect(merged.thinkingStreams).toEqual(full.thinkingStreams);
    expect(merged.streaming).toBeNull();
  });
});

// ── 终验热修：engine.error 帧投影（瞬态错误卡数据源）──────────

describe("engine.error 帧投影（终验热修）", () => {
  it("帧到达 → engineError 槽位携带 provider 原文；turn.completed 不清除（卡片存续到下一轮）", () => {
    const state = sessionReducer(base(), ev({
      v: 0,
      type: "engine.error",
      payload: { message: '429: {"code":"1308","message":"已达到 5 小时的使用上限。"}' },
    }));
    expect(state.engineError).toEqual({ message: '429: {"code":"1308","message":"已达到 5 小时的使用上限。"}' });
    // turn 收口不清错误卡（错误属于刚结束的轮，需留存到用户看到为止）
    const afterTurn = sessionReducer(state, ev({ v: 0, type: "chat.turn.completed", payload: { turnId: "t1", reason: "completed" } }));
    expect(afterTurn.engineError).not.toBeNull();
  });

  it("新轮 turn.started → engineError 清除（瞬态语义）", () => {
    const state = sessionReducer(createInitialSessionState(), ev({
      v: 0,
      type: "engine.error",
      payload: { message: "boom" },
    }));
    const next = sessionReducer(state, ev({ v: 0, type: "chat.turn.started", payload: { turnId: "t2" } }));
    expect(next.engineError).toBeNull();
  });

  it("快照重建不影响 engineError（瞬态不落盘；整页刷新经 initial state 天然清零，同页重连卡片存续供用户确认）", () => {
    const errored = sessionReducer(createInitialSessionState(), ev({
      v: 0,
      type: "engine.error",
      payload: { message: "boom" },
    }));
    const restored = sessionReducer(errored, snapshotOf([], {}));
    expect(restored.engineError).toEqual({ message: "boom" }); // 同页重连保留；新页初始态为 null
  });
});
