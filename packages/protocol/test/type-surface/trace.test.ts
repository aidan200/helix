/**
 * trace 族：trace.query 两形态窄化、结果帧形状、v0.4 章印与通道登记锚。
 */
import { describe, expect, test } from "bun:test";
import { EVENT_CHANNELS } from "../../src/index";
import type { EventEnvelope } from "../../src/index";
import type { Equal, Expect, TypeOfChannel } from "./samples/helpers";
import { dispatchCommand, summarizeEvent } from "./samples/helpers";
import { agentInstantiated, agentModelChanged, traceQueryResult, v04Commands, v04Events } from "./samples/v04";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败） ──
type _TraceFamily = Expect<Equal<TypeOfChannel<"trace">, "trace.query.result">>;

describe("trace：trace 命令族与 agent 执行上下文面（源 TP-v0.4-①）", () => {
  test("trace.query 命令两形态（全过滤维 / 全缺省）经 dispatchCommand 窄化", () => {
    expect(v04Commands.map(dispatchCommand)).toEqual([
      "trace-query:sess-1:2:100:428",
      "trace-query:sess-1:all:50:-",
    ]);
  });

  test("trace.query.result / agent.instantiated / agent.model.changed 经 summarizeEvent 窄化", () => {
    expect(v04Events.map(summarizeEvent)).toEqual([
      "trace-result:1:1:1:12:false",
      "instantiated:agent-1:subagent-worker:zai/glm-5.3",
      "model-timeline:main:zhipu/glm-4.6:deepseek/deepseek-chat",
    ]);
  });

  test("当前批帧 v 位与 channel 章印（trace 新族 / agent 族挂两新事件，v0.4 批引入）", () => {
    for (const frame of [...v04Commands, ...v04Events]) {
      expect(frame.v).toBe("0.6"); // v0.5 升位（T2.3；批次集合标记）
    }
    expect(traceQueryResult.channel).toBe("trace");
    expect(agentInstantiated.channel).toBe("agent");
    expect(agentModelChanged.channel).toBe("agent");
    expect(EVENT_CHANNELS["trace.query.result"]).toBe("trace");
    expect(EVENT_CHANNELS["agent.instantiated"]).toBe("agent");
    expect(EVENT_CHANNELS["agent.model.changed"]).toBe("agent");
  });

  test("结果帧形状：filterEcho 缺省维归一 null + instances 面板块 + page 三字段", () => {
    if (traceQueryResult.type !== "trace.query.result") throw new Error("窄化失败");
    const p = traceQueryResult.payload;
    expect(p.filterEcho).toEqual({
      sessionId: "sess-1",
      instanceIds: null,
      agentKind: null,
      types: null,
      timeRange: null,
      page: { limit: 50, beforeId: null },
    });
    expect(p.instances[0]?.snapshotMissing).toBe(false);
    expect(p.instances[0]?.modelTimeline?.[0]?.to).toBe("deepseek/deepseek-chat");
    expect(p.instances[0]?.currentModel).toBe("deepseek/deepseek-chat");
    expect(p.events[0]?.id).toBe(428); // id 游标锚
    expect(p.page).toEqual({ loaded: 1, total: 12, hasMore: false });
  });

});
