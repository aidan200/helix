import { describe, expect, test } from "bun:test";
import { handleAskAnswer } from "../../src/adapters/driving/ws-server/handlers/ask";
import type { WsCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";
import { AskService } from "../../src/application/services/AskService";

/** 最小 stub：只钉 handleAskAnswer 消费面（commandError/envelope/payload/askService）。 */
function ctxOf(overrides: {
  payload?: Record<string, unknown>;
  sessionId?: unknown;
  askService?: AskService;
}): { ctx: WsCommandContext; errors: Array<{ code: string; message: string }> } {
  const errors: Array<{ code: string; message: string }> = [];
  const ctx = {
    type: "ask.answer",
    payload: overrides.payload ?? {},
    envelope: { sessionId: overrides.sessionId },
    askService: overrides.askService,
    commandError: (_type: string, code: string, message: string) => {
      errors.push({ code, message });
    },
  } as unknown as WsCommandContext;
  return { ctx, errors };
}

/** 真 AskService（事件/KV 用 no-op stub）——裁决行为走真实现。 */
function askServiceOf(): { svc: AskService; answered: string[] } {
  const answered: string[] = [];
  let seq = 0;
  const svc = new AskService({
    publish: () => {},
    kv: { get: () => undefined, set: async () => {} },
    now: () => Date.now(),
    newId: () => `ask-${++seq}`,
  });
  // 包一层记录 answer 调用（行为探针）
  const orig = svc.answer.bind(svc);
  svc.answer = (sessionId: string, askId: string, approved: boolean) => {
    answered.push(`${sessionId}:${askId}:${approved}`);
    return orig(sessionId, askId, approved);
  };
  return { svc, answered };
}

describe("handleAskAnswer", () => {
  test("askService 未装配 → command.unimplemented", () => {
    const { ctx, errors } = ctxOf({ payload: { askId: "a1", approved: true }, sessionId: "s1" });
    handleAskAnswer(ctx);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe("command.unimplemented");
  });

  test("载荷缺 askId/approved/sessionId → command.invalid_payload", () => {
    const { svc } = askServiceOf();
    for (const bad of [
      { payload: { approved: true }, sessionId: "s1" }, // 缺 askId
      { payload: { askId: "a1" }, sessionId: "s1" }, // 缺 approved
      { payload: { askId: "a1", approved: true }, sessionId: undefined }, // 缺 sessionId
      { payload: { askId: "", approved: true }, sessionId: "s1" }, // 空 askId
    ]) {
      const { ctx, errors } = ctxOf({ ...bad, askService: svc });
      handleAskAnswer(ctx);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.code).toBe("command.invalid_payload");
    }
  });

  test("合法裁决 → AskService.answer 幂等转发（无挂起申请静默吞）", () => {
    const { svc, answered } = askServiceOf();
    const { ctx, errors } = ctxOf({
      payload: { askId: "a1", approved: true },
      sessionId: "s1",
      askService: svc,
    });
    handleAskAnswer(ctx);
    expect(errors).toHaveLength(0);
    expect(answered).toEqual(["s1:a1:true"]);
  });
});
