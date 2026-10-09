/**
 * JudgePolicy 判官降级链单测（DDD 重构批 3a——TDD 红→绿）。
 *
 * 断言面：降级三态（off/unready/error）骨架 + interpret 成功路径 + 降级
 * 回调形态（文案组装归消费面——历史文案逐字保留的机制保障）。
 */
import { describe, expect, test } from "bun:test";
import { judgeOrFallback, type JudgeFace } from "../../src/domain/steward/utterance/JudgePolicy";

function judgeFace(opts: {
  enabled?: boolean;
  ready?: boolean;
  noul?: (text: string, question: string) => Promise<number>;
}): JudgeFace {
  return {
    enabled: () => opts.enabled ?? true,
    ready: () => opts.ready ?? true,
    noul: opts.noul ?? (async () => 0.9),
  };
}

describe("judgeOrFallback 降级链（三态统一骨架）", () => {
  test("判官缺席 → fallback + degraded=off + 零通知（默认态零日志）", async () => {
    const notified: string[] = [];
    const r = await judgeOrFallback({
      judge: undefined,
      question: "q",
      text: "t",
      interpret: (s) => s > 0.5,
      fallback: false,
      onDegraded: (k) => notified.push(k),
    });
    expect(r).toEqual({ value: false, degraded: "off" });
    expect(notified).toEqual([]);
  });

  test("开关关 → fallback + degraded=off + 零通知", async () => {
    const notified: string[] = [];
    const r = await judgeOrFallback({
      judge: judgeFace({ enabled: false }),
      question: "q",
      text: "t",
      interpret: () => true,
      fallback: false,
      onDegraded: (k) => notified.push(k),
    });
    expect(r).toEqual({ value: false, degraded: "off" });
    expect(notified).toEqual([]);
  });

  test("端点未配（ready=false）→ fallback + degraded=unready + 通知", async () => {
    const notified: string[] = [];
    const r = await judgeOrFallback({
      judge: judgeFace({ ready: false }),
      question: "q",
      text: "t",
      interpret: () => true,
      fallback: false,
      onDegraded: (k, m) => notified.push(`${k}:${m ?? ""}`),
    });
    expect(r).toEqual({ value: false, degraded: "unready" });
    expect(notified).toEqual(["unready:"]);
  });

  test("抛错 → fallback + degraded=error + 通知携原文（不重试）", async () => {
    const notified: string[] = [];
    let calls = 0;
    const r = await judgeOrFallback({
      judge: judgeFace({
        noul: async () => {
          calls += 1;
          throw new Error("boom");
        },
      }),
      question: "q",
      text: "t",
      interpret: () => true,
      fallback: false,
      onDegraded: (k, m) => notified.push(`${k}:${m ?? ""}`),
    });
    expect(r).toEqual({ value: false, degraded: "error" });
    expect(notified).toEqual(["error:boom"]);
    expect(calls).toBe(1); // 不重试
  });

  test("判定成功 → interpret(score)（零降级通知）", async () => {
    const notified: string[] = [];
    const r = await judgeOrFallback({
      judge: judgeFace({ noul: async () => 0.7 }),
      question: "q",
      text: "t",
      interpret: (s) => (s > 0.5 ? "yes" : "no"),
      fallback: "no",
      onDegraded: (k) => notified.push(k),
    });
    expect(r).toEqual({ value: "yes" });
    expect(notified).toEqual([]);
  });

  test("text 拼装进 noul 首参（用户这句话：…）——消费面契约", async () => {
    const seen: string[] = [];
    await judgeOrFallback({
      judge: judgeFace({ noul: async (text) => (seen.push(text), 0.5) }),
      question: "q",
      text: "看看情况",
      interpret: () => true,
      fallback: false,
    });
    expect(seen).toEqual(["用户这句话：看看情况"]);
  });
});
