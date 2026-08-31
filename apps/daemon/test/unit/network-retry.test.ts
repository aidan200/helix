import { describe, expect, test } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  abortableSleep,
  classifyLlmError,
  LLM_RETRY_BACKOFF_MS,
  withNetworkRetry,
  type LlmRetryInfo,
} from "../../src/adapters/driven/pi-engine/network-retry";

/**
 * P2 ⑦ 引擎级网络重试单测：
 * - classifyLlmError 纯函数分类面（瞬时/永久/缺省安全）；
 * - withNetworkRetry：失败 2 次后成功（假时钟断言退避序列消费）、
 *   持续瞬时失败恰 4 次尝试（1+3）后退避耗尽走既有失败路径、
 *   永久类 1 次即失败、abort 打断等待、中途断流不重试。
 */

const fakeModel = {
  id: "fake-model",
  api: "anthropic-messages",
  provider: "anthropic",
} as unknown as Model<any>;

function errorMessage(message: string, stopReason: "error" | "aborted" = "error"): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    errorMessage: message,
    timestamp: 0,
  } as unknown as AssistantMessage;
}

function okMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  } as unknown as AssistantMessage;
}

/** 剧本流工厂：error = 纯 error 单帧（pi-ai 请求期失败同构）；ok = start+delta+done；midstream = start+delta 后 error（中途断流形态）。 */
function scriptedStream(script: { kind: "error"; message: string } | { kind: "ok"; text: string } | { kind: "midstream"; message: string }) {
  const stream = createAssistantMessageEventStream();
  if (script.kind === "error") {
    stream.push({ type: "error", reason: "error", error: errorMessage(script.message) });
  } else if (script.kind === "midstream") {
    const partial = okMessage("");
    stream.push({ type: "start", partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "半句", partial });
    stream.push({ type: "error", reason: "error", error: errorMessage(script.message) });
  } else {
    const final = okMessage(script.text);
    stream.push({ type: "start", partial: final });
    stream.push({ type: "text_delta", contentIndex: 0, delta: script.text, partial: final });
    stream.push({ type: "done", reason: "stop", message: final });
  }
  return stream;
}

/** 序列剧本 streamFn：按调用序消费剧本（耗尽重复末项）；记录调用次数。 */
function scriptedStreamFn(scripts: Parameters<typeof scriptedStream>[0][], calls: number[] = []) {
  const fn: StreamFn = () => {
    calls.push(1);
    const idx = Math.min(calls.length - 1, scripts.length - 1);
    return scriptedStream(scripts[idx]!);
  };
  return { fn, callCount: () => calls.length };
}

/** 假时钟：记录消费的退避序列，立即Resolve（不真等）。 */
function fakeClock(slept: number[] = []) {
  return {
    slept,
    sleep: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
}

async function collect(
  source: AsyncIterable<AssistantMessageEvent> | Promise<AsyncIterable<AssistantMessageEvent>>,
): Promise<AssistantMessageEvent[]> {
  const out: AssistantMessageEvent[] = [];
  for await (const e of await source) out.push(e);
  return out;
}

// ── classifyLlmError（纯函数分类面） ────────────────────────

describe("classifyLlmError", () => {
  test("网络错/超时 → 瞬时", () => {
    expect(classifyLlmError("error", "fetch failed")).toBe("transient");
    expect(classifyLlmError("error", "Unable to connect: ECONNRESET")).toBe("transient");
    expect(classifyLlmError("error", "connect ETIMEDOUT")).toBe("transient");
    expect(classifyLlmError("error", "socket hang up")).toBe("transient");
    expect(classifyLlmError("error", "Request timed out")).toBe("transient");
    expect(classifyLlmError("error", "read EPIPE")).toBe("transient");
  });

  test("HTTP 429/5xx/408 → 瞬时（嵌入任意形态）", () => {
    expect(classifyLlmError("error", "429: {\"code\":\"1308\"}")).toBe("transient");
    expect(classifyLlmError("error", "provider 429 quota exceeded")).toBe("transient");
    expect(classifyLlmError("error", "503 Service Unavailable")).toBe("transient");
    expect(classifyLlmError("error", "anthropic (500): Internal Server Error")).toBe("transient");
    expect(classifyLlmError("error", "HTTP 502 Bad Gateway")).toBe("transient");
    expect(classifyLlmError("error", "408 Request Timeout")).toBe("transient");
    expect(classifyLlmError("error", "529 overloaded_error")).toBe("transient");
  });

  test("HTTP 401/403/400/404/422 → 永久（鉴权/参数/配额类）", () => {
    expect(classifyLlmError("error", "401 authentication_error")).toBe("permanent");
    expect(classifyLlmError("error", "403: permission denied")).toBe("permanent");
    expect(classifyLlmError("error", "400: max_tokens must be > 0")).toBe("permanent");
    expect(classifyLlmError("error", "404 model not found")).toBe("permanent");
    expect(classifyLlmError("error", "422 Unprocessable Entity")).toBe("permanent");
  });

  test("abort/正常停止/未知错误/空消息 → 永久（安全缺省）", () => {
    expect(classifyLlmError("aborted", "Request was aborted")).toBe("permanent");
    expect(classifyLlmError("stop", undefined)).toBe("permanent");
    expect(classifyLlmError("error", "boom 未知形态")).toBe("permanent");
    expect(classifyLlmError("error", undefined)).toBe("permanent");
    expect(classifyLlmError("error", "  ")).toBe("permanent");
  });
});

// ── withNetworkRetry（包装行为） ────────────────────────────

describe("withNetworkRetry", () => {
  test("失败 2 次后成功：恰消费退避 10s/30s，输出零错误帧（消费者只见成功流）", async () => {
    const clock = fakeClock();
    const retries: LlmRetryInfo[] = [];
    const { fn, callCount } = scriptedStreamFn([
      { kind: "error", message: "fetch failed" },
      { kind: "error", message: "ECONNRESET" },
      { kind: "ok", text: "recovered" },
    ]);
    const wrapped = withNetworkRetry(fn, { sleep: clock.sleep, onRetry: (i) => retries.push(i) });

    const events = await collect(wrapped(fakeModel, { messages: [] as never }, {}));

    expect(callCount()).toBe(3); // 1 + 2 重试
    expect(clock.slept).toEqual([LLM_RETRY_BACKOFF_MS[0]!, LLM_RETRY_BACKOFF_MS[1]!]); // 假时钟断言退避序列消费
    expect(retries).toEqual([
      { attempt: 1, totalAttempts: 3, waitMs: 10_000, message: "fetch failed" },
      { attempt: 2, totalAttempts: 3, waitMs: 30_000, message: "ECONNRESET" },
    ]);
    // 输出 = 最终成功尝试的单一流（无 error 帧、无重复 start）
    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "done"]);
    expect(events[2]!.type === "done" && (events[2] as { message: AssistantMessage }).message.content).toEqual([
      { type: "text", text: "recovered" },
    ]);
  });

  test("持续瞬时失败：恰 4 次尝试（1+3）后退避耗尽，原样转发既有失败帧", async () => {
    const clock = fakeClock();
    const retries: LlmRetryInfo[] = [];
    const { fn, callCount } = scriptedStreamFn([{ kind: "error", message: "503 Service Unavailable" }]);
    const wrapped = withNetworkRetry(fn, { sleep: clock.sleep, onRetry: (i) => retries.push(i) });

    const events = await collect(wrapped(fakeModel, { messages: [] as never }, {}));

    expect(callCount()).toBe(4); // 首调 + 3 次退避重试
    expect(clock.slept).toEqual([10_000, 30_000, 60_000]); // 全序列 10s/30s/60s
    expect(retries.map((r) => r.attempt)).toEqual([1, 2, 3]);
    // 既有失败路径零改动：单一 error 终帧，provider 原文保留
    expect(events.map((e) => e.type)).toEqual(["error"]);
    const terminal = events[0] as Extract<AssistantMessageEvent, { type: "error" }>;
    expect(terminal.reason).toBe("error");
    expect(terminal.error.errorMessage).toBe("503 Service Unavailable");
  });

  test("永久类错误（401）：1 次即失败，零退避零 onRetry", async () => {
    const clock = fakeClock();
    const retries: LlmRetryInfo[] = [];
    const { fn, callCount } = scriptedStreamFn([{ kind: "error", message: "401 authentication_error" }]);
    const wrapped = withNetworkRetry(fn, { sleep: clock.sleep, onRetry: (i) => retries.push(i) });

    const events = await collect(wrapped(fakeModel, { messages: [] as never }, {}));

    expect(callCount()).toBe(1);
    expect(clock.slept).toEqual([]);
    expect(retries).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["error"]);
  });

  test("abort 终帧不重试（用户 kill/中断直通）", async () => {
    const clock = fakeClock();
    let calls = 0;
    const abortedFn: StreamFn = () => {
      calls += 1;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "error", reason: "aborted", error: errorMessage("aborted", "aborted") });
      return stream;
    };
    const wrapped = withNetworkRetry(abortedFn, { sleep: clock.sleep });
    const events = await collect(wrapped(fakeModel, { messages: [] as never }, {}));
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect((events[0] as Extract<AssistantMessageEvent, { type: "error" }>).reason).toBe("aborted");
    expect(clock.slept).toEqual([]);
    expect(calls).toBe(1);
  });

  test("等待期 abort：立即中断退避，aborted 收口不再重试（真实 abortableSleep）", async () => {
    const controller = new AbortController();
    const { fn, callCount } = scriptedStreamFn([{ kind: "error", message: "fetch failed" }]);
    const wrapped = withNetworkRetry(fn, { backoffMs: [60_000], sleep: abortableSleep });

    const promise = collect(wrapped(fakeModel, { messages: [] as never }, { signal: controller.signal }));
    await Bun.sleep(5); // 进入退避等待后
    controller.abort();

    const events = await promise;
    expect(callCount()).toBe(1); // 未发生第二次调用
    expect(events.map((e) => e.type)).toEqual(["error"]);
    const terminal = events[0] as Extract<AssistantMessageEvent, { type: "error" }>;
    expect(terminal.reason).toBe("aborted");
    expect(terminal.error.stopReason).toBe("aborted");
  });

  test("中途断流（start/delta 已转发后 error）：不重试，事件原样透传", async () => {
    const clock = fakeClock();
    const { fn, callCount } = scriptedStreamFn([{ kind: "midstream", message: "ECONNRESET mid-stream" }]);
    const wrapped = withNetworkRetry(fn, { sleep: clock.sleep });

    const events = await collect(wrapped(fakeModel, { messages: [] as never }, {}));

    expect(callCount()).toBe(1);
    expect(clock.slept).toEqual([]);
    // start/delta/error 全透传（既有行为零改动）
    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "error"]);
  });

  test("默认退避常量 = 裁决序列 10s/30s/60s", () => {
    expect(LLM_RETRY_BACKOFF_MS).toEqual([10_000, 30_000, 60_000]);
  });
});
