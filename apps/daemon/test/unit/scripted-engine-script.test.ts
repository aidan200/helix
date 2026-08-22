import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import {
  loadFakeEngineScript,
  makeScriptedStreamFn,
} from "../../src/adapters/driven/subagent/child/scriptedEngine";

/**
 * T1.4 / F1.4：FakeEngineScript error 形态（test-design §五.1 / §CL-1）。
 * 逐字段 mirror 主线 E 层剧本（apps/daemon/test/e2e/launcher.ts errorMessage
 * + kind:"error" 单帧分支）——TR-TEST-3 反例条款：禁止为方便测试少发事件/
 * 改字段名/吞错误。
 *
 * mirror 判据（diff 可查）：
 * - 消息形态：空 content + stopReason="error" + errorMessage=provider 原文
 *   + 全零 usage（input/output/cacheRead/cacheWrite/reasoning/totalTokens，
 *   cost 四维亦全零）；
 * - 帧形态：单帧 { type: "error", reason: "error", error }——无 start/delta
 *   （与真 pi-ai 失败路径同构：agentLoop 收口 stopReason=error → adapter
 *   message_end(text="", stopReason="error") + engine_error 连发）。
 */

/** 离线 fake 模型（同 subagent-child.test.ts 口径，无网络）。 */
const fakeModel = {
  id: "model",
  name: "Fake Model",
  api: "anthropic-messages",
  provider: "fake",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

const ERROR_TEXT = "429: {\"code\":\"1308\",\"message\":\"已达到 5 小时的使用上限。\"}";

function withScriptFile(json: unknown, fn: (path: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-t14-script-"));
  const file = path.join(dir, "script.json");
  writeFileSync(file, JSON.stringify(json), "utf8");
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function collectEvents(script: unknown): Promise<AssistantMessageEvent[]> {
  const streamFn = makeScriptedStreamFn(script as Parameters<typeof makeScriptedStreamFn>[0], fakeModel);
  const stream = await streamFn(fakeModel, { messages: [] } as unknown as Context, undefined);
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

describe("FakeEngineScript error 形态 schema（loadFakeEngineScript）", () => {
  test("接受 error 形态：replies + error.message 原文透传", () => {
    withScriptFile({ replies: [], error: { message: ERROR_TEXT } }, (file) => {
      const script = loadFakeEngineScript(file);
      expect(script.error?.message).toBe(ERROR_TEXT);
      expect(script.replies).toEqual([]);
    });
  });

  test("拒绝非法 error 形态（message 缺失/非字符串）", () => {
    withScriptFile({ replies: [], error: {} }, (file) => {
      expect(() => loadFakeEngineScript(file)).toThrow(/剧本文件格式错误/);
    });
    withScriptFile({ replies: [], error: { message: 42 } }, (file) => {
      expect(() => loadFakeEngineScript(file)).toThrow(/剧本文件格式错误/);
    });
  });

  test("回归锚定：无 error 字段的既有剧本不受影响", () => {
    withScriptFile({ replies: ["hi"], chunkDelayMs: 1, ignoreAbort: true }, (file) => {
      const script = loadFakeEngineScript(file);
      expect(script.error).toBeUndefined();
      expect(script.replies).toEqual(["hi"]);
    });
  });
});

describe("makeScriptedStreamFn error 分发（与 launcher.ts error 分支逐字段 mirror）", () => {
  test("单帧 error 事件：无 start/delta/done 前导帧（帧形态同构）", async () => {
    const events = await collectEvents({ replies: [], error: { message: ERROR_TEXT } });
    expect(events.map((e) => e.type)).toEqual(["error"]);
    const frame = events[0]!;
    expect(frame.type).toBe("error");
    if (frame.type !== "error") throw new Error("unreachable");
    expect(frame.reason).toBe("error");
  });

  test("error 消息逐字段对齐 mirror：空 content + stopReason=error + errorMessage 原文 + 全零 usage", async () => {
    const events = await collectEvents({ replies: [], error: { message: ERROR_TEXT } });
    const msg = events[0]! as Extract<AssistantMessageEvent, { type: "error" }>;
    const m = msg.error as AssistantMessage & { errorMessage?: string };
    expect(m.role).toBe("assistant");
    expect(m.content).toEqual([]); // 空 content（失败轮不产 assistant 气泡）
    expect(m.stopReason).toBe("error");
    expect(m.errorMessage).toBe(ERROR_TEXT); // provider 原文逐字节透传
    // 全零 usage（零成本不是真实计费调用，与主线终验热修同口径）
    expect(m.usage.input).toBe(0);
    expect(m.usage.output).toBe(0);
    expect(m.usage.cacheRead).toBe(0);
    expect(m.usage.cacheWrite).toBe(0);
    expect((m.usage as { reasoning?: number }).reasoning ?? 0).toBe(0);
    expect(m.usage.totalTokens).toBe(0);
    expect(m.usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  });

  test("error 剧本忽略 replies/abort 语义：每 turn 均为同一 error 帧（single-shot 场景首 turn 即收口）", async () => {
    const events = await collectEvents({ replies: ["不应被消费"], error: { message: "boom" } });
    expect(events.map((e) => e.type)).toEqual(["error"]);
  });

  test("回归锚定：无 error 的正常剧本帧序不变（start → delta… → text_end → done）", async () => {
    const events = await collectEvents({ replies: ["你好世界"], chunkDelayMs: 1 });
    expect(events[0]!.type).toBe("start");
    expect(events.at(-1)!.type).toBe("done");
    const done = events.at(-1)! as Extract<AssistantMessageEvent, { type: "done" }>;
    expect(done.reason).toBe("stop");
    expect(done.message.stopReason).toBe("stop");
  });
});

describe("FakeEngineScript toolCall 形态（H-3④：子进程 browser 工具调用剧本）", () => {
  test("schema：接受 toolCall {name,args}；拒绝缺 name/args 形态", () => {
    withScriptFile({ replies: ["ok"], toolCall: { name: "browser", args: { action: "open", url: "https://x" } } }, (file) => {
      const script = loadFakeEngineScript(file);
      expect(script.toolCall).toEqual({ name: "browser", args: { action: "open", url: "https://x" } });
    });
    withScriptFile({ replies: [], toolCall: { args: {} } }, (file) => {
      expect(() => loadFakeEngineScript(file)).toThrow(/剧本文件格式错误/);
    });
    withScriptFile({ replies: [], toolCall: { name: "browser" } }, (file) => {
      expect(() => loadFakeEngineScript(file)).toThrow(/剧本文件格式错误/);
    });
  });

  test("首 turn 发 toolCall 消息（stopReason=toolUse）；次 turn 回退 replies 文本流", async () => {
    const script = {
      replies: ["后续文本"],
      chunkDelayMs: 1,
      toolCall: { name: "browser", args: { action: "open", url: "https://x" } },
    } as const;
    const streamFn = makeScriptedStreamFn(script, fakeModel);
    const first: AssistantMessageEvent[] = [];
    for await (const e of await streamFn(fakeModel, { messages: [] } as unknown as Context, undefined)) first.push(e);
    const done = first.at(-1)! as Extract<AssistantMessageEvent, { type: "done" }>;
    expect(done.message.stopReason).toBe("toolUse");
    expect(done.message.content).toEqual([
      { type: "toolCall", id: "call-1", name: "browser", arguments: { action: "open", url: "https://x" } },
    ]);
    // 次 turn：回退正常 replies 文本流
    const second: AssistantMessageEvent[] = [];
    for await (const e of await streamFn(fakeModel, { messages: [] } as unknown as Context, undefined)) second.push(e);
    const done2 = second.at(-1)! as Extract<AssistantMessageEvent, { type: "done" }>;
    expect(done2.message.stopReason).toBe("stop");
  });
});
