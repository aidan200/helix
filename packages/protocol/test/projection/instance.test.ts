import { describe, expect, test } from "bun:test";
import {
  type AnchorScanEntry,
  computeAnchorEntryId,
  entrySortKey,
  isMainInstance,
  lastMainAnchorId,
} from "../../src/index";
import type { EntryDto, ThinkingEntryDto, MessageEntryDto, ToolCallEntryDto } from "../../src/index";

/**
 * TP-3.1a instance 域纯函数单测（M4 投资批，iter-20260821-dg90 T3.1）。
 *
 * 期望值基线：
 * - anchor 两函数 = daemon ws-server/SpawnAnchor.ts 契约 v0.3 §1 三分支
 *   语义（原实现迁移前无独立单测——本文件是首份 unit 锚定，行为逐分支
 *   对照原实现搬移）；
 * - entrySortKey = daemon EntryDtoMapper.entrySortKey ↔ shell snapshot.ts
 *   entryTimelineKey 两份同构实现的共同语义（message/tool = ts；
 *   thinking/compaction = Date.parse(createdAt)）；
 * - isMainInstance = 信封 instanceId 缺省语义（§10.1/§17.11 T10：缺省或
 *   字面 "main" = legacy 主实例读侧推断；现行写侧全实例显式携带
 *   agent-<唯一串>，main 归属判别走 kind）。
 */

const msg = (id: string, ts: number, instanceId?: string): MessageEntryDto => ({
  kind: "message",
  id,
  role: "assistant",
  content: `entry ${id}`,
  ts,
  ...(instanceId !== undefined ? { instanceId } : {}),
});
const tool = (id: string, ts: number, instanceId?: string): ToolCallEntryDto => ({
  kind: "tool-call",
  id,
  name: "read",
  args: "{}",
  state: "done",
  ts,
  ...(instanceId !== undefined ? { instanceId } : {}),
});
const think = (id: string, createdAt: string, instanceId = "main"): ThinkingEntryDto => ({
  kind: "thinking",
  id,
  instanceId,
  text: `thinking ${id}`,
  durationMs: 100,
  reasoningTokens: 10,
  createdAt,
});
const compact = (id: string, createdAt: string): EntryDto => ({
  kind: "compaction",
  id,
  instanceId: "main",
  tokensBefore: 100,
  tokensAfter: 20,
  summary: "摘要",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 },
  createdAt,
});

/** 锚扫描基元（AnchorScanEntry 结构最小型：DTO 与 domain 条目数据共用）。 */
const anchorEntry = (id: string, instanceId?: string, kind?: string): AnchorScanEntry => ({
  id,
  ...(instanceId !== undefined ? { instanceId } : {}),
  ...(kind !== undefined ? { kind } : {}),
});

describe("instance 域：主实例归属判定（契约 §3 缺省语义）", () => {
  test("isMainInstance（legacy 读侧推断）：undefined 缺省 / 字面 \"main\" = true；其余（含 agent-<唯一串>）= false", () => {
    expect(isMainInstance(undefined)).toBe(true);
    expect(isMainInstance("main")).toBe(true);
    expect(isMainInstance("agent-1")).toBe(false);
    expect(isMainInstance("")).toBe(false); // 空串非缺省（显式空 = 非主实例归属）
  });
});

describe("instance 域：条目排序键（daemon entrySortKey ↔ shell entryTimelineKey 同构收敛）", () => {
  test("message/tool 用 ts（epoch ms）；thinking/compaction 用 createdAt（Date.parse）", () => {
    const iso = "2026-08-21T00:00:01.500Z";
    expect(entrySortKey(msg("m1", 1000))).toBe(1000);
    expect(entrySortKey(tool("t1", 2000))).toBe(2000);
    expect(entrySortKey(think("th1", iso))).toBe(Date.parse(iso));
    expect(entrySortKey(compact("cp1", iso))).toBe(Date.parse(iso));
  });

  test("两类字段同一时间轴混排稳定排序（合并语义 = 快照/通道分组共同前提）", () => {
    const base = Date.parse("2026-08-21T00:00:00.000Z");
    const merged: EntryDto[] = [
      think("th-early", "2026-08-21T00:00:00.000Z"), // = base
      msg("m-mid", base + 500, "agent-1"),
      compact("cp-late", "2026-08-21T00:00:02.000Z"), // = base + 2000
      msg("m-first", base - 1000),
      tool("t-tool", base + 1000, "agent-1"),
    ];
    const sorted = [...merged].sort((a, b) => entrySortKey(a) - entrySortKey(b));
    expect(sorted.map((e) => e.id)).toEqual(["m-first", "th-early", "m-mid", "t-tool", "cp-late"]);
  });
});

describe("instance 域：spawn 锚权威计算（契约 v0.3 §1 三分支；迁自 daemon SpawnAnchor.ts）", () => {
  // 剧本：main 流 4 条 + agent-1 的首条归属 Entry 在 index 3
  const entries: AnchorScanEntry[] = [
    anchorEntry("e1"),                       // main（缺省归属）
    anchorEntry("c1", undefined, "compaction"), // compaction 里程碑
    anchorEntry("e2"),                       // main
    anchorEntry("e3", "agent-1"),            // agent-1 首条归属 Entry（firstIdx=3）
    anchorEntry("e4"),                       // main（首 Entry 后 append——不影响锚）
  ];

  test("lastMainAnchorId：entries[0,end) 内按数组序最后一条 main 归属或 compaction id；无 → null", () => {
    expect(lastMainAnchorId(entries)).toBe("e4");
    expect(lastMainAnchorId(entries, 3)).toBe("e2"); // [e1,c1,e2] 数组序最后一条 main/compaction
    expect(lastMainAnchorId(entries, 2)).toBe("c1"); // compaction 计入锚源
    expect(lastMainAnchorId(entries, 1)).toBe("e1");
    expect(lastMainAnchorId([])).toBeNull();
    // 只用数组序，不掺 ts 排序（explorer 排序陷阱规避——行为语义锚定）
    const mixed: AnchorScanEntry[] = [anchorEntry("sub-1", "agent-2"), anchorEntry("main-1")];
    expect(lastMainAnchorId(mixed)).toBe("main-1");
  });

  test("规则①：实例已有 Entry → 首条非 compaction 归属 Entry 前的最后 main/compaction id", () => {
    expect(computeAnchorEntryId(entries, { kind: "subagent", instanceId: "agent-1" })).toBe("e2"); // [e1,c1,e2|e3)
    // 首 Entry 前无 main/compaction → null（流首）
    const firstAtHead: AnchorScanEntry[] = [anchorEntry("s1", "agent-9"), anchorEntry("m1")];
    expect(computeAnchorEntryId(firstAtHead, { kind: "subagent", instanceId: "agent-9" })).toBeNull();
    // 首 Entry 是 compaction → 不算归属 Entry（无 Entry → 恢复边界尾部推导）
    const compactionFirst: AnchorScanEntry[] = [anchorEntry("c0", "agent-9", "compaction"), anchorEntry("m1")];
    expect(computeAnchorEntryId(compactionFirst, { kind: "subagent", instanceId: "agent-9" })).toBe("m1");
  });

  test("规则②：实例尚无 Entry → spawn 时值（不按当前尾部重算）", () => {
    const instance = { kind: "subagent" as const, instanceId: "agent-2", spawnAnchorEntryId: "e2" };
    expect(computeAnchorEntryId(entries, instance)).toBe("e2");
  });

  test("规则③：主实例 → undefined（不携带）", () => {
    expect(computeAnchorEntryId(entries, { kind: "main", instanceId: "main" })).toBeUndefined();
  });

  test("恢复边界：无 Entry 且 spawn 时值缺位 → 尾部推导 best-effort；null = 流首有效锚不回落", () => {
    // spawnAnchorEntryId: null 是有效值（流首锚，显式保留不回落）——仅 undefined（缺位）才退化尾部推导
    const streamStart = { kind: "subagent" as const, instanceId: "agent-x", spawnAnchorEntryId: null };
    expect(computeAnchorEntryId(entries, streamStart)).toBeNull();
    const noSpawnValue = { kind: "subagent" as const, instanceId: "agent-y" };
    expect(computeAnchorEntryId(entries, noSpawnValue)).toBe("e4"); // = lastMainAnchorId(entries)
  });
});
