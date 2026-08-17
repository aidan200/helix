/**
 * SubAgent 卡片时间轴锚点投影（T5.5；task brief §4.2）。
 *
 * 锚点维度（InstanceCardState.anchorEntryId）= 渲染插入位：卡片渲染在该 id
 * 的 entry 之后（null = 流首）。行为契约：
 * - spawn 到达时记录插入位（当时最后一条 main entry；无 entries = 流首）；
 * - 状态原位更新（queued→running→终态锚点不变；终态卡留原位作历史）；
 * - 抗分页前插（loadEarlier prepend 只加头部 entries，锚点 id 引用不漂移）；
 * - 快照恢复：锚点 = 实例首 Entry 前最后一条 main entry（无实例 Entry =
 *   尾部 = 最后一条 main entry；无 main entry = 流首 null）；
 * - 同锚点多卡保 spawn 先后序（instances 数组序）。
 */
import { describe, expect, it } from "vitest";
import type { AgentInstanceDto, EventEnvelope, MessageEntryDto } from "@helix/protocol";
import {
  createInitialSessionState,
  sessionReducer,
  type SessionAction,
  type SessionState,
} from "./session-reducer";

const ev = (event: EventEnvelope): SessionAction => ({ type: "event", event });
const play = (events: EventEnvelope[]): SessionState =>
  events.reduce((s, e) => sessionReducer(s, ev(e)), createInitialSessionState());

const welcome: EventEnvelope = {
  v: 0,
  type: "connection.welcome",
  payload: { sessionId: "s1", model: "m", agentState: "idle" },
};

const msg = (id: string, instanceId?: string): MessageEntryDto => ({
  kind: "message",
  id,
  role: "assistant",
  content: `text-${id}`,
  ts: 1,
  ...(instanceId !== undefined ? { instanceId } : {}),
});

const completed = (id: string): EventEnvelope => ({
  v: 0,
  type: "chat.message.completed",
  payload: { entry: msg(id) },
});

const spawn = (agentId: string): EventEnvelope => ({
  v: 0,
  type: "agent.spawned",
  payload: { agentId, task: `task-${agentId}`, profileKind: "subagent-worker" },
});

const inst = (instanceId: string, state: AgentInstanceDto["state"]): AgentInstanceDto => ({
  instanceId,
  kind: "subagent",
  profileKind: "subagent-worker",
  state,
  task: `task-${instanceId}`,
  createdAt: "2026-08-17T00:00:00+08:00",
});

const snapshotWith = (
  entries: MessageEntryDto[],
  instances: AgentInstanceDto[],
): EventEnvelope => ({
  v: 0,
  type: "session.snapshot",
  payload: {
    snapshot: {
      sessionId: "s1",
      model: "m",
      agentState: "idle",
      revision: 1,
      entries,
      instances,
    },
  },
});

describe("spawn 锚点记录（T5.5）", () => {
  it("spawn 到达时锚点 = 当时最后一条 main entry id", () => {
    const s = play([welcome, completed("m1"), completed("m2"), spawn("a1")]);
    expect(s.instances[0]!.anchorEntryId).toBe("m2");
  });

  it("无 entries 时 spawn → 锚点 null（流首）", () => {
    const s = play([welcome, spawn("a1")]);
    expect(s.instances[0]!.anchorEntryId).toBeNull();
  });

  it("spawn 后追加 entries 锚点不变（原位，不随流尾漂移）", () => {
    const s = play([welcome, completed("m1"), spawn("a1"), completed("m2"), completed("m3")]);
    expect(s.instances[0]!.anchorEntryId).toBe("m1");
  });

  it("状态原位更新：queued→running→done 全程锚点不变（终态留原位）", () => {
    const closure = { status: "done" as const, summary: "收口" };
    const s = play([
      welcome,
      completed("m1"),
      spawn("a1"),
      { v: 0, type: "agent.queued", payload: { agentId: "a1", position: 1 } },
      { v: 0, type: "agent.started", payload: { agentId: "a1" } },
      { v: 0, type: "agent.completed", payload: { agentId: "a1", closure } },
      completed("m2"),
    ]);
    const card = s.instances[0]!;
    expect(card.state).toBe("done");
    expect(card.anchorEntryId).toBe("m1");
  });

  it("同锚点多卡保 spawn 先后序（instances 数组序）", () => {
    const s = play([welcome, completed("m1"), spawn("a1"), spawn("a2")]);
    expect(s.instances.map((c) => c.instanceId)).toEqual(["a1", "a2"]);
    expect(s.instances[0]!.anchorEntryId).toBe("m1");
    expect(s.instances[1]!.anchorEntryId).toBe("m1");
  });
});

describe("分页前插锚点不漂移（T5.5；loadEarlier prepend）", () => {
  it("loadHistory.result 前插后锚点 id 引用不变", () => {
    const before = play([welcome, completed("m1"), spawn("a1")]);
    const after = sessionReducer(
      before,
      ev({
        v: 0,
        type: "session.loadHistory.result",
        payload: { entries: [msg("m0a"), msg("m0b")], hasMore: false, nextCursor: null },
      }),
    );
    expect(after.entries.map((e) => e.id)).toEqual(["m0a", "m0b", "m1"]);
    expect(after.instances[0]!.anchorEntryId).toBe("m1");
  });
});

describe("快照恢复锚点（T5.5；= 实例首 Entry 前最后一条 main entry）", () => {
  it("实例首 Entry 前有 main entry → 锚定该 entry", () => {
    const s = play([
      welcome,
      snapshotWith([msg("u1"), msg("sa1-first", "a1"), msg("m2")], [inst("a1", "done")]),
    ]);
    expect(s.instances[0]!.anchorEntryId).toBe("u1");
  });

  it("实例无 Entry → 尾部（最后一条 main entry）", () => {
    const s = play([welcome, snapshotWith([msg("u1"), msg("m2")], [inst("a1", "done")])]);
    expect(s.instances[0]!.anchorEntryId).toBe("m2");
  });

  it("实例首 Entry 前无 main entry → 流首（null）", () => {
    const s = play([welcome, snapshotWith([msg("sa1-first", "a1"), msg("m2")], [inst("a1", "done")])]);
    expect(s.instances[0]!.anchorEntryId).toBeNull();
  });

  it("多实例各自锚定（首 Entry 位）且保清单序", () => {
    const s = play([
      welcome,
      snapshotWith(
        [msg("u1"), msg("sa1-first", "a1"), msg("m2"), msg("sa2-first", "a2"), msg("m3")],
        [inst("a1", "done"), inst("a2", "running")],
      ),
    ]);
    expect(s.instances.map((c) => c.instanceId)).toEqual(["a1", "a2"]);
    expect(s.instances[0]!.anchorEntryId).toBe("u1");
    expect(s.instances[1]!.anchorEntryId).toBe("m2");
  });
});
