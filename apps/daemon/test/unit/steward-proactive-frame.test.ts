/**
 * M3-a 批：对话内主动汇报实时帧单测（CAND-601 闭环——reportProactive
 * additive 事件帧 steward.proactive，面板开着实时冒条目，不重开面板）。
 *
 * 断言面：
 * - reportProactive → 工作记忆 assistant 记录照写（回放同源不变）+
 *   emitProactive 恰一次（title/text/suggestions/seq 单调）；
 * - emitProactive 缺席（测试形态/未装配）→ 零帧零异常（语义面零降级）；
 * - EventStream.broadcastStewardProactive：daemon 级全局帧（信封
 *   SYSTEM_SESSION_ID + channel "steward"），按连接级 steward 订阅位过滤。
 */
import { describe, expect, test } from "bun:test";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type { StewardLlmPort } from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import { StewardService } from "../../src/application/steward/StewardService";
import { StewardDialogMemory } from "../../src/application/steward/StewardDialogMemory";
import { fakeDialogStore } from "./helpers/fake-steward-dialog-store";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import type { EventEnvelope, StewardProactivePayload } from "@helix/protocol";

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort {
  const kv = new Map(Object.entries(initial));
  return {
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  };
}

function makeService(opts: { emitProactive?: (payload: StewardProactivePayload) => void }) {
  const llm: StewardLlmPort = {
    modelId: "fake/flash",
    async complete() {
      throw new Error("本批测试零 LLM");
    },
  };
  const innerCreate = createEngineFromPort(llm);
  const dialog = new StewardDialogMemory(fakeDialogStore());
  const svc = new StewardService({
    llm,
    orchestration: { status: () => [], send: () => ({ delivered: false, detail: "无实例" }) },
    tasks: { listTasks: () => [] },
    config: fakeConfig({ "steward.enabled": "1" }),
    dialog,
    clock: () => 42_000,
    feedGate: { hasStewardSubscribers: () => true },
    emitFeed: () => undefined,
    createEngine: (engineOpts) => innerCreate(engineOpts),
    ...(opts.emitProactive !== undefined ? { emitProactive: opts.emitProactive } : {}),
  });
  return { svc, dialog };
}

describe("M3-a reportProactive 实时帧（工作记忆 + additive 帧双写）", () => {
  test("汇报 → assistant 记录照写（【主动汇报】行——回放同源）+ 帧恰一次（title/text/suggestions/seq）", async () => {
    const frames: StewardProactivePayload[] = [];
    const { svc, dialog } = makeService({ emitProactive: (p) => frames.push(p) });
    await svc.reportProactive({
      title: "部署完成",
      text: "部署服务这轮跑完了，健康检查全部通过。",
      suggestions: [{ label: "看看报告", verb: "open_tasks" }],
    });
    // 工作记忆记录（面板重开后回放可见——原有语义不变）
    const records = dialog.snapshot();
    const last = records[records.length - 1]!;
    expect(last.kind).toBe("assistant");
    if (last.kind !== "assistant") throw new Error("unreachable");
    expect(last.text).toContain("【主动汇报】部署完成");
    expect(last.text).toContain("健康检查全部通过");
    expect(last.text).toContain("建议：看看报告");
    // 实时帧：additive 事件帧（开着的面板实时冒条目）
    expect(frames.length).toBe(1);
    expect(frames[0]!.title).toBe("部署完成");
    expect(frames[0]!.text).toContain("健康检查全部通过");
    expect(frames[0]!.suggestions).toEqual([{ label: "看看报告", verb: "open_tasks" }]);
    expect(frames[0]!.seq).toBe(1); // 单调序号（1 起）
  });

  test("多次汇报 → seq 单调递增", async () => {
    const frames: StewardProactivePayload[] = [];
    const { svc } = makeService({ emitProactive: (p) => frames.push(p) });
    await svc.reportProactive({ title: "一", text: "t1", suggestions: [] });
    await svc.reportProactive({ title: "二", text: "t2", suggestions: [] });
    expect(frames.map((f) => f.seq)).toEqual([1, 2]);
  });

  test("emitProactive 缺席 → 零帧零异常（记录照写——语义面零降级）", async () => {
    const { svc, dialog } = makeService({});
    await svc.reportProactive({ title: "静默", text: "无帧形态", suggestions: [] });
    const records = dialog.snapshot();
    expect(records[records.length - 1]!.kind).toBe("assistant");
  });
});

describe("M3-a EventStream.broadcastStewardProactive（连接级订阅过滤）", () => {
  test("订阅连接收到帧（SYSTEM_SESSION_ID + channel steward + suggestions 透传）；未订阅连接零帧", () => {
    const stream = new EventStream();
    const subscribed: EventEnvelope[] = [];
    const bystander: EventEnvelope[] = [];
    const subSender = (frame: EventEnvelope) => subscribed.push(frame);
    const otherSender = (frame: EventEnvelope) => bystander.push(frame);
    stream.attach(subSender);
    stream.attach(otherSender);
    stream.subscribeSteward(subSender);

    stream.broadcastStewardProactive({ title: "部署完成", text: "跑完了", suggestions: [], seq: 1 });
    expect(subscribed.length).toBe(1);
    const frame = subscribed[0]!;
    expect(frame.type).toBe("steward.proactive");
    expect(frame.channel).toBe("steward");
    expect(frame.sessionId).toBe("__system__"); // 全局帧信封纪律（E-84：daemon 级无会话作用域）
    expect(frame.payload).toEqual({ title: "部署完成", text: "跑完了", suggestions: [], seq: 1 });
    expect(bystander.length).toBe(0); // 未订阅连接不收
  });
});
