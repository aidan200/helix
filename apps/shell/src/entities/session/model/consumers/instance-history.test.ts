/**
 * instance-history 消费者测试 —— session.instanceChannels.result 回填
 * （channels 惰性化批）：三槽全量归并重建实例 channel 列表（替换快照
 * 预览态），spawned/modelResolved 头部与 closure 尾卡保持同构。
 */
import { describe, expect, test } from "vitest";
import type { EventEnvelope, PROTOCOL_VERSION } from "@helix/protocol";
import { applyInstanceHistoryEvent } from "./instance-history";
import type { SessionState } from "../state";

const v = "0.14" as typeof PROTOCOL_VERSION;

function baseState(): SessionState {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return {
    model: "anthropic/claude",
    instances: [
      {
        instanceId: "agent-1",
        kind: "subagent",
        profileKind: "subagent-worker",
        state: "done",
        createdAt: new Date(0).toISOString(),
        model: "deepseek/deepseek-chat",
        closure: { summary: "收口", status: "ok" },
      },
    ],
    instanceChannels: {
      // 快照预览态：spawned + model + 1 条预览（将被全量替换）
      "agent-1": [
        { kind: "lifecycle", seq: 1, lc: "spawned" },
        { kind: "lifecycle", seq: 2, lc: "modelResolved" },
        { kind: "message", seq: 3, entry: { kind: "message", id: "m-9", instanceId: "agent-1", role: "assistant", content: "预览", createdAt: new Date(9000).toISOString() } },
      ],
    },
  } as unknown as SessionState;
}

function resultEvent(channels: Record<string, unknown>): EventEnvelope {
  return {
    v,
    sessionId: "s-1",
    channel: "session",
    type: "session.instanceChannels.result",
    payload: { instanceId: "agent-1", channels, hasMore: false, nextCursor: null },
  } as unknown as EventEnvelope;
}

describe("applyInstanceHistoryEvent（session.instanceChannels.result 回填）", () => {
  test("三槽全量归并：重建实例 channel（spawned/model 头 + 升序条目 + closure 尾），替换预览态", () => {
    const out = applyInstanceHistoryEvent(baseState(), resultEvent({
      thinking: [{ kind: "thinking", id: "t-1", instanceId: "agent-1", text: "思考", durationMs: 5, createdAt: new Date(1000).toISOString() }],
      messages: [
        { kind: "message", id: "m-2", instanceId: "agent-1", role: "assistant", content: "第二条", createdAt: new Date(2000).toISOString() },
        { kind: "message", id: "m-1", instanceId: "agent-1", role: "assistant", content: "第一条", createdAt: new Date(1500).toISOString() },
      ],
      tools: [{ kind: "tool-call", id: "tc-1", instanceId: "agent-1", name: "bash", args: "{}", status: "ok", result: "输出", startedAt: new Date(3000).toISOString(), endedAt: new Date(3001).toISOString() }],
    }));
    const items = out.instanceChannels["agent-1"]!;
    // 头部两条 lifecycle（modelResolved 用实例卡 declared 模型）
    expect(items[0]).toMatchObject({ kind: "lifecycle", lc: "spawned" });
    expect(items[1]).toMatchObject({ kind: "lifecycle", lc: "modelResolved", model: "deepseek/deepseek-chat", slot: "declared" });
    // 全量条目升序打平（t-1 → m-1 → m-2 → tc-1）；预览条 m-9 被替换归零
    const shape = items.slice(2).map((i) => {
      if (i.kind === "thinking-entry") return `t:${i.entry.id}`;
      if (i.kind === "tool") return `tool:${i.entry.id}`;
      if (i.kind === "message") return `m:${i.text}`;
      return i.kind;
    });
    expect(shape).toEqual(["t:t-1", "m:第一条", "m:第二条", "tool:tc-1", "closure"]);
    // closure 尾卡保持（实例卡已有 closure）——shape 已含 closure
  });

  test("未知实例/其他事件：原样返回（不建空 channel）", () => {
    const s = baseState();
    const wrongInstance = resultEvent({}) as unknown as { payload: { instanceId: string } };
    wrongInstance.payload.instanceId = "agent-x";
    expect(applyInstanceHistoryEvent(s, wrongInstance as unknown as EventEnvelope)).toBe(s);
    const other = { v, sessionId: "s-1", channel: "session", type: "session.list.result", payload: { sessions: [] } } as unknown as EventEnvelope;
    expect(applyInstanceHistoryEvent(s, other)).toBe(s);
  });

  test("无 closure 实例卡：重建不含尾卡（运行中实例回填）", () => {
    const s = baseState();
    s.instances[0]!.closure = undefined;
    const out = applyInstanceHistoryEvent(s, resultEvent({
      messages: [{ kind: "message", id: "m-1", instanceId: "agent-1", role: "assistant", content: "hi", createdAt: new Date(1000).toISOString() }],
    }));
    const items = out.instanceChannels["agent-1"]!;
    expect(items[items.length - 1]!.kind).not.toBe("closure");
  });

  test("回填推进 nextChannelSeq（seq 单调递增契约）：回填后实时条目不与回填条目撞 seq", () => {
    const s = baseState();
    s.nextChannelSeq = 4; // 回填前全局计数器（远小于回填后的 seq 上界）
    const out = applyInstanceHistoryEvent(s, resultEvent({
      messages: [
        { kind: "message", id: "m-1", instanceId: "agent-1", role: "assistant", content: "一", createdAt: new Date(1000).toISOString() },
        { kind: "message", id: "m-2", instanceId: "agent-1", role: "assistant", content: "二", createdAt: new Date(2000).toISOString() },
      ],
    }));
    const maxSeq = Math.max(...out.instanceChannels["agent-1"]!.map((i) => i.seq));
    expect(out.nextChannelSeq).toBeGreaterThan(maxSeq);
  });

  test("回放补 crashed 终态行（增量路盲区修复）：failed 卡回填后 channel 含 error 透传的 crashed 行（closure 前）", () => {
    const s = baseState();
    s.instances[0]!.state = "failed";
    s.instances[0]!.error = "engine 收口失败（engine: 401: invalid x-api-key）";
    s.instances[0]!.closure = { summary: "engine 收口失败（engine: 401: invalid x-api-key）", status: "failed" } as never;
    const out = applyInstanceHistoryEvent(s, resultEvent({
      messages: [{ kind: "message", id: "m-1", instanceId: "agent-1", role: "assistant", content: "hi", createdAt: new Date(1000).toISOString() }],
    }));
    const items = out.instanceChannels["agent-1"]!;
    const crashed = items.find((i) => i.kind === "lifecycle" && i.lc === "crashed") as { error?: string } | undefined;
    expect(crashed, "回放应重建 crashed 终态行（后开抽屉/重启后不丢终态交代）").toBeDefined();
    expect(crashed!.error).toContain("invalid x-api-key");
    // 顺序：crashed 在 closure 尾卡之前（与增量路 agent.failed 原子推送序同构）
    const ci = items.findIndex((i) => i.kind === "lifecycle" && i.lc === "crashed");
    const ki = items.findIndex((i) => i.kind === "closure");
    expect(ci).toBeLessThan(ki);
  });

  test("回放补 terminated 行（killed 实例）：terminated 卡回填后 channel 含 terminated 行而非 crashed", () => {
    const s = baseState();
    s.instances[0]!.state = "failed";
    s.instances[0]!.terminated = true;
    const out = applyInstanceHistoryEvent(s, resultEvent({
      messages: [{ kind: "message", id: "m-1", instanceId: "agent-1", role: "assistant", content: "hi", createdAt: new Date(1000).toISOString() }],
    }));
    const items = out.instanceChannels["agent-1"]!;
    expect(items.find((i) => i.kind === "lifecycle" && i.lc === "terminated"), "killed 实例回放应出 terminated 交代行").toBeDefined();
    expect(items.find((i) => i.kind === "lifecycle" && i.lc === "crashed")).toBeUndefined();
  });
});
