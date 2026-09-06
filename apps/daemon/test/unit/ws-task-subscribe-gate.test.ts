import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import type { FrameSender } from "../../src/adapters/driving/ws-server/EventStream";
import type { ConnState, TaskCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";
import { handleTaskSubscribe, handleTaskUnsubscribe } from "../../src/adapters/driving/ws-server/handlers/task";
import type { TaskQueryService } from "../../src/application/services/task/TaskQueryService";

/**
 * M4②：task 族 subscribeGate——订阅表键 = attach 注册键（ws.data.sender），
 * rawSender 每次新建闭包不可作键（回退路径一旦命中即以全新闭包为键静默
 * no-op，unsubscribe/detach 均无法匹配）。sender 未置位（防御位：正常握手
 * 后恒非空）必须直接早退——不订阅、不回执、不报错（session.ts/agent.ts
 * 同构先例）。
 */

/** stub 上下文：sender 可控，sendNow/commandError/subscribeTask 走 spy 计数。 */
function stubCtx(sender: FrameSender | null) {
  const events = new EventStream();
  const sent: string[] = [];
  const errors: string[] = [];
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  const originalSub = events.subscribeTask.bind(events);
  const originalUnsub = events.unsubscribeTask.bind(events);
  events.subscribeTask = (s, jobId) => { subscribeCalls++; originalSub(s, jobId); };
  events.unsubscribeTask = (s, jobId) => { unsubscribeCalls++; originalUnsub(s, jobId); };
  const ws = { data: { authed: true, sender } } as unknown as ServerWebSocket<ConnState>;
  const ctx: TaskCommandContext = {
    ws,
    type: "task.subscribe",
    payload: {},
    // subscribeGate 只探 undefined——读面形状本测试不消费
    taskQuery: {} as TaskQueryService,
    taskEngine: undefined,
    events,
    commandError: (_type, code) => { errors.push(code); },
    rawSender: () => {
      throw new Error("M4②：rawSender 回退已删——订阅面不得以新闭包为键");
    },
    sendNow: (_s, frame) => { sent.push(frame.type); },
  };
  return { ctx, sent, errors, subscribeCalls: () => subscribeCalls, unsubscribeCalls: () => unsubscribeCalls };
}

describe("M4②：task subscribeGate null sender 早退", () => {
  test("sender 未置位 → task.subscribe 直接早退（不订阅/不回执/不触 rawSender）", () => {
    const { ctx, sent, errors, subscribeCalls } = stubCtx(null);
    handleTaskSubscribe(ctx); // rawSender 被调即抛——早退路径不触
    expect(subscribeCalls()).toBe(0);
    expect(sent).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("sender 未置位 → task.unsubscribe 同口径早退", () => {
    const { ctx, sent, errors, unsubscribeCalls } = stubCtx(null);
    handleTaskUnsubscribe(ctx);
    expect(unsubscribeCalls()).toBe(0);
    expect(sent).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("sender 已置位（正常握手后）→ 订阅注册 + task.subscribe.result 回执（回归）", () => {
    const sender: FrameSender = () => {};
    const { ctx, sent, errors, subscribeCalls } = stubCtx(sender);
    handleTaskSubscribe(ctx);
    expect(subscribeCalls()).toBe(1);
    expect(sent).toEqual(["task.subscribe.result"]);
    expect(errors).toEqual([]);
  });
});
