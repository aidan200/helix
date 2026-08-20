/**
 * chat 族：steer 定向寻址两形态（CL-3）与 chat 通道分族类型面。
 */
import { describe, expect, test } from "bun:test";
import type { ChatSteerPayload, EventEnvelope } from "../../src/index";
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
  >
>;

// CL-3 steer 定向寻址：可选 instanceId（缺省 = 主实例）
type _SteerInstanceOptional = Expect<
  Equal<ChatSteerPayload["instanceId"], string | undefined>
>;

describe("chat：chat.steer 定向寻址（源 TP-v0.3-①）", () => {
  test("CL-3 instanceId：定向寻址 / 缺省主实例两形态（dispatch 窄化消费）", () => {
    expect(steerTargeted.payload.instanceId).toBe("agent-1");
    expect(steerMainDefault.payload.instanceId).toBeUndefined(); // 缺省 = 主实例
    expect(dispatchCommand(steerTargeted)).toBe("steer:定向注入 agent-1:agent-1");
    expect(dispatchCommand(steerMainDefault)).toBe("steer:主实例缺省路径:main");
  });

});
