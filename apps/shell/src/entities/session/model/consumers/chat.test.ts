/**
 * chat 消费者 · steer.queued 主线 echo 对账（F3a 续修）。
 *
 * 钉住跨源交错场景：create-if-no-echo 支持跨源注入（管家投递/closure/progress
 * 后台发送），队列坞里可能并存「本端 user echo（未确认）」与他源注入帧。原实现
 * 仅按「最早未确认 local echo」FIFO 盲匹配 → 他源帧把本端 echo 的 id 换走
 * （文本与 id 互换，drain 时按 id 出坞错位）。修后：payload.text 存在时按文本
 * 对账，未命中即走 create-if-no-echo 建条目；text 缺席（旧 daemon）回落 FIFO。
 */
import { describe, expect, test } from "vitest";
import type { EventEnvelope, PROTOCOL_VERSION } from "@helix/protocol";
import { applyChatEvent } from "./chat";
import type { SessionState, SteerQueueDockItem } from "../state";

const v = "0.14" as typeof PROTOCOL_VERSION;

function baseState(queue: SteerQueueDockItem[]): SessionState {
  return {
    model: "anthropic/claude",
    sessionId: "s-1",
    entries: [],
    steerQueue: queue,
    instances: [],
    instanceChannels: {},
    channelStreams: {},
    nextChannelSeq: 1,
    thinkingStreams: {},
    lastStreamKind: null,
    usage: { total: 0, compaction: 0, byInstance: {}, ctxByInstance: {} },
    turnUsage: {},
    streaming: null,
    engineError: null,
    engineRetrying: null,
    agentState: "idle",
    view: "ready",
    plan: null,
  } as unknown as SessionState;
}

function queuedEvent(payload: {
  entryId: string;
  text?: string;
  source?: string;
}): EventEnvelope {
  return {
    v,
    sessionId: "s-1",
    channel: "chat",
    type: "steer.queued",
    payload: { ...payload, queuePosition: 1 },
  } as unknown as EventEnvelope;
}

const localEcho = (id: string, text: string): SteerQueueDockItem => ({
  id,
  text,
  confirmed: false,
  ts: 1,
});

describe("applyChatEvent · steer.queued 主线 echo 对账", () => {
  test("跨源交错：他源注入帧不夺本端 echo（按 text 对账 → 未命中建新条目）", () => {
    const s = baseState([localEcho("local:1", "我的追问")]);
    const out = applyChatEvent(
      s,
      queuedEvent({ entryId: "e-guest", text: "管家投递的任务", source: "steward" as never }),
    );
    // 本端 echo 保持未确认、文本/ id 不变
    expect(out.steerQueue[0]).toMatchObject({ id: "local:1", text: "我的追问", confirmed: false });
    // 他源帧按 create-if-no-echo 建独立条目（daemon 权威 id）
    expect(out.steerQueue[1]).toMatchObject({ id: "e-guest", text: "管家投递的任务", confirmed: true });
  });

  test("本端 echo 的确认帧（text 命中）照常对账换 id，且不动他源条目", () => {
    const s = baseState([localEcho("local:1", "我的追问")]);
    const out = applyChatEvent(s, queuedEvent({ entryId: "e-mine", text: "我的追问" }));
    expect(out.steerQueue).toHaveLength(1);
    expect(out.steerQueue[0]).toMatchObject({ id: "e-mine", text: "我的追问", confirmed: true });
  });

  test("旧 daemon 无 text 位：回落 FIFO 保兼容（对账仍换 id）", () => {
    const s = baseState([localEcho("local:1", "我的追问")]);
    const out = applyChatEvent(s, queuedEvent({ entryId: "e-legacy" }));
    expect(out.steerQueue[0]).toMatchObject({ id: "e-legacy", confirmed: true, text: "我的追问" });
  });
});

describe("applyChatEvent · steer.queued 定向 echo 对账（channel 侧）", () => {
  const IID = "agent-xyz";
  function directedState(): SessionState {
    const s = baseState([]);
    return {
      ...s,
      mainInstanceId: "agent-main",
      // entries 本地 echo（ui/steer-instance 双投影之一）
      entries: [
        {
          kind: "message",
          id: "local:1",
          role: "user",
          content: "请复查构建",
          ts: 111,
          steerState: "queued",
          instanceId: IID,
        } as never,
      ],
      // channel 本地 echo（双投影之二）
      instanceChannels: {
        [IID]: [{ kind: "steer-directed", seq: 3, text: "请复查构建", ts: 111, target: IID }],
      },
    };
  }
  function directedEvent(payload: Record<string, unknown>): EventEnvelope {
    return {
      v,
      sessionId: "s-1",
      channel: "chat",
      type: "steer.queued",
      instanceId: IID,
      payload,
    } as unknown as EventEnvelope;
  }

  test("对账：entries echo 换权威 id + channel echo 补 id + ts 对齐权威值", () => {
    const out = applyChatEvent(
      directedState(),
      directedEvent({ entryId: "e9", text: "请复查构建", ts: 1794794000123 }),
    );
    // entries：echo → 权威条目
    expect(out.entries[0]).toMatchObject({ id: "e9", steerState: "queued", instanceId: IID, ts: 1794794000123 });
    // channel：echo 行补权威 id + ts（快照合并去重的身份基）
    const row = out.instanceChannels[IID]![0]!;
    expect(row).toMatchObject({ kind: "steer-directed", text: "请复查构建", id: "e9", ts: 1794794000123, target: IID });
  });

  test("无 echo（他端发送）：payload.ts 携带 → channel 补入权威行", () => {
    const s = directedState();
    const noEcho = { ...s, entries: [], instanceChannels: { [IID]: [] } };
    const out = applyChatEvent(
      noEcho,
      directedEvent({ entryId: "e9", text: "他端注入", ts: 1794794000123 }),
    );
    expect(out.instanceChannels[IID]).toHaveLength(1);
    expect(out.instanceChannels[IID]![0]).toMatchObject({ kind: "steer-directed", text: "他端注入", id: "e9", ts: 1794794000123, target: IID });
  });

  test("旧 daemon（无 payload.ts）：entries 换 id，channel echo 补 id 但 ts 保持客户端值", () => {
    const out = applyChatEvent(
      directedState(),
      directedEvent({ entryId: "e9", text: "请复查构建" }),
    );
    expect(out.entries[0]).toMatchObject({ id: "e9" });
    // channel echo 补权威 id（去重身份 id 优先，ts 是否对齐不影响）；ts 无权威值
    // 可对齐 → 保持客户端 ts（显示时间不变）
    expect(out.instanceChannels[IID]![0]).toMatchObject({ kind: "steer-directed", text: "请复查构建", id: "e9", ts: 111 });
  });
});
