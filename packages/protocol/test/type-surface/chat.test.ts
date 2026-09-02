/**
 * chat 族：steer 定向寻址两形态（CL-3）与 chat 通道分族类型面。
 */
import { describe, expect, test } from "bun:test";
import type { ChatSteerPayload, EventEnvelope, MessageEntryDto, SteerDrainedPayload, SteerQueuedPayload } from "../../src/index";
import type { Equal, Expect, TypeOfChannel } from "./samples/helpers";
import { dispatchCommand } from "./samples/helpers";
import { steerMainDefault, steerTargeted } from "./samples/v03";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败） ──
// 八族类型学：各 channel 分族 type 联合恰等（契约 A §2 映射表）
type _ChatFamily = Expect<
  Equal<
    TypeOfChannel<"chat">,
    | "chat.stream.delta"
    | "chat.turn.started"
    | "chat.turn.completed"
    | "chat.message.completed"
    | "steer.queued"
    | "steer.drained"
    | "tool.call.started"
    | "tool.call.result"
    | "agent.state.changed"
    | "engine.error"
    | "engine.retrying"
    | "error.entry"
  >
>;

// CL-3 steer 定向寻址：可选 instanceId（缺省 = 主实例）
type _SteerInstanceOptional = Expect<
  Equal<ChatSteerPayload["instanceId"], string | undefined>
>;

// T11a（v0.11 批内补登）：steer 两事件载荷 + MessageEntryDto 贯通注入来源三值枚举
// （user=用户 steer / closure=SubAgent 收口注入 / progress=周期进展报告；缺省 = 老数据按 user）
type _SteerSource = Expect<
  Equal<SteerQueuedPayload["source"], "user" | "closure" | "progress" | undefined>
>;
type _SteerDrainedSource = Expect<
  Equal<SteerDrainedPayload["source"], "user" | "closure" | "progress" | undefined>
>;
type _MessageEntrySource = Expect<
  Equal<MessageEntryDto["source"], "user" | "closure" | "progress" | undefined>
>;

describe("chat：chat.steer 定向寻址（源 TP-v0.3-①）", () => {
  test("CL-3 instanceId：定向寻址 / 缺省主实例两形态（dispatch 窄化消费；命令侧缺省路由，T10 起按 main kind 判别）", () => {
    expect(steerTargeted.payload.instanceId).toBe("agent-1");
    expect(steerMainDefault.payload.instanceId).toBeUndefined(); // 缺省 = 主实例（命令侧缺省路由语义）
    expect(dispatchCommand(steerTargeted)).toBe("steer:定向注入 agent-1:agent-1");
    expect(dispatchCommand(steerMainDefault)).toBe("steer:主实例缺省路径:main");
  });

});

describe("chat：steer 来源区分（T11a closure/steer source 贯通）", () => {
  test("steer.queued/drained 载荷可携带 source 三值；缺省兼容老事件", () => {
    const queued: SteerQueuedPayload = { entryId: "e1", source: "closure" };
    const drained: SteerDrainedPayload = { entryId: "e1", source: "progress" };
    const legacy: SteerQueuedPayload = { entryId: "e2" }; // 老形状（无 source）仍合法
    expect(queued.source).toBe("closure");
    expect(drained.source).toBe("progress");
    expect(legacy.source).toBeUndefined();
  });

  test("MessageEntryDto.source：closure 注入 idle 落的 user 条目携带来源", () => {
    const entry: MessageEntryDto = {
      kind: "message",
      id: "e3",
      role: "user",
      content: "agent-1 closure: done — 完成",
      ts: 0,
      source: "closure",
    };
    expect(entry.source).toBe("closure");
  });
});
