/**
 * dispatcher 事件消费者注册表单测（AD-3 前端形态；C2 拆分 T1.1；F(4.0).1）。
 *
 * 机械判据（brief 决策消解）：
 * ① register(type → handler) 映射结构存在，route 按 type 查询；
 * ② 协议全部事件 type 均路由到已注册消费者（无静默吞帧）；
 * ③ 未注册 type → undefined（主 reducer 保持原状态 = 原 applyEvent default 语义）；
 * ④ 族路由正确：type → 对应族消费者 apply 函数。
 * 本任务只搭壳：注册表为纯映射，不接 WS 帧（T3.1 接线）。
 */
import { describe, expect, it } from "vitest";
import { EVENT_TYPES } from "@helix/protocol";
import type { EventEnvelope } from "@helix/protocol";
import { route, register } from "./index";
import type { SessionState } from "../state";
import { applyConnEvent } from "../consumers/conn";
import { applyChatEvent } from "../consumers/chat";
import { applyAgentEvent } from "../consumers/agent";
import { applyThinkingUsageEvent } from "../consumers/thinking-usage";
import { applySnapshotEvent } from "../consumers/snapshot";

describe("dispatcher 事件消费者注册表（AD-3；C2 拆分）", () => {
  it("协议全部事件 type（EVENT_TYPES）均路由到已注册消费者", () => {
    for (const type of EVENT_TYPES) {
      expect(route(type), `未注册事件 type：${type}`).toBeDefined();
    }
  });

  it("route 未注册 type → undefined（主 reducer 保持原状态）", () => {
    expect(route("nonexistent.type")).toBeUndefined();
  });

  it("register(type → handler) 形态：登记后可查、同 type 后注册覆盖", () => {
    const a = (s: SessionState) => s;
    const b = (s: SessionState, _e: EventEnvelope) => s;
    register({ types: ["test.dummy"], apply: a });
    expect(route("test.dummy")).toBe(a);
    register({ types: ["test.dummy"], apply: b });
    expect(route("test.dummy")).toBe(b);
  });

  it("族路由正确：type → 对应族消费者 apply 函数", () => {
    // conn（帧驱动 connection.*；conn 语义归 conn 块）
    expect(route("connection.welcome")).toBe(applyConnEvent);
    expect(route("connection.error")).toBe(applyConnEvent);
    // chat+steer（含 engine.error/tool.call.*/agent.state.changed 归 chat 族定稿）
    expect(route("chat.stream.delta")).toBe(applyChatEvent);
    expect(route("steer.queued")).toBe(applyChatEvent);
    expect(route("engine.error")).toBe(applyChatEvent);
    expect(route("tool.call.started")).toBe(applyChatEvent);
    expect(route("agent.state.changed")).toBe(applyChatEvent);
    // agent 编排族 7 case
    expect(route("agent.spawned")).toBe(applyAgentEvent);
    expect(route("agent.killed")).toBe(applyAgentEvent);
    // thinking/usage/compaction 4 case
    expect(route("thinking.stream.delta")).toBe(applyThinkingUsageEvent);
    expect(route("compaction.completed")).toBe(applyThinkingUsageEvent);
    expect(route("usage.recorded")).toBe(applyThinkingUsageEvent);
    // session 快照 1 case
    expect(route("session.snapshot")).toBe(applySnapshotEvent);
  });
});
