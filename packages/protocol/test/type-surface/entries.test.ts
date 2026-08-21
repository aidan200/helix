/**
 * EntryDto 面：四成员判别窄化、快照 additive（instances/usage/尾窗）、通道族（thinking/compaction/usage）事件承载、负向样例回读。
 */
import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../../src/index";
import type {
  AgentInstanceDto,
  ClosureDto,
  CompactionCompletedEvent,
  CompactionCompletedPayload,
  CompactionEntryDto,
  EntryDto,
  EventEnvelope,
  HelloCommand,
  InstanceChannelHistory,
  InstanceState,
  MessageEntryDto,
  SessionSnapshotDto,
  SessionSubscribeCommand,
  SessionUnsubscribeCommand,
  SessionUsageDto,
  ThinkingEntryDto,
  ToolCallEntryDto,
  UsageDto,
  UsageRecordedPayload,
} from "../../src/index";
import type { Equal, Expect, TypeOfChannel } from "./samples/helpers";
import { describeEntry } from "./samples/helpers";
import { snapshot } from "./samples/v0";
import { sampleUsage, snapshotV01, v01Events } from "./samples/v01";
import { compactionCompletedV02, snapshotV02 } from "./samples/v02";

// ── 类型级断言（编译期；任一不满足 → tsc --noEmit 失败） ──
// v0.4 trace 族帧构造即类型检查（样例帧见上方 v04Commands/v04Events）
// EntryDto 判别式联合四分支
type _EntryMessage = Expect<Equal<Extract<EntryDto, { kind: "message" }>, MessageEntryDto>>;

type _EntryTool = Expect<Equal<Extract<EntryDto, { kind: "tool-call" }>, ToolCallEntryDto>>;

type _EntryThinking = Expect<Equal<Extract<EntryDto, { kind: "thinking" }>, ThinkingEntryDto>>;

type _EntryCompaction = Expect<Equal<Extract<EntryDto, { kind: "compaction" }>, CompactionEntryDto>>;

// InstanceState 五态恰等（cancelled 仅重启时 queued 收口，AD-10）
type _InstanceState = Expect<
  Equal<InstanceState, "queued" | "running" | "done" | "failed" | "cancelled">
>;

// UsageDto 七字段恰等（pi Usage 防腐映射，cost 拍平 number）
type _UsageFields = Expect<
  Equal<
    keyof UsageDto,
    "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning" | "totalTokens" | "cost"
  >
>;

type _UsageCostNumber = Expect<Equal<UsageDto["cost"], number>>;

type _SessionUsageShape = Expect<Equal<keyof SessionUsageDto, "total" | "compaction">>;

// ClosureDto：status 二值；全字段名恰等
type _ClosureStatus = Expect<Equal<ClosureDto["status"], "done" | "failed">>;

type _ClosureFields = Expect<
  Equal<keyof ClosureDto, "status" | "summary" | "reportPath" | "findings" | "taskId">
>;

type _SnapshotInstances = Expect<Equal<SessionSnapshotDto["instances"], AgentInstanceDto[] | undefined>>;

type _SnapshotUsage = Expect<Equal<SessionSnapshotDto["usage"], SessionUsageDto | undefined>>;

type _ThinkingFamily = Expect<
  Equal<TypeOfChannel<"thinking">, "thinking.stream.delta" | "thinking.completed">
>;

type _UsageFamily = Expect<Equal<TypeOfChannel<"usage">, "usage.recorded">>;

type _CompactionFamily = Expect<Equal<TypeOfChannel<"compaction">, "compaction.completed">>;

// 快照尾窗 additive 字段可选（AD-1 尾窗口径）
type _SnapshotTail = Expect<Equal<SessionSnapshotDto["tail"], EntryDto[] | undefined>>;

type _SnapshotTotalEntries = Expect<Equal<SessionSnapshotDto["totalEntries"], number | undefined>>;

type _SnapshotTailStartCursor = Expect<Equal<SessionSnapshotDto["tailStartCursor"], string | null | undefined>>;

// per-instance channel 历史分组（F-14⑤：不随尾窗截断）
type _InstanceChannels = Expect<Equal<AgentInstanceDto["channels"], InstanceChannelHistory | undefined>>;

// compaction 扩字段（命名定稿：tailKept / filesCompacted）
type _CompactionTailKept = Expect<Equal<CompactionCompletedPayload["tailKept"], number | undefined>>;

type _CompactionFilesCompacted = Expect<Equal<CompactionCompletedPayload["filesCompacted"], number | undefined>>;

// ── 负向断言（编译期守护指令；运行时字面量回读见对应 test） ──
// 负向断言：tool-call 变体不携带 steerState（仅 chat.steer 用户消息变体）
// @ts-expect-error steerState 不存在于 ToolCallEntryDto
const badToolEntry: ToolCallEntryDto = { kind: "tool-call", id: "x", name: "n", args: "{}", state: "done", ts: 1, steerState: "queued" };

// 负向断言：v 位不接受目录外版本（0/"0.9" 之外）
// @ts-expect-error v 位必须是 FrameVersion（0 | "0.9"）
const badVersion: HelloCommand = { v: 1, type: "hello", payload: { token: "t", protocolVersion: "0.9" } };

// 负向断言（v0.2 起保持）：hello 协商位不接受 v0 数值（严格 "0.9" 单值）
// @ts-expect-error protocolVersion 必须是 "0.9"
const badHelloLegacy: HelloCommand = { v: "0.9", type: "hello", payload: { token: "t", protocolVersion: 0 } };

// 负向断言（v0.3）：tier 只接受 full | monitor 两档
// @ts-expect-error tier 目录外字面量
const badTier: SessionSubscribeCommand = { v: PROTOCOL_VERSION, sessionId: "s", type: "session.subscribe", payload: { tier: "lite" } };

// 负向断言（v0.3）：unsubscribe 不接受 tier（保持 EmptyPayload 不动）
// @ts-expect-error unsubscribe payload 仍为 EmptyPayload
const badUnsubscribeTier: SessionUnsubscribeCommand = { v: PROTOCOL_VERSION, sessionId: "s", type: "session.unsubscribe", payload: { tier: "monitor" } };

// 负向断言（v0.3）：anchorEntryId 必须是 string | null
// @ts-expect-error anchorEntryId 不接受数值
const badAnchor: AgentInstanceDto = { instanceId: "agent-1", kind: "subagent", profileKind: "subagent-worker", state: "running", createdAt: "t", anchorEntryId: 12 };

// 负向断言（v0.3）：steer instanceId 必须是 string
// @ts-expect-error instanceId 不接受数值
const badSteerTarget: ChatSteerCommand = { v: PROTOCOL_VERSION, sessionId: "s", type: "chat.steer", payload: { text: "t", instanceId: 3 } };

// 负向断言（v0.2）：thinking 变体不携带 steerState
// @ts-expect-error steerState 不存在于 ThinkingEntryDto
const badThinkingEntry: ThinkingEntryDto = { kind: "thinking", id: "x", instanceId: "main", text: "t", durationMs: 1, reasoningTokens: 1, createdAt: "t", steerState: "queued" };

// 负向断言（v0.1）：usage.source 只接受 turn|compaction
// @ts-expect-error source 不接受其他字面量
const badSource: UsageRecordedPayload = { instanceId: "main", usage: sampleUsage, source: "stream" };

describe("entries：EntryDto 判别式联合与快照 additive + 通道族承载与负向回读（源 TP-CL2-④ / TP-v0.1-①② / TP-v0.2-①③ / TP-v0.3-①）", () => {
  test("switch(entry.kind) 四分支窄化：steerState 仅 message 变体", () => {
    expect(snapshot.entries.map(describeEntry)).toEqual([
      "msg:user:跑一下单测",
      "msg:user:先别动，改用方案 B:queued",
      "tool:run_tests:done:1200ms",
    ]);
    // 负向样例由上方 @ts-expect-error 在编译期守护
    expect(badToolEntry.state).toBe("done");
    expect(badVersion.payload.protocolVersion).toBe("0.9");
    expect(badHelloLegacy.type).toBe("hello");
  });

  test("通道族 4 事件 payload 字段结构正确", () => {
    const byType = new Map(v01Events.map((e) => [e.type, e] as const));

    const thinkDelta = byType.get("thinking.stream.delta");
    expect(
      thinkDelta?.type === "thinking.stream.delta" && thinkDelta.payload.instanceId,
    ).toBe("agent-1");

    const compaction = byType.get("compaction.completed");
    expect(
      compaction?.type === "compaction.completed" &&
        compaction.payload.entry.kind === "compaction" &&
        [compaction.payload.entry.tokensBefore, compaction.payload.entry.tokensAfter],
    ).toEqual([340_000, 20_000]);

    const usage = byType.get("usage.recorded");
    expect(
      usage?.type === "usage.recorded" && usage.payload.source,
    ).toBe("turn");
  });

  test("switch(entry.kind) 四分支窄化：thinking/compaction 变体可描述", () => {
    expect(snapshotV01.entries.map(describeEntry)).toEqual([
      "msg:assistant:委托完成",
      "thinking:main:900",
      "compaction:main:340000:20000:0.0213",
    ]);
    expect(badThinkingEntry.kind).toBe("thinking");
    expect(badSource.usage.cost).toBe(0.0213);
  });

  test("快照 instances/usage 结构正确（重启恢复骨架）", () => {
    const instances = snapshotV01.instances;
    expect(instances?.length).toBe(3);
    const [main, doneSub, queuedSub] = instances ?? [];
    expect(main?.instanceId).toBe("main");
    expect(main?.queuedPosition).toBeUndefined();
    expect(queuedSub?.state).toBe("queued");
    expect(queuedSub?.queuedPosition).toBe(2);
    expect(snapshotV01.usage?.total.totalTokens).toBe(11_640);
    expect(snapshotV01.tail).toBeUndefined(); // v0.1 快照不带尾窗字段仍合法
  });

  test("compaction 扩字段（tailKept / filesCompacted，命名定稿）", () => {
    expect(compactionCompletedV02.payload.tailKept).toBe(30);
    expect(compactionCompletedV02.payload.filesCompacted).toBe(12);
    const legacy = v01Events.find((e) => e.type === "compaction.completed") as CompactionCompletedEvent;
    expect(legacy.payload.tailKept).toBeUndefined(); // v0.1 帧不带仍合法（additive）
  });

  test("tail / totalEntries / tailStartCursor / instances[].channels 可携带可缺省", () => {
    expect(snapshotV02.tail?.length).toBe(2);
    expect(snapshotV02.totalEntries).toBe(128);
    expect(snapshotV02.tailStartCursor).toBe("m1");
    const agent0 = snapshotV02.instances?.find((i) => i.instanceId === "agent-0");
    expect(agent0?.channels?.thinking?.length).toBe(1); // F-14⑤：不随尾窗截断
    expect(agent0?.channels?.messages?.length).toBe(1);
    expect(snapshot.instances).toBeUndefined(); // v0 快照不带仍合法
  });

  test("负向样例仅以 @ts-expect-error 守护（运行时字面量回读，读取侧宽化转型）", () => {
    expect((badTier.payload as Record<string, unknown>).tier).toBe("lite");
    expect((badUnsubscribeTier.payload as Record<string, unknown>).tier).toBe("monitor");
    expect(badAnchor.anchorEntryId as unknown).toBe(12);
    expect((badSteerTarget.payload as unknown as Record<string, unknown>).instanceId).toBe(3);
  });

});
