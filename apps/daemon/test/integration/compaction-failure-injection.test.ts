import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { PiAgentEngineAdapter } from "../../src/adapters/driven/pi-engine/PiAgentEngineAdapter";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";
import { SteerHooks } from "../../src/adapters/driven/pi-engine/runtime/hooks/SteerHooks";
import { MinimalHooks } from "../../src/adapters/driven/pi-engine/runtime/hooks/MinimalHooks";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import type { UsageRecordedPayload } from "../../src/domain/events/DomainEvent";
import type { SessionStreamEvent } from "../../src/application/ports/inbound/SessionPort";

/**
 * T5.3 —— CL-4（F4.1③）：compaction 失败注入专项 spec（AD-9 失败路径守护 +
 * AD-4 账目不漏不重）。
 *
 * 构造口径（契约 §8-4）：pi-ai complete = stream().result()，无独立非流式
 * 路径——失败注入一律按「provider 调用出错」构造。两场景对应 T3.1
 * CompactionHook 的两条机械失败路径：
 *
 * - 场景① provider 拒绝（completeSimple **抛错**——传输/鉴权层崩溃）：
 *   pi compact 不捕获 throw → CompactionHook catch →
 *   「compaction 执行异常：…」→ engine_error。
 * - 场景② 摘要过程异常（completeSimple **返回 stopReason:"error" 消息**——
 *   pi-ai 流错误规范化产物）→ retryAssistantCall 原样返回 →
 *   compact → CompactionError("summarization_failed") → Result err →
 *   「compaction 摘要失败：…」→ engine_error。
 *
 * 载体比 T3.1 adapter 级基础剧本升一层：真 adapter + 真 container 装配
 * （createDaemon，engine 注入）——多覆盖 ChatService 订阅面 engine.error
 * 可观测（WS fan-out 同源）、会话 Entry 快照无损、usage 账目 SQL 核对。
 *
 * 账目断言口径（AD-4，写死不模糊）：失败调用零入账——pi compact 的两条
 * 错误路径都不携带 usage（generateSummaryWithUsage 对 stopReason:"error"
 * 直接返回 err，response.usage 被丢弃；throw 路径无返回值）——即使
 * provider 实际已计费，未回传 usage 即不入账。故断言 source=compaction
 * 恰 0 条；恢复后成功 compaction 恰 1 条（不漏不重闭环）。
 */

// ── 离线替身（T3.1 pi-adapter-thinking-compaction.test.ts 同构精简） ──

const fakeModel = {
  id: "fake-model",
  name: "Fake Model",
  api: "anthropic-messages" as Api,
  provider: "anthropic",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 8192,
} as unknown as Model<any>;

function textMessage(text: string, withUsage: boolean): AssistantMessage {
  const usage = withUsage
    ? {
        input: 11,
        output: 7,
        cacheRead: 2,
        cacheWrite: 3,
        reasoning: 5,
        totalTokens: 18,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0.05, total: 0.5 },
      }
    : undefined;
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    ...(usage !== undefined ? { usage } : {}),
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** 摘要成功回复（fake Models.completeSimple 返回；usage 是 compaction 账目源）。 */
function summaryMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    usage: {
      input: 40,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 46,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** 摘要调用失败回复（stopReason:"error"——pi-ai 流错误规范化形态）。 */
function summarizerErrorMessage(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** 剧本化 FakeLLM（逐条消费；无 thinking 块——本 spec 只关心 compaction 边界）。 */
function makeFakeLLM(scripts: { text: string; withUsage?: boolean }[]) {
  const streamFn: StreamFn = (_model, _context) => {
    const script = scripts.shift() ?? { text: "（剧本耗尽）" };
    const final = textMessage(script.text, script.withUsage !== false);
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial: final });
      for (let i = 0; i < script.text.length; i += 8) {
        await new Promise((r) => setTimeout(r, 1));
        stream.push({ type: "text_delta", contentIndex: 0, delta: script.text.slice(i, i + 8), partial: final });
      }
      stream.push({ type: "done", reason: "stop", message: final });
    })();
    return stream;
  };
  return { streamFn };
}

/** 摘要调用行为（可变注入——失败后切回正常验证恢复）。 */
type SummarizerBehavior =
  | { mode: "throw"; error: Error }
  | { mode: "error-message"; message: string }
  | { mode: "ok"; summary: string };

function makeInjectableModels(initial: SummarizerBehavior) {
  let behavior = initial;
  const modes: string[] = []; // 每次调用记录当时行为（调用次数断言源）
  const models = {
    completeSimple: async () => {
      modes.push(behavior.mode);
      if (behavior.mode === "throw") throw behavior.error;
      if (behavior.mode === "error-message") return summarizerErrorMessage(behavior.message);
      return summaryMessage(behavior.summary);
    },
  };
  return {
    models: models as unknown as Models,
    modes,
    set(next: SummarizerBehavior): void {
      behavior = next;
    },
  };
}

/** 小阈值 compaction profile（阈值 = cw 1000 - reserve 800 = 200 tokens）。 */
const injectionProfile: AgentProfile = {
  kind: "test-compaction-injection",
  systemPrompt: "测试系统提示",
  tools: [],
  lifecycle: { mode: "persistent" },
  hooks: [new SteerHooks(), new MinimalHooks()],
  compaction: { enabled: true, reserveTokens: 800, keepRecentTokens: 100 },
};

/** ≈320 tokens（字符启发式口径，同 T3.1）——单轮即超 200 阈值触发 compaction。 */
const LONG_TEXT = "这是一段被刻意拉长的回复正文。".repeat(80);

/** container 快照类型（await createDaemon 的返回）。 */
type DaemonView = Awaited<ReturnType<typeof createTestDaemon>>;
type SnapshotView = ReturnType<DaemonView["session"]["getSnapshot"]>;

interface InjectDaemon {
  readonly home: string;
  readonly engineErrors: string[];
  readonly usageEvents: { source: string; totalTokens: number }[];
  send(text: string): Promise<unknown>;
  snapshot(): SnapshotView;
  agentState(): string;
  shutdown(): Promise<void>;
}

async function createInjectionDaemon(
  home: string,
  scripts: { text: string; withUsage?: boolean }[],
  summarizer: SummarizerBehavior,
): Promise<{ d: InjectDaemon; setSummarizer: (next: SummarizerBehavior) => void; modes: string[] }> {
  const { streamFn } = makeFakeLLM(scripts);
  const injectable = makeInjectableModels(summarizer);
  const engine = new PiAgentEngineAdapter({
    profile: injectionProfile,
    model: fakeModel,
    apiKeys: { anthropic: "explicit-key" },
    models: injectable.models,
    streamFnOverride: streamFn,
  });
  const daemon = await createTestDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
  });

  const engineErrors: string[] = [];
  const usageEvents: { source: string; totalTokens: number }[] = [];
  daemon.session.subscribe((event: SessionStreamEvent) => {
    if (!("type" in event)) return;
    if (event.type === "engine.error") {
      engineErrors.push((event.payload as { message: string }).message);
    } else if (event.type === "usage.recorded") {
      const p = event.payload as UsageRecordedPayload;
      usageEvents.push({ source: p.source, totalTokens: p.usage.totalTokens });
    }
  });

  return {
    d: {
      home,
      engineErrors,
      usageEvents,
      send: (text) => daemon.chat.sendMessage(text),
      snapshot: () => daemon.session.getSnapshot(),
      agentState: () => daemon.system.getStatus().agentState,
      shutdown: () => daemon.shutdown(),
    },
    setSummarizer: injectable.set,
    modes: injectable.modes,
  };
}

/** Entry 快照无损机械判据：message 条目数 = 期望（user+assistant 成对）、
 *  compaction 条目数 = 期望（失败不落树；turn 完整收口 + agentState idle）。
 *  领域条目判别：message 变体无 kind（以 "role" in 判别），compaction 变体
 *  kind="compaction"（SessionEntryData 联合，T3.1）。 */
function expectSessionIntact(
  snapshot: SnapshotView,
  expectMessages: number,
  expectCompactionEntries: number,
): void {
  const messages = snapshot.session.entries.filter((e) => "role" in e);
  expect(messages).toHaveLength(expectMessages);
  const compactions = snapshot.session.entries.filter((e) => "kind" in e && e.kind === "compaction");
  expect(compactions).toHaveLength(expectCompactionEntries);
  // 轮次全部收口（无未闭合 half-state turn）
  for (const t of snapshot.session.turns) {
    expect(t.status).toBe("completed");
  }
}

/** 快照中查找 message 文本（领域条目 text 字段）。 */
function hasMessageText(snapshot: SnapshotView, text: string): boolean {
  return snapshot.session.entries.some((e) => "role" in e && e.text === text);
}

describe("T5.3 CL-4 compaction 失败注入：场景① provider 拒绝（completeSimple 抛错，契约 §8-4）", () => {
  test("engine_error 可观测 + 会话无损可继续 + source=compaction 恰 0 条（零入账）", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t53-inj1-"));
    try {
      const { d } = await createInjectionDaemon(
        home,
        [
          { text: LONG_TEXT, withUsage: false }, // turn1：超阈值 → 边界触发注入失败
          { text: "失败后的继续回复。（完INJ1）" }, // turn2：短回复带 usage
        ],
        { mode: "throw", error: new Error("provider summarization rejected-503") },
      );

      // turn1：完成（失败注入不崩会话）
      await d.send("第一问");
      expect(d.engineErrors.length).toBeGreaterThanOrEqual(1);
      expect(d.engineErrors[0]).toContain("compaction 执行异常");
      expect(d.engineErrors[0]).toContain("provider summarization rejected-503");

      // 会话无损：注入后 sendMessage 新 turn 正常完成（AD-9 机械判据）
      await d.send("第二问");
      expect(hasMessageText(d.snapshot(), "失败后的继续回复。（完INJ1）")).toBe(true);
      expect(d.agentState()).toBe("idle");
      expectSessionIntact(d.snapshot(), 4, 0); // 2 user + 2 assistant；失败 compaction 不落树

      // 账目：失败调用零入账（pi throw 路径不携带 usage）——source=compaction
      // 恰 0 条；turn 账恰 1 条（仅 turn2 携带 usage）
      expect(d.usageEvents.filter((u) => u.source === "compaction")).toHaveLength(0);
      expect(d.usageEvents.filter((u) => u.source === "turn")).toHaveLength(1);
      expect(d.usageEvents).toEqual([{ source: "turn", totalTokens: 18 }]);

      // SQL 核对（write-through 已落盘；重启读库同口径）
      await d.shutdown();
      const q = new WriteQueue(path.join(home, "helix.db"));
      const repo = new SqliteSessionRepository(q);
      const rows = repo.queryEvents({ sessionId: d.snapshot().session.sessionId, type: "usage.recorded" });
      expect(rows).toHaveLength(1);
      expect((rows[0]!.payload as UsageRecordedPayload).source).toBe("turn");
      await q.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe("T5.3 CL-4 compaction 失败注入：场景② 摘要过程异常（stopReason:error 消息）+ 恢复不漏不重", () => {
  test("engine_error（summarization_failed）→ 零入账；恢复后成功 compaction 恰 1 条 + 会话可继续", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t53-inj2-"));
    try {
      const { d, setSummarizer, modes } = await createInjectionDaemon(
        home,
        [
          { text: LONG_TEXT, withUsage: false }, // turn1：触发 → 注入 stopReason:error
          { text: LONG_TEXT, withUsage: false }, // turn2：累计仍超阈值 → 边界再次触发（此时已切回正常 → 成功）
          { text: "压缩后的继续回复。（完INJ2）" }, // turn3：压缩后上下文可继续对话
        ],
        { mode: "error-message", message: "503 Service Unavailable" },
      );

      // turn1：完成 + 失败可观测（CompactionError 结果路径——前缀「compaction 摘要失败」）
      await d.send("第一问");
      expect(d.engineErrors.length).toBeGreaterThanOrEqual(1);
      expect(d.engineErrors[0]).toContain("compaction 摘要失败");
      expect(d.engineErrors[0]).toContain("summarization_failed");
      expect(d.usageEvents.filter((u) => u.source === "compaction")).toHaveLength(0); // 零入账

      // 恢复：摘要调用切回正常 → turn2 边界 compaction 成功。
      // split-turn 语义（pi compact）：一次 compaction 可发起 k 次摘要调用
      //（历史 + turn 前缀分别摘要，combineUsage 合并）——成功调用次数以
      // modes 实测为准，不写死。
      setSummarizer({ mode: "ok", summary: "【摘要】此前对话讨论了注入测试主题。代号 MARLIN-53 已记录。" });
      await d.send("第二问");
      expect(modes[0]).toBe("error-message"); // 首次调用失败（注入期）
      expect(modes.slice(1).every((m) => m === "ok")).toBe(true); // 恢复后全部成功
      const okCalls = modes.filter((m) => m === "ok").length;
      expect(okCalls).toBeGreaterThanOrEqual(1);

      const compactEntries = d.snapshot().session.entries.filter((e) => "kind" in e && e.kind === "compaction") as unknown as { tokensBefore: number; tokensAfter: number; summary: string }[];
      expect(compactEntries).toHaveLength(1);
      expect(compactEntries[0]!.tokensBefore).toBeGreaterThan(compactEntries[0]!.tokensAfter);
      expect(compactEntries[0]!.summary).toContain("MARLIN-53");

      // 不漏不重：每个成功 compaction 恰 1 条入账且与条目一一对应；入账值
      // = k 次成功调用的 combine 合并（每次 46 → 46×k，失败调用零计入）
      const compactionRows = d.usageEvents.filter((u) => u.source === "compaction");
      expect(compactionRows).toHaveLength(1);
      expect(compactionRows[0]!.totalTokens).toBe(46 * okCalls);

      // 会话可继续：压缩后新 turn 正常完成（无新 compaction/无新错误）
      await d.send("第三问");
      expect(hasMessageText(d.snapshot(), "压缩后的继续回复。（完INJ2）")).toBe(true);
      expect(d.agentState()).toBe("idle");
      expectSessionIntact(d.snapshot(), 6, 1); // 3 user + 3 assistant + 恰 1 条 compaction
      expect(d.usageEvents.filter((u) => u.source === "compaction")).toHaveLength(1);
      expect(d.engineErrors).toHaveLength(1); // 全程仅一次失败事件（恢复后无新错误）

      // SQL 核对：失败零入账 + 成功恰 1 条（turn3 usage 18 + compaction 合并
      // 46×k；落盘与订阅面等量同源）
      await d.shutdown();
      const q = new WriteQueue(path.join(home, "helix.db"));
      const repo = new SqliteSessionRepository(q);
      const rows = repo.queryEvents({ sessionId: d.snapshot().session.sessionId, type: "usage.recorded" });
      const sqlSources = rows.map((r) => (r.payload as UsageRecordedPayload).source);
      expect(sqlSources.filter((s) => s === "compaction")).toHaveLength(1);
      expect(sqlSources.filter((s) => s === "turn")).toHaveLength(1);
      expect(sqlSources).toHaveLength(d.usageEvents.length); // 与订阅面等量
      await q.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});
