/**
 * B2 barge-in 批：steward.interrupt 命令处理面单测（TDD 红→绿）。
 *
 * 断言面（任务 brief 测试要求逐条）：
 * 1. 接线：payload 缺省 → StewardService.abortInFlight("barge-in")；
 *    payload.reason 携带 → 原样透传（reason ?? "barge-in" 语义）；
 * 2. 回执面零帧（设计 §3.2：回执可省——loop.run.interrupted + ask 终态
 *    事件面已够）；
 * 3. payload 校验：reason 非 string → command.invalid_payload，零 abort；
 * 4. 重复触发幂等：无在途时 abortInFlight 返回 false 照常静默（no-op 不报错
 *    ——service 侧幂等语义 T9 已钉，本面只验转发不吞返回值不二次回执）。
 */
import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "@helix/protocol";
import { handleStewardInterrupt } from "../../src/adapters/driving/ws-server/handlers/steward";
import type { StewardCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";
import type { StewardService } from "../../src/application/steward/StewardService";

function ctxOf(payload: Record<string, unknown>, abortReturn = true): {
  ctx: StewardCommandContext;
  frames: EventEnvelope[];
  errors: string[];
  aborts: string[];
  interruptAlls: string[];
} {
  const frames: EventEnvelope[] = [];
  const errors: string[] = [];
  const aborts: string[] = [];
  const interruptAlls: string[] = [];
  const sender = { id: "conn-1" };
  const service = {
    abortInFlight: (reason: string): boolean => {
      aborts.push(reason);
      return abortReturn;
    },
    interruptAll: (reason: string): number => {
      interruptAlls.push(reason);
      return 0;
    },
  } as unknown as StewardService;
  const ctx = {
    ws: { data: { sender } },
    type: "steward.interrupt",
    payload,
    steward: {
      service,
      stream: { subscribeSteward: () => {}, unsubscribeSteward: () => {} },
    },
    commandError: (_type: string, _code: string, message: string) => {
      errors.push(message);
    },
    rawSender: () => sender,
    sendNow: (_s: unknown, frame: EventEnvelope) => {
      frames.push(frame);
    },
  } as unknown as StewardCommandContext;
  return { ctx, frames, errors, aborts, interruptAlls };
}

describe("handleStewardInterrupt（ws handler 转发面）", () => {
  test("payload 缺省 → abortInFlight(\"barge-in\")；零回执帧（事件面已够）", () => {
    const { ctx, frames, errors, aborts } = ctxOf({});
    handleStewardInterrupt(ctx);
    expect(aborts).toEqual(["barge-in"]);
    expect(frames).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  test("payload.reason 原样透传（reason ?? \"barge-in\" 语义）", () => {
    const { ctx, aborts } = ctxOf({ reason: "user-中止" });
    handleStewardInterrupt(ctx);
    expect(aborts).toEqual(["user-中止"]);
  });

  test("reason 非 string → command.invalid_payload，零 abort", () => {
    const { ctx, errors, aborts } = ctxOf({ reason: 42 });
    handleStewardInterrupt(ctx);
    expect(aborts).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("payload.reason");
  });

  test("重复触发幂等：无在途 abortInFlight=false 照常静默（零回执零报错）", () => {
    const { ctx, frames, errors, aborts } = ctxOf({}, false);
    handleStewardInterrupt(ctx);
    handleStewardInterrupt(ctx);
    expect(aborts).toEqual(["barge-in", "barge-in"]);
    expect(frames).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  // ── 批 3b 两轨裁决乙：scope 分野（语音停止词 = all 全停；面板钮缺省 = current 轻停）──

  test("scope=all → interruptAll（abort 当前 + 清空队列）零 abortInFlight 轻停通道", () => {
    const { ctx, aborts, interruptAlls, errors } = ctxOf({ scope: "all" });
    handleStewardInterrupt(ctx);
    expect(interruptAlls).toEqual(["语音停止词全停"]);
    expect(aborts).toHaveLength(0); // 轻停通道不走（interruptAll 内部自调 service 实现，不回环 handler）
    expect(errors).toHaveLength(0);
  });

  test("scope=all + reason 原样透传", () => {
    const { ctx, interruptAlls } = ctxOf({ scope: "all", reason: "barge-in" });
    handleStewardInterrupt(ctx);
    expect(interruptAlls).toEqual(["barge-in"]);
  });

  test("scope=current 显式 → 轻停（与缺省同径——面板停止钮向后兼容）", () => {
    const { ctx, aborts, interruptAlls } = ctxOf({ scope: "current" });
    handleStewardInterrupt(ctx);
    expect(aborts).toEqual(["barge-in"]);
    expect(interruptAlls).toHaveLength(0);
  });

  test("scope 非法值 → command.invalid_payload，零 abort 零 interruptAll", () => {
    const { ctx, errors, aborts, interruptAlls } = ctxOf({ scope: "everything" });
    handleStewardInterrupt(ctx);
    expect(aborts).toHaveLength(0);
    expect(interruptAlls).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("payload.scope");
  });
});
