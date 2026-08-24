/**
 * entities/session reducer 纯投影测试（TP-CL7-5 / SM-1~4，AD-16）。
 *
 * 机械判据三件套：
 * ① 同一 action 序列重放两次 → 状态幂等一致；
 * ② 快照 + 增量两来源合并 = 纯重放（重连恢复语义）；
 * ③ 连接态状态机转换矩阵（SM-1/2）+ steer 徽标两态（SM-3）+ 工具卡三态（SM-4）。
 */
import { describe, expect, it } from "vitest";
import type {
  EntryDto,
  EventEnvelope,
  MessageEntryDto,
  SessionSnapshotDto,
  ToolCallEntryDto,
} from "@helix/protocol";
import {
  createInitialSessionState,
  sessionReducer,
  selectCanSend,
  selectIsEmpty,
  selectIsGenerating,
  type SessionAction,
  type SessionState,
} from "./session-reducer";

// ── 构造工具 ────────────────────────────────────────────────

function msg(
  id: string,
  role: "user" | "assistant",
  content: string,
  ts: number,
  steerState?: "queued" | "drained",
): MessageEntryDto {
  return { kind: "message", id, role, content, ts, ...(steerState ? { steerState } : {}) };
}

function tool(
  id: string,
  name: string,
  state: "running" | "done" | "error",
  over: Partial<ToolCallEntryDto> = {},
): ToolCallEntryDto {
  return { kind: "tool-call", id, name, args: '{"path":"a.ts"}', state, ts: 1_000, ...over };
}

function ev(event: EventEnvelope): SessionAction {
  return { type: "event", event };
}

const welcome = (sessionId = "sess-1", model = "claude-sonnet-4-5"): SessionAction =>
  ev({ v: 0, type: "connection.welcome", payload: { sessionId, model, agentState: "idle" } });

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

/** 从已投影状态构造 daemon 快照 DTO（模拟 daemon 侧 toSnapshotDto 的重连下发）。 */
function snapshotActionFromState(s: SessionState): SessionAction {
  return snapshotOf(s.entries, { model: s.model, agentState: s.agentState });
}

// ── ① 重放幂等 ──────────────────────────────────────────────

describe("TP-CL7-5-① 重放幂等", () => {
  it("同一 action 序列重放两次，最终状态深度一致", () => {
    const actions: SessionAction[] = [
      welcome(),
      snapshotOf([msg("m1", "user", "查一下", 1), msg("m2", "assistant", "好的", 2)]),
      ev({ v: 0, type: "agent.state.changed", payload: { state: "running" } }),
      ev({ v: 0, type: "chat.stream.delta", payload: { messageId: "t1", delta: "Hel" } }),
      ev({ v: 0, type: "chat.stream.delta", payload: { messageId: "t1", delta: "lo" } }),
      { type: "ui/send", text: "补充：只看 ts 字段", mode: "steer", ts: 5 },
      ev({ v: 0, type: "steer.queued", payload: { entryId: "st1" } }),
      ev({ v: 0, type: "chat.message.completed", payload: { entry: msg("m3", "assistant", "Hello", 6) } }),
      ev({ v: 0, type: "steer.drained", payload: { entryId: "st1" } }),
      ev({ v: 0, type: "chat.turn.completed", payload: { turnId: "t1", reason: "completed" } }),
      ev({ v: 0, type: "agent.state.changed", payload: { state: "idle" } }),
    ];
    const first = run(actions);
    const second = run(actions);
    expect(second).toEqual(first);
    // 抽查关键字段：steer 徽标已 drain、流式已清、草稿已清
    const steer = second.entries.find((e) => e.id === "st1") as MessageEntryDto;
    expect(steer.steerState).toBe("drained");
    expect(second.streaming).toBeNull();
    expect(second.draft).toBe("");
  });
});

// ── ② 快照 + 增量 = 纯重放 ──────────────────────────────────

describe("TP-CL7-5-② 快照+增量合并 = 纯重放", () => {
  it("前缀投影快照 + 后续增量事件 = 全量重放（重连恢复语义）", () => {
    const fullEvents: SessionAction[] = [
      welcome(),
      ev({ v: 0, type: "chat.message.completed", payload: { entry: msg("m1", "user", "读 handshake.ts", 1) } }),
      ev({ v: 0, type: "agent.state.changed", payload: { state: "running" } }),
      ev({ v: 0, type: "chat.stream.delta", payload: { messageId: "t1", delta: "看" } }),
      ev({ v: 0, type: "tool.call.started", payload: { entry: tool("tc1", "read", "running") } }),
      ev({
        v: 0,
        type: "tool.call.result",
        payload: { entry: tool("tc1", "read", "done", { result: "24 lines", durationMs: 300 }) },
      }),
      ev({
        v: 0,
        type: "chat.message.completed",
        payload: { entry: msg("m2", "assistant", "读完了", 2) },
      }),
      { type: "ui/send", text: "补个 workspace 字段", mode: "steer", ts: 3 },
      ev({ v: 0, type: "steer.queued", payload: { entryId: "st1" } }),
      ev({ v: 0, type: "steer.drained", payload: { entryId: "st1" } }),
      ev({
        v: 0,
        type: "chat.message.completed",
        payload: { entry: msg("m3", "assistant", "已补", 4) },
      }),
      ev({ v: 0, type: "agent.state.changed", payload: { state: "idle" } }),
    ];
    const full = run(fullEvents);

    // k=7：m1 / tc1 / m2 已完成，steer echo 刚发出（未确认）
    const k = 7;
    const prefix = run(fullEvents.slice(0, k));
    const merged = run([
      ...fullEvents.slice(0, k),
      snapshotActionFromState(prefix), // 重连：daemon 下发快照
      ...fullEvents.slice(k),          // 续增量
    ]);

    expect(merged.entries).toEqual(full.entries);
    expect(merged.agentState).toBe(full.agentState);
    expect(merged.streaming).toBe(full.streaming);
    expect(merged.model).toBe(full.model);
  });
});

// ── ③ 连接态状态机矩阵（SM-1/2）──────────────────────────────

describe("SM-1/SM-2 连接状态机", () => {
  const baseEntries: EntryDto[] = [msg("m1", "user", "消息", 1), tool("tc1", "bash", "done", { result: "ok" })];

  it("初始态为 connecting；welcome → connected", () => {
    const s = run([welcome()]);
    expect(s.conn).toBe("connected");
    expect(s.sessionId).toBe("sess-1");
    expect(s.model).toBe("claude-sonnet-4-5");
  });

  it("断线 → 自动重连序列：disconnected → connecting(n) → connected，投影与草稿全程保留", () => {
    const s = run([
      welcome(),
      snapshotOf(baseEntries),
      { type: "ui/set-draft", text: "草稿保留验证" },
      { type: "conn/disconnected" },
    ]);
    expect(s.conn).toBe("disconnected");
    expect(s.entries).toEqual(baseEntries);
    expect(s.draft).toBe("草稿保留验证");

    const retry = run([{ type: "conn/connecting", attempt: 2 }], s);
    expect(retry.conn).toBe("connecting");
    expect(retry.connAttempts).toBe(2);
    expect(retry.entries).toEqual(baseEntries); // 切换不清投影
    expect(retry.draft).toBe("草稿保留验证"); // 草稿跨态保留

    const back = run([welcome(), snapshotOf(baseEntries)], retry);
    expect(back.conn).toBe("connected");
    expect(back.entries).toEqual(baseEntries);
    expect(back.restoreToast).toEqual({ kind: "restore", count: 2 }); // 重连恢复 toast（真实条数）
  });

  it("重试耗尽 → error（失败卡数据）；手动重试 → connecting → connected + retry toast", () => {
    const s = run([
      { type: "conn/gave-up", message: "连接被拒绝", attempts: 3 },
    ]);
    expect(s.conn).toBe("error");
    expect(s.connError).toEqual({ message: "连接被拒绝", attempts: 3 });

    const retry = run([{ type: "conn/manual-retry" }], s);
    expect(retry.conn).toBe("connecting");
    expect(retry.connAttempts).toBe(1);

    const back = run([welcome(), snapshotOf(baseEntries)], retry);
    expect(back.conn).toBe("connected");
    expect(back.restoreToast).toEqual({ kind: "retry", count: 2 });
  });

  it("首连成功不触发恢复 toast（empty 会话也只置投影）", () => {
    const s = run([welcome(), snapshotOf([])]);
    expect(s.conn).toBe("connected");
    expect(s.restoreToast).toBeNull();
    expect(selectIsEmpty(s)).toBe(true);
  });

  it("空会话判定：connected 且无条目且无流式 → empty；生成中不判空", () => {
    const empty = run([welcome(), snapshotOf([])]);
    expect(selectIsEmpty(empty)).toBe(true);
    const generating = run(
      [ev({ v: 0, type: "agent.state.changed", payload: { state: "running" } })],
      empty,
    );
    expect(selectIsEmpty(generating)).toBe(false);
    const withEntry = run([snapshotOf([msg("m1", "user", "hi", 1)])], empty);
    expect(selectIsEmpty(withEntry)).toBe(false);
  });
});

// ── SM-3 steer 徽标两态 ─────────────────────────────────────

describe("SM-3 steer 徽标（事件驱动两态）", () => {
  const ready = (): SessionState =>
    run([
      welcome(),
      snapshotOf([]),
      ev({ v: 0, type: "agent.state.changed", payload: { state: "running" } }),
    ]);

  it("生成中发送 → 本地 echo 气泡带 queued 徽标；steer.queued 确认 id；drained 转绿", () => {
    const sent = run([{ type: "ui/send", text: "别引新类型", mode: "steer", ts: 10 }], ready());
    expect(sent.draft).toBe("");
    const echo = sent.entries.at(-1) as MessageEntryDto;
    expect(echo.kind).toBe("message");
    expect(echo.role).toBe("user");
    expect(echo.content).toBe("别引新类型");
    expect(echo.steerState).toBe("queued");

    const confirmed = run([ev({ v: 0, type: "steer.queued", payload: { entryId: "st1" } })], sent);
    expect(confirmed.entries.some((e) => e.id === "st1")).toBe(true);
    expect(confirmed.entries.some((e) => e.id === echo.id)).toBe(false);

    const drained = run([ev({ v: 0, type: "steer.drained", payload: { entryId: "st1" } })], confirmed);
    const badge = drained.entries.find((e) => e.id === "st1") as MessageEntryDto;
    expect(badge.steerState).toBe("drained");
  });

  it("空闲发送（turn 模式）不产生本地 echo，气泡由 daemon 事件投影", () => {
    const idle = run([welcome(), snapshotOf([])]);
    const sent = run([{ type: "ui/send", text: "你好", mode: "turn", ts: 1 }], idle);
    expect(sent.entries).toEqual([]);
    expect(sent.draft).toBe("");
  });

  it("非 connected 状态发送被拒绝（SM 输入禁用规则的数据面兜底）", () => {
    const connecting = createInitialSessionState();
    const blocked = run([{ type: "ui/send", text: "hi", mode: "turn", ts: 1 }], connecting);
    expect(blocked.entries).toEqual([]);
    expect(blocked.draft).toBe("");
    expect(selectCanSend(blocked)).toBe(false);
  });
});

// ── SM-4 工具卡三态 ─────────────────────────────────────────

describe("SM-4 工具卡三态互斥（tool.call.started/result 驱动）", () => {
  const base = run([welcome(), snapshotOf([])]);

  it("started → running；result → done（同 id upsert，不重复成卡）", () => {
    const started = run(
      [ev({ v: 0, type: "tool.call.started", payload: { entry: tool("tc1", "read", "running") } })],
      base,
    );
    const running = started.entries.find((e) => e.id === "tc1") as ToolCallEntryDto;
    expect(running.state).toBe("running");
    expect(running.result).toBeUndefined();

    const done = run(
      [
        ev({
          v: 0,
          type: "tool.call.result",
          payload: { entry: tool("tc1", "read", "done", { result: "24 lines", durationMs: 300 }) },
        }),
      ],
      started,
    );
    expect(done.entries.filter((e) => e.id === "tc1")).toHaveLength(1);
    const card = done.entries.find((e) => e.id === "tc1") as ToolCallEntryDto;
    expect(card.state).toBe("done");
    expect(card.result).toBe("24 lines");
    expect(card.durationMs).toBe(300);
  });

  it("error 收口同 id upsert 为 error 态", () => {
    const started = run(
      [ev({ v: 0, type: "tool.call.started", payload: { entry: tool("tc2", "bash", "running") } })],
      base,
    );
    const failed = run(
      [
        ev({
          v: 0,
          type: "tool.call.result",
          payload: {
            entry: tool("tc2", "bash", "error", { result: "1 pass · 1 fail · exit 1", durationMs: 2100 }),
          },
        }),
      ],
      started,
    );
    expect(failed.entries.filter((e) => e.id === "tc2")).toHaveLength(1);
    expect((failed.entries.find((e) => e.id === "tc2") as ToolCallEntryDto).state).toBe("error");
  });

  it("快照重放后再次收到同 id result 仍幂等（upsert 不翻倍）", () => {
    const snap = run(
      [snapshotOf([tool("tc3", "grep", "running")])],
      base,
    );
    const once = run(
      [
        ev({
          v: 0,
          type: "tool.call.result",
          payload: { entry: tool("tc3", "grep", "done", { result: "3 hits", durationMs: 50 }) },
        }),
      ],
      snap,
    );
    expect(once.entries.filter((e) => e.id === "tc3")).toHaveLength(1);
  });
});

// ── 流式投影 ────────────────────────────────────────────────

describe("流式 delta 投影", () => {
  const base = run([welcome(), snapshotOf([])]);

  it("同 messageId 增量追加；message.completed 落账并清流式", () => {
    const s1 = run(
      [ev({ v: 0, type: "chat.stream.delta", payload: { messageId: "t1", delta: "Hel" } })],
      base,
    );
    const s2 = run(
      [ev({ v: 0, type: "chat.stream.delta", payload: { messageId: "t1", delta: "lo" } })],
      s1,
    );
    expect(s2.streaming).toEqual({ messageId: "t1", text: "Hello" });

    const s3 = run(
      [ev({ v: 0, type: "chat.message.completed", payload: { entry: msg("m2", "assistant", "Hello", 2) } })],
      s2,
    );
    expect(s3.streaming).toBeNull();
    expect(s3.entries.at(-1)?.id).toBe("m2");
    expect(selectIsGenerating(s3)).toBe(false);
  });

  it("turn.completed / agent idle 均清流式（光标消失）", () => {
    const streaming = run(
      [ev({ v: 0, type: "chat.stream.delta", payload: { messageId: "t1", delta: "x" } })],
      base,
    );
    expect(selectIsGenerating(streaming)).toBe(true);
    const cleared = run(
      [ev({ v: 0, type: "chat.turn.completed", payload: { turnId: "t1", reason: "aborted" } })],
      streaming,
    );
    expect(cleared.streaming).toBeNull();
  });
});

// ── T9 图片上行：附件草稿（ui state）──

describe("T9 附件草稿（attachments ui state）", () => {
  const IMG = "data:image/png;base64,AAAA";

  it("ui/attach-images 追加（≤4 上限由调用侧预检，reducer 仅承载）", () => {
    const s1 = sessionReducer(createInitialSessionState(), { type: "ui/attach-images", images: [IMG] });
    expect(s1.attachments).toEqual([IMG]);
    const s2 = sessionReducer(s1, { type: "ui/attach-images", images: ["data:image/jpeg;base64,BBB="] });
    expect(s2.attachments).toEqual([IMG, "data:image/jpeg;base64,BBB="]);
  });

  it("ui/remove-attachment 按下标移除", () => {
    const s = sessionReducer(createInitialSessionState(), {
      type: "ui/attach-images",
      images: [IMG, "data:image/jpeg;base64,BBB="],
    });
    const removed = sessionReducer(s, { type: "ui/remove-attachment", index: 0 });
    expect(removed.attachments).toEqual(["data:image/jpeg;base64,BBB="]);
  });

  it("ui/send（turn）后清空附件（随草稿一起消费）", () => {
    const s = sessionReducer(createInitialSessionState(), { type: "ui/attach-images", images: [IMG] });
    const sent = sessionReducer(s, { type: "ui/send", text: "看图", mode: "turn", ts: 1 });
    expect(sent.attachments).toEqual([]);
  });

  it("session/new-draft / 切换会话重置附件", () => {
    const s = sessionReducer(createInitialSessionState(), { type: "ui/attach-images", images: [IMG] });
    const reset = sessionReducer(s, { type: "session/new-draft" });
    expect(reset.attachments).toEqual([]);
  });
});

// ── T11b：closure/steer source 显示区分（消费链对账） ─────────

describe("T11b steer 事件 source 对账（queued/drained 载荷 → 渲染条目）", () => {
  const ready = (): SessionState =>
    run([
      welcome(),
      snapshotOf([]),
      ev({ v: 0, type: "agent.state.changed", payload: { state: "running" } }),
    ]);

  it("steer.queued 携带 source=closure → echo 对账条目标记 closure（徽标变体依据）", () => {
    const sent = run([{ type: "ui/send", text: "收口注入", mode: "steer", ts: 10 }], ready());
    const s = run(
      [ev({ v: 0, type: "steer.queued", payload: { entryId: "st1", source: "closure" } })],
      sent,
    );
    const e = s.entries.find((x) => x.id === "st1") as MessageEntryDto;
    expect(e.source).toBe("closure");
    expect(e.steerState).toBe("queued");
  });

  it("steer.drained 携带 source=progress → 对账条目 source 更新为 progress", () => {
    const sent = run([{ type: "ui/send", text: "进展", mode: "steer", ts: 10 }], ready());
    const confirmed = run(
      [ev({ v: 0, type: "steer.queued", payload: { entryId: "st1", source: "progress" } })],
      sent,
    );
    const drained = run(
      [ev({ v: 0, type: "steer.drained", payload: { entryId: "st1", source: "progress" } })],
      confirmed,
    );
    const e = drained.entries.find((x) => x.id === "st1") as MessageEntryDto;
    expect(e.source).toBe("progress");
    expect(e.steerState).toBe("drained");
  });

  it("回归钉：steer.queued/drained 缺省 source（老事件）→ 条目不携带 source（按 user 渲染）", () => {
    const sent = run([{ type: "ui/send", text: "用户 steer", mode: "steer", ts: 10 }], ready());
    const confirmed = run([ev({ v: 0, type: "steer.queued", payload: { entryId: "st1" } })], sent);
    const drained = run(
      [ev({ v: 0, type: "steer.drained", payload: { entryId: "st1" } })],
      confirmed,
    );
    const e = drained.entries.find((x) => x.id === "st1") as MessageEntryDto;
    expect(e.source).toBeUndefined();
    expect(e.steerState).toBe("drained");
  });
});

describe("T11b entry.source 到渲染链（实时帧 + 快照）", () => {
  it("chat.message.completed 实时帧 entry.source 透传进主流（idle closure 注入即时区分）", () => {
    const s = run([
      welcome(),
      snapshotOf([]),
      ev({
        v: 0,
        type: "chat.message.completed",
        payload: {
          entry: {
            kind: "message",
            id: "c1",
            role: "user",
            content: "agent-1 closure: done",
            ts: 1,
            source: "closure",
          },
        },
      }),
    ]);
    const e = s.entries.find((x) => x.id === "c1") as MessageEntryDto;
    expect(e.source).toBe("closure");
  });

  it("session.snapshot 条目 source 带到主时间轴（恢复/重连路径）", () => {
    const s = run([
      welcome(),
      snapshotOf([
        { kind: "message", id: "p1", role: "user", content: "进展报告", ts: 1, source: "progress" },
      ]),
    ]);
    const e = s.entries.find((x) => x.id === "p1") as MessageEntryDto;
    expect(e.source).toBe("progress");
  });
});
