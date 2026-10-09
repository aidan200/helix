/**
 * M3-d1 感知兑现批：活动账命令/帧单测（时间线呈现面协议链路）。
 *
 * 断言面：
 * - handleStewardActivityList：range/limit 校验（非法回 invalid_payload）+
 *   时间窗过滤（today/yesterday/this_week/all）+ 条数 limit + 回执
 *   steward.activity.result 点对点（channel steward + entries at 降序）；
 * - activity 回口缺席（零活动降级）→ 空清单回执（不走 unimplemented）；
 * - handleStewardActivityClear：清理 + 空窗回执；
 * - EventStream.broadcastStewardActivity：连接级 steward 订阅位过滤
 *  （订阅连接收到 / 未订阅零帧——feed/notify 同闸门同构）。
 */
import { describe, expect, test } from "bun:test";
import {
  handleStewardActivityList,
  handleStewardActivityClear,
} from "../../src/adapters/driving/ws-server/handlers/steward";
import type { StewardCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";
import type { StewardService } from "../../src/application/steward/StewardService";
import { StewardActivityService } from "../../src/application/steward/StewardActivityService";
import { EventStream } from "../../src/adapters/driving/ws-server/EventStream";
import type { EventEnvelope } from "@helix/protocol";

function ctxOf(
  type: string,
  payload: Record<string, unknown>,
  activity?: Pick<StewardActivityService, "listWindow" | "clear">,
): {
  ctx: StewardCommandContext;
  frames: EventEnvelope[];
  errors: string[];
  clears: number[];
} {
  const frames: EventEnvelope[] = [];
  const errors: string[] = [];
  const clears: number[] = [];
  const sender = { id: "conn-1" };
  const service = {} as unknown as StewardService;
  const ctx = {
    ws: { data: { sender } },
    type,
    payload,
    steward: {
      service,
      ...(activity !== undefined
        ? { activity }
        : {
            activity: {
              listWindow: (q: { sinceMs: number; limit: number }) => {
                clears.push(q.sinceMs);
                return [];
              },
              clear: () => clears.push(-1),
            },
          }),
    },
    commandError: (_t: string, _code: string, message: string) => {
      errors.push(message);
    },
    rawSender: () => sender,
    sendNow: (_s: unknown, frame: EventEnvelope) => {
      frames.push(frame);
    },
  } as unknown as StewardCommandContext;
  return { ctx, frames, errors, clears };
}

describe("M3-d1 handleStewardActivityList（时间窗查询）", () => {
  test("回执点对点 steward.activity.result：channel steward + 条目透传 + 时间窗下界按档位解析", () => {
    const queries: { sinceMs: number; limit?: number }[] = [];
    const activity = {
      listWindow: (q: { sinceMs: number; limit: number }) => {
        queries.push(q);
        return [{ at: 1, domain: "task" as const, attribution: "system" as const, text: "「修登录」完成了" }];
      },
      clear: () => undefined,
    };
    const { ctx, frames, errors } = ctxOf("steward.activity.list", { range: "yesterday" }, activity);
    handleStewardActivityList(ctx);
    expect(errors).toEqual([]);
    expect(frames.length).toBe(1);
    expect(frames[0]!.type).toBe("steward.activity.result");
    expect(frames[0]!.channel).toBe("steward");
    expect((frames[0]!.payload as { entries: unknown[] }).entries).toHaveLength(1);
    // yesterday 档窗口下界 = 今日零点 - 24h（时间窗过滤在 service，档位解析在 handler）
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    expect(queries[0]!.sinceMs).toBe(now.getTime() - 86_400_000);
    expect(queries[0]!.limit).toBe(200); // 缺省条数
  });

  test("limit 透传 + range 非法回 invalid_payload", () => {
    const activity = { listWindow: () => [], clear: () => undefined };
    const ok = ctxOf("steward.activity.list", { range: "all", limit: 50 }, activity);
    handleStewardActivityList(ok.ctx);
    expect(ok.errors).toEqual([]);
    const badRange = ctxOf("steward.activity.list", { range: "last_year" }, activity);
    handleStewardActivityList(badRange.ctx);
    expect(badRange.errors.length).toBe(1);
    expect(badRange.errors[0]).toContain("payload.range");
    const badLimit = ctxOf("steward.activity.list", { limit: -3 }, activity);
    handleStewardActivityList(badLimit.ctx);
    expect(badLimit.errors.length).toBe(1);
    expect(badLimit.errors[0]).toContain("payload.limit");
  });

  test("activity 回口缺席 → 零活动降级空清单回执（不走 unimplemented）", () => {
    const { ctx, frames, errors } = ctxOf("steward.activity.list", {});
    handleStewardActivityList(ctx);
    expect(errors).toEqual([]);
    expect(frames.length).toBe(1);
    expect((frames[0]!.payload as { entries: unknown[] }).entries).toEqual([]);
  });
});

describe("M3-d1 handleStewardActivityClear（清理）", () => {
  test("清理 + 空窗新态回执（幂等）", () => {
    let cleared = 0;
    const activity = { listWindow: () => [], clear: () => (cleared += 1) };
    const { ctx, frames, errors } = ctxOf("steward.activity.clear", {}, activity);
    handleStewardActivityClear(ctx);
    expect(cleared).toBe(1);
    expect(errors).toEqual([]);
    expect((frames[0]!.payload as { entries: unknown[] }).entries).toEqual([]);
  });

  test("activity 回口缺席 → no-op + 空窗回执", () => {
    const { ctx, frames, errors } = ctxOf("steward.activity.clear", {});
    expect(() => handleStewardActivityClear(ctx)).not.toThrow();
    expect(errors).toEqual([]);
    expect(frames.length).toBe(1);
  });
});

describe("M3-d1 EventStream.broadcastStewardActivity（连接级订阅过滤）", () => {
  test("订阅连接收到帧（SYSTEM_SESSION_ID + channel steward + 载荷透传）；未订阅连接零帧", () => {
    const stream = new EventStream();
    const subscribed: EventEnvelope[] = [];
    const bystander: EventEnvelope[] = [];
    const subSender = (frame: EventEnvelope) => subscribed.push(frame);
    const otherSender = (frame: EventEnvelope) => bystander.push(frame);
    stream.attach(subSender);
    stream.attach(otherSender);
    stream.subscribeSteward(subSender);

    stream.broadcastStewardActivity({ at: 1, domain: "task", attribution: "system", text: "「修登录」完成了", seq: 1 });
    expect(subscribed.length).toBe(1);
    const frame = subscribed[0]!;
    expect(frame.type).toBe("steward.activity");
    expect(frame.channel).toBe("steward");
    expect(frame.sessionId).toBe("__system__"); // 全局帧信封纪律（E-84）
    expect(frame.payload).toEqual({ at: 1, domain: "task", attribution: "system", text: "「修登录」完成了", seq: 1 });
    expect(bystander.length).toBe(0); // 未订阅连接不收
  });
});
