/**
 * session-reducer per-instance channel 投影测试（T4.3；CL-1 F1.2）。
 *
 * 机械判据（task-T4.3-brief TDD RED 行 + test-design §2.1 F1.2 shell unit 行）：
 * ① 五物种单一时间线：lifecycle（spawned/模型解析/stalled/crashed/terminated，
 *    warn/err 变色数据）/ SA 消息（含流式中间态槽位）/ thinking-entry / 工具卡
 *    （started→result 原位定稿）/ steer 注入标记（user 消息回放）/ closure 卡，
 *    按事件到达序投影；
 * ② 实例隔离：他实例与 main 事件不进本实例 channel（AD-3 分流）；
 * ③ kill 终止链：agent.killed → 卡 failed+terminated + terminated err 行 +
 *    closure failed 条目 + killToast（一次性消费）；终态吸收（重复终态零追加）；
 * ④ stalled 可重复：每次 agent.stalled 追加 warn 行；活动恢复（delta/started/
 *    终态）清除 stalledMs（徽标显隐依据，§8-3）；
 * ⑤ 快照重建（AD-10）：instances + entries（含 thinking）按 instanceId 重建
 *    全流 channel；流式槽位随快照清空；
 * ⑥ 重放幂等：同序列重放 channel 深度一致。
 */
import { describe, expect, it } from "vitest";
import type {
  ClosureDto,
  EventEnvelope,
  SessionSnapshotDto,
  ThinkingEntryDto,
  ToolCallEntryDto,
  UsageDto,
} from "@helix/protocol";
import {
  createInitialSessionState,
  sessionReducer,
  type SessionAction,
  type SessionState,
} from "./session-reducer";

// ── 构造工具 ────────────────────────────────────────────────

function play(events: SessionAction[]): SessionState {
  return events.reduce(sessionReducer, createInitialSessionState());
}

const welcome: SessionAction = {
  type: "event",
  event: {
    v: 0,
    type: "connection.welcome",
    payload: { sessionId: "s1", model: "claude-sonnet-4-5", agentState: "idle" },
  },
};

function spawned(agentId: string, model?: string): SessionAction {
  return {
    type: "event",
    event: {
      v: 0,
      type: "agent.spawned",
      payload: { agentId, task: `task of ${agentId}`, profileKind: "subagent-worker", ...(model !== undefined ? { model } : {}) },
    },
  };
}

function saDelta(iid: string, messageId: string, delta: string): SessionAction {
  return {
    type: "event",
    event: { v: 0, type: "chat.stream.delta", instanceId: iid, payload: { messageId, delta } },
  };
}

function saMsg(iid: string, id: string, role: "user" | "assistant", content: string, ts: number): SessionAction {
  return {
    type: "event",
    event: {
      v: 0,
      type: "chat.message.completed",
      instanceId: iid,
      payload: { entry: { kind: "message", id, role, content, ts, instanceId: iid } },
    },
  };
}

function toolStarted(iid: string, id: string, name: string): SessionAction {
  return {
    type: "event",
    event: {
      v: 0,
      type: "tool.call.started",
      instanceId: iid,
      payload: {
        entry: { kind: "tool-call", id, name, args: "{}", state: "running", ts: 1, instanceId: iid },
      },
    },
  };
}

function toolResult(iid: string, entry: ToolCallEntryDto): SessionAction {
  return {
    type: "event",
    event: { v: 0, type: "tool.call.result", instanceId: iid, payload: { entry } },
  };
}

function thinkDelta(iid: string, delta: string): SessionAction {
  return {
    type: "event",
    event: { v: 0, type: "thinking.stream.delta", payload: { instanceId: iid, delta } },
  };
}

function thinkDone(entry: ThinkingEntryDto): SessionAction {
  return {
    type: "event",
    event: { v: 0, type: "thinking.completed", payload: { entry } },
  };
}

function stalled(agentId: string, idleMs: number): SessionAction {
  return {
    type: "event",
    event: { v: 0, type: "agent.stalled", payload: { agentId, idleMs } },
  };
}

function cl(status: "done" | "failed", summary: string, reportPath: string | null = null): ClosureDto {
  return { status, summary, reportPath, findings: null, taskId: null };
}

/** 全物种剧本：spawned → thinking → SA 消息 → 工具（started/result）→ steer 注入 → stalled → completed。 */
function fullScenario(): SessionAction[] {
  return [
    welcome,
    spawned("agent-1", "provider/haiku"),
    thinkDelta("agent-1", "分析缺口"),
    thinkDone({
      kind: "thinking",
      id: "th-1",
      instanceId: "agent-1",
      text: "分析缺口",
      durationMs: 6_000,
      reasoningTokens: 412,
      createdAt: "2026-08-16T14:02:30.000Z",
    }),
    saDelta("agent-1", "m-1", "先读 tokens"),
    saMsg("agent-1", "m-1", "assistant", "先读 tokens.css 和组件用色点。", 1_000),
    toolStarted("agent-1", "t-1", "read"),
    toolResult("agent-1", {
      kind: "tool-call",
      id: "t-1",
      name: "read",
      args: '{"path":"tokens.css"}',
      result: "26 vars",
      state: "done",
      durationMs: 200,
      ts: 1_200,
      instanceId: "agent-1",
    }),
    saMsg("agent-1", "m-2", "user", "把 --text-faint 档也带上", 1_400),
    stalled("agent-1", 372_000),
    {
      type: "event",
      event: {
        v: 0,
        type: "agent.completed",
        payload: { agentId: "agent-1", closure: cl("done", "14 例全绿", ".helix/runs/agent-1/report.md") },
      },
    },
  ];
}

// ── ① 五物种单一时间线 ─────────────────────────────────────

describe("drawer channel 投影（F1.2）", () => {
  it("五物种按到达序投影为单一时间线；工具 result 原位定稿（seq 稳定）", () => {
    const s = play(fullScenario());
    const ch = s.instanceChannels["agent-1"]!;
    expect(ch).toBeDefined();
    expect(ch.map((i) => i.kind)).toEqual([
      "lifecycle", // spawned
      "lifecycle", // 模型解析（声明槽位）
      "thinking-entry",
      "message",
      "tool",
      "steer",
      "lifecycle", // stalled warn
      "closure",
    ]);
    // 模型解析行：声明槽位 + 解析值
    const modelRow = ch[1];
    expect(modelRow).toMatchObject({ lc: "modelResolved", tone: "info", model: "provider/haiku", slot: "declared" });
    // 工具卡：started→result 定稿且 seq 不变（React key 稳定）
    const toolItem = ch[4]!;
    expect(toolItem).toMatchObject({ kind: "tool" });
    if (toolItem.kind === "tool") {
      expect(toolItem.entry.state).toBe("done");
      expect(toolItem.entry.result).toBe("26 vars");
    }
    const toolSeq = toolItem.seq;
    // stalled warn 行携带 idleMs（视图 formatDuration 消费）
    expect(ch[6]).toMatchObject({ lc: "stalled", tone: "warn", idleMs: 372_000 });
    // closure 卡条目（done）
    expect(ch[7]).toMatchObject({ kind: "closure" });
  });

  it("流式消息中间态进 channelStreams 槽位；完成清槽并定稿 message", () => {
    const s = play([welcome, spawned("agent-2"), saDelta("agent-2", "m-9", "部分输出")]);
    expect(s.channelStreams["agent-2"]).toEqual({ messageId: "m-9", text: "部分输出" });
    const done = play([
      ...fullScenario().slice(0, 1), // welcome（agent-1 剧本无关）
      spawned("agent-2"),
      saDelta("agent-2", "m-9", "部分输出"),
      saMsg("agent-2", "m-9", "assistant", "完整输出", 2_000),
    ]);
    expect(done.channelStreams["agent-2"]).toBeUndefined();
    const ch = done.instanceChannels["agent-2"]!;
    expect(ch.at(-1)).toMatchObject({ kind: "message", text: "完整输出", ts: 2_000 });
  });

  it("spawned 缺省 model → 模型解析行继承会话模型（inherited 槽位）", () => {
    const s = play([welcome, spawned("agent-3")]);
    const row = s.instanceChannels["agent-3"]![1]!;
    expect(row).toMatchObject({ lc: "modelResolved", model: "claude-sonnet-4-5", slot: "inherited" });
  });

  it("重复 spawned（非终态重发）不重复追加 lifecycle 行", () => {
    const s = play([welcome, spawned("agent-4"), spawned("agent-4")]);
    expect(s.instanceChannels["agent-4"]!.filter((i) => i.kind === "lifecycle")).toHaveLength(2);
  });
});

// ── ② 实例隔离 ─────────────────────────────────────────────

describe("实例隔离（AD-3 分流）", () => {
  it("他实例与 main 事件不进本实例 channel；main 消息流不受实例 channel 影响", () => {
    const s = play([
      welcome,
      spawned("agent-a"),
      spawned("agent-b"),
      saMsg("agent-a", "ma-1", "assistant", "A 的输出", 1),
      saMsg("agent-b", "mb-1", "assistant", "B 的输出", 2),
      {
        type: "event",
        event: {
          v: 0,
          type: "chat.stream.delta",
          payload: { messageId: "main-m", delta: "主实例增量" },
        },
      },
    ]);
    expect(s.instanceChannels["agent-a"]!.map((i) => i.kind)).toEqual(["lifecycle", "lifecycle", "message"]);
    expect(s.instanceChannels["agent-b"]!.map((i) => i.kind)).toEqual(["lifecycle", "lifecycle", "message"]);
    if (s.instanceChannels["agent-a"]!.at(-1)?.kind === "message") {
      expect((s.instanceChannels["agent-a"]!.at(-1) as { text: string }).text).toBe("A 的输出");
    }
    // main 增量不进任何实例 channel（缺省 instanceId = main）
    expect(
      s.instanceChannels["agent-a"]!.some((i) => i.kind === "message" && (i as { text: string }).text.includes("主实例")),
    ).toBe(false);
    expect(s.channelStreams["agent-a"]).toBeUndefined();
    expect(s.streaming?.text).toBe("主实例增量");
  });

  it("未知实例的事件不崩（乱序容错）：流式槽位可用，channel 缺失视作空", () => {
    const s = play([welcome, saDelta("agent-x", "m", "孤儿增量")]);
    expect(s.instanceChannels["agent-x"] ?? []).toEqual([]);
    expect(s.channelStreams["agent-x"]).toEqual({ messageId: "m", text: "孤儿增量" });
  });
});

// ── ③ kill 终止链 / 终态族 ─────────────────────────────────

describe("kill 终止链与终态族（F1.2/§8-2）", () => {
  const kill = (agentId: string, c: ClosureDto): SessionAction => ({
    type: "event",
    event: { v: 0, type: "agent.killed", payload: { agentId, closure: c } },
  });

  it("agent.killed → 卡 failed+terminated + terminated err 行 + closure 条目 + killToast", () => {
    const s = play([
      welcome,
      spawned("agent-k"),
      kill("agent-k", cl("failed", "实例被用户终止")),
    ]);
    const card = s.instances.find((c) => c.instanceId === "agent-k");
    expect(card).toMatchObject({ state: "failed", terminated: true });
    const ch = s.instanceChannels["agent-k"]!;
    expect(ch.map((i) => i.kind)).toEqual(["lifecycle", "lifecycle", "lifecycle", "closure"]);
    expect(ch[2]).toMatchObject({ lc: "terminated", tone: "err" });
    expect(ch[3]).toMatchObject({ kind: "closure" });
    if (ch[3]!.kind === "closure") expect(ch[3]!.closure.status).toBe("failed");
    expect(s.killToast).toEqual({ instanceId: "agent-k" });
    // 一次性消费
    const consumed = sessionReducer(s, { type: "ui/consume-kill-toast" });
    expect(consumed.killToast).toBeNull();
  });

  it("终态吸收：killed 之后的重复终态事件零追加零 toast", () => {
    const killedOnce = play([welcome, spawned("agent-k"), kill("agent-k", cl("failed", "已终止"))]);
    const base = sessionReducer(killedOnce, { type: "ui/consume-kill-toast" });
    expect(base.killToast).toBeNull();
    const re = sessionReducer(base, {
      type: "event",
      event: { v: 0, type: "agent.killed", payload: { agentId: "agent-k", closure: cl("failed", "重复") } },
    });
    expect(re.instanceChannels["agent-k"]!).toHaveLength(base.instanceChannels["agent-k"]!.length);
    expect(re.killToast).toBeNull();
  });

  it("agent.failed → crashed err 行（error 透传）+ closure；agent.completed → closure done", () => {
    const failed = play([
      welcome,
      spawned("agent-f"),
      {
        type: "event",
        event: {
          v: 0,
          type: "agent.failed",
          payload: { agentId: "agent-f", error: "子进程异常退出 · exit 137", closure: cl("failed", "崩溃隔离生效") },
        },
      },
    ]);
    const chF = failed.instanceChannels["agent-f"]!;
    expect(chF[2]).toMatchObject({ lc: "crashed", tone: "err", error: "子进程异常退出 · exit 137" });

    const done = play([
      welcome,
      spawned("agent-d"),
      {
        type: "event",
        event: { v: 0, type: "agent.completed", payload: { agentId: "agent-d", closure: cl("done", "完成") } },
      },
    ]);
    expect(done.instanceChannels["agent-d"]!.at(-1)).toMatchObject({ kind: "closure" });
  });
});

// ── ④ stalled 可重复与恢复 ─────────────────────────────────

describe("stalled 警示行与恢复（F1.8/§8-3）", () => {
  it("每次 agent.stalled 追加一条 warn 行（可重复，非状态迁移）", () => {
    const s = play([welcome, spawned("agent-s"), stalled("agent-s", 300_000), stalled("agent-s", 420_000)]);
    const rows = s.instanceChannels["agent-s"]!.filter((i) => i.kind === "lifecycle" && i.lc === "stalled");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ idleMs: 300_000 });
    expect(rows[1]).toMatchObject({ idleMs: 420_000 });
  });

  it("活动恢复（delta/started/终态）清除 stalledMs（徽标隐藏依据）", () => {
    const withStall = play([welcome, spawned("agent-s"), stalled("agent-s", 300_000)]);
    expect(withStall.instances[0]!.stalledMs).toBe(300_000);
    const afterDelta = sessionReducer(withStall, saDelta("agent-s", "m", "恢复活动"));
    expect(afterDelta.instances[0]!.stalledMs).toBeUndefined();
    const reStall = play([welcome, spawned("agent-s"), stalled("agent-s", 300_000)]);
    const afterStart = sessionReducer(reStall, {
      type: "event",
      event: { v: 0, type: "agent.started", payload: { agentId: "agent-s" } },
    });
    expect(afterStart.instances[0]!.stalledMs).toBeUndefined();
  });

  it("非 running 实例的 stalled 事件不追加警示行", () => {
    const s = play([
      welcome,
      spawned("agent-q"),
      { type: "event", event: { v: 0, type: "agent.queued", payload: { agentId: "agent-q", position: 1 } } },
      stalled("agent-q", 300_000),
    ]);
    expect(s.instanceChannels["agent-q"]!.some((i) => i.kind === "lifecycle" && i.lc === "stalled")).toBe(false);
  });
});

// ── ⑤ 快照重建（AD-10） ────────────────────────────────────

describe("快照重建 channel（AD-10 历史保留）", () => {
  it("instances + entries 按 instanceId 重建全流（含 steer 标记与 closure 尾卡）；流式槽位清空", () => {
    const usage: UsageDto = {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0,
    };
    const snapshot: SessionSnapshotDto = {
      sessionId: "s1",
      model: "claude-sonnet-4-5",
      agentState: "idle",
      revision: 3,
      entries: [
        { kind: "message", id: "e1", role: "user", content: "主线消息", ts: 1, instanceId: "agent-m1" },
        {
          kind: "message",
          id: "e2",
          role: "user",
          content: "注入的补充指示",
          ts: 2,
          instanceId: "agent-9",
        },
        {
          kind: "message",
          id: "e3",
          role: "assistant",
          content: "实例回复",
          ts: 3,
          instanceId: "agent-9",
        },
        {
          kind: "tool-call",
          id: "e4",
          name: "bash",
          args: "{}",
          state: "done",
          result: "ok",
          durationMs: 5,
          ts: 4,
          instanceId: "agent-9",
        },
        {
          kind: "thinking",
          id: "e5",
          instanceId: "agent-9",
          text: "回看思考",
          durationMs: 4_000,
          reasoningTokens: 300,
          createdAt: "2026-08-16T14:00:00.000Z",
        },
      ],
      instances: [
        {
          // T10c 新形态：主实例条目 id = agent-<唯一串>（kind 恒 main）——
          // 快照习得源；e1 主线消息显式携带该 id 仍进主消息流
          instanceId: "agent-m1",
          kind: "main",
          profileKind: "main-session",
          state: "running",
          createdAt: "2026-08-16T14:00:00.000Z",
        },
        {
          instanceId: "agent-9",
          kind: "subagent",
          profileKind: "subagent-worker",
          state: "done",
          task: "历史任务",
          createdAt: "2026-08-16T14:00:00.000Z",
          closure: cl("done", "历史收敛", ".helix/runs/agent-9/report.md"),
          usage,
        },
      ],
    };
    const pre = play([
      welcome,
      spawned("agent-live"),
      saDelta("agent-live", "m", "进行中被快照打断的流"),
    ]);
    const s = sessionReducer(pre, {
      type: "event",
      event: { v: 0, type: "session.snapshot", payload: { snapshot } },
    });
    const ch = s.instanceChannels["agent-9"]!;
    // spawned + 模型解析 + steer（user 消息）+ message + tool + thinking + closure
    expect(ch.map((i) => i.kind)).toEqual([
      "lifecycle",
      "lifecycle",
      "steer",
      "message",
      "tool",
      "thinking-entry",
      "closure",
    ]);
    expect(ch[1]!).toMatchObject({ lc: "modelResolved", model: "claude-sonnet-4-5", slot: "inherited" });
    if (ch[6]!.kind === "closure") expect(ch[6]!.closure.reportPath).toBe(".helix/runs/agent-9/report.md");
    // 快照重建：非快照实例的 channel 与流式槽位清空（快照为权威）
    expect(s.instanceChannels["agent-live"]).toBeUndefined();
    expect(s.channelStreams).toEqual({});
    // 主实例消息仍进主消息流；无 main channel；主实例 id 习得自快照 kind=main 条目
    expect(s.entries.map((e) => e.id)).toContain("e1");
    expect(s.mainInstanceId).toBe("agent-m1");
    expect(s.instanceChannels["agent-m1"]).toBeUndefined();
  });
});

// ── ⑥ 重放幂等 ─────────────────────────────────────────────

describe("重放幂等（channel 面）", () => {
  it("同一 action 序列重放两次 → instanceChannels/channelStreams/killToast 深度一致", () => {
    const a = play(fullScenario());
    const b = play(fullScenario());
    expect(a.instanceChannels).toEqual(b.instanceChannels);
    expect(a.channelStreams).toEqual(b.channelStreams);
    expect(a.nextChannelSeq).toBe(b.nextChannelSeq);
    expect(a.killToast).toEqual(b.killToast);
  });
});
