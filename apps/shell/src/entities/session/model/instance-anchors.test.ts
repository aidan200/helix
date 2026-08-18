/**
 * SubAgent 卡片时间轴锚点投影（CL-1 v0.3；契约 v0.3 §1；Q-1b/Q-1c）。
 *
 * 锚点维度（InstanceCardState.anchorEntryId）= 渲染插入位：卡片渲染在该 id
 * 的 entry 之后（null = 流首）。**DTO 为唯一权威**（快照 instances /
 * agent.spawned 帧均由 daemon 组装期计算下发，shell 零推导）：
 * - spawn 到达：anchorEntryId 直读帧 payload（null 流首是有效值，不回落）；
 * - 快照重建：anchorEntryId 直读 instances DTO（无 live 锚点双轨、无快照
 *   推导——重连合入同实例同样以 DTO 覆盖）；
 * - 状态原位更新（queued→running→终态锚点不变；终态卡留原位作历史）；
 * - 抗分页前插（loadEarlier prepend 只加头部 entries，锚点 id 引用不漂移）；
 * - 同锚点多卡保 spawn 先后序（instances 数组序）；
 * - 推导零残留守护（TP-CL1-6）：snapshot.ts 无 anchorFromSnapshot / liveAnchor，
 *   MessageFlow.tsx 无 tailCards 兜底桶。
 */
import { readFileSync } from "node:fs";
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

/** agent.spawned 帧（v0.3：anchorEntryId 为权威供给位；null = 流首）。 */
const spawn = (agentId: string, anchorEntryId: string | null): EventEnvelope => ({
  v: 0,
  type: "agent.spawned",
  payload: { agentId, task: `task-${agentId}`, profileKind: "subagent-worker", anchorEntryId },
});

const inst = (
  instanceId: string,
  state: AgentInstanceDto["state"],
  anchorEntryId: string | null,
): AgentInstanceDto => ({
  instanceId,
  kind: "subagent",
  profileKind: "subagent-worker",
  state,
  task: `task-${instanceId}`,
  anchorEntryId,
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

describe("spawn 帧锚点直读（CL-1 v0.3；DTO 唯一权威）", () => {
  it("agent.spawned 携带 anchorEntryId → 卡片直读同值（不看当前 entries 尾部）", () => {
    // 帧锚点 = m1，而到达时尾部已是 m2——直读帧值，不就地推导
    const s = play([welcome, completed("m1"), completed("m2"), spawn("a1", "m1")]);
    expect(s.instances[0]!.anchorEntryId).toBe("m1");
  });

  it("anchorEntryId: null → null 保留（流首有效锚，不被 ?? 吞）", () => {
    const s = play([welcome, completed("m1"), spawn("a1", null)]);
    expect(s.instances[0]!.anchorEntryId).toBeNull();
  });

  it("spawn 后追加 entries 锚点不变（原位，不随流尾漂移）", () => {
    const s = play([welcome, completed("m1"), spawn("a1", "m1"), completed("m2"), completed("m3")]);
    expect(s.instances[0]!.anchorEntryId).toBe("m1");
  });

  it("状态原位更新：queued→running→done 全程锚点不变（终态留原位）", () => {
    const closure = { status: "done" as const, summary: "收口" };
    const s = play([
      welcome,
      completed("m1"),
      spawn("a1", "m1"),
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
    const s = play([welcome, completed("m1"), spawn("a1", "m1"), spawn("a2", "m1")]);
    expect(s.instances.map((c) => c.instanceId)).toEqual(["a1", "a2"]);
    expect(s.instances[0]!.anchorEntryId).toBe("m1");
    expect(s.instances[1]!.anchorEntryId).toBe("m1");
  });
});

describe("快照 instances DTO 锚点直读（CL-1 v0.3；无推导无双轨）", () => {
  it("DTO anchorEntryId 直读（与 entries 推导结果相左时以 DTO 为准）", () => {
    // 旧推导会给 u1（实例首 Entry 前最后 main entry）；DTO 权威值 = m2
    const s = play([
      welcome,
      snapshotWith([msg("u1"), msg("sa1-first", "a1"), msg("m2")], [inst("a1", "done", "m2")]),
    ]);
    expect(s.instances[0]!.anchorEntryId).toBe("m2");
  });

  it("DTO anchorEntryId: null → 流首保留（有效值不回落推导）", () => {
    const s = play([
      welcome,
      snapshotWith([msg("u1"), msg("m2")], [inst("a1", "running", null)]),
    ]);
    expect(s.instances[0]!.anchorEntryId).toBeNull();
  });

  it("重连快照同实例：DTO 锚点覆盖 live 值（无 liveAnchor 双轨保留）", () => {
    const before = play([welcome, completed("m1"), spawn("a1", "m1")]);
    // 重连快照同实例但 DTO 锚点不同（daemon 重组装权威值）→ 直读覆盖
    const after = sessionReducer(
      before,
      ev(snapshotWith([msg("m1"), msg("m2")], [inst("a1", "running", "m2")])),
    );
    expect(after.instances[0]!.anchorEntryId).toBe("m2");
  });

  it("多实例各自直读 DTO 锚点且保清单序", () => {
    const s = play([
      welcome,
      snapshotWith(
        [msg("u1"), msg("sa1-first", "a1"), msg("m2"), msg("sa2-first", "a2"), msg("m3")],
        [inst("a1", "done", "u1"), inst("a2", "running", "m2")],
      ),
    ]);
    expect(s.instances.map((c) => c.instanceId)).toEqual(["a1", "a2"]);
    expect(s.instances[0]!.anchorEntryId).toBe("u1");
    expect(s.instances[1]!.anchorEntryId).toBe("m2");
  });
});

describe("分页前插锚点不漂移（loadEarlier prepend）", () => {
  it("loadHistory.result 前插后锚点 id 引用不变", () => {
    const before = play([welcome, completed("m1"), spawn("a1", "m1")]);
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

describe("推导零残留守护（TP-CL1-6；Q-1c 一步替换无兼容层）", () => {
  const snapshotSrc = readFileSync(new URL("./consumers/snapshot.ts", import.meta.url), "utf8");
  const messageFlowSrc = readFileSync(
    new URL("../../../widgets/chat-stream/ui/MessageFlow.tsx", import.meta.url),
    "utf8",
  );

  it("snapshot.ts 无 anchorFromSnapshot 推导函数残留", () => {
    expect(snapshotSrc).not.toContain("anchorFromSnapshot");
  });

  it("snapshot.ts 无 liveAnchor 双轨残留", () => {
    expect(snapshotSrc).not.toContain("liveAnchor");
  });

  it("MessageFlow.tsx 无 tailCards 钉窗底兜底桶残留", () => {
    expect(messageFlowSrc).not.toContain("tailCards");
  });
});
