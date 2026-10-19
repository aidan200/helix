import { describe, expect, test } from "bun:test";
import { toSnapshotDto, historyPage } from "../../src/adapters/driving/ws-server/DtoMapper";
import {
  CHANNEL_TAIL_SIZE,
  SNAPSHOT_BUDGET_BYTES,
  SNAPSHOT_CHANNEL_PREVIEW,
  TAIL_WINDOW_SIZE,
  instanceChannelsPage,
} from "../../src/adapters/driving/ws-server/DtoMapper";
import type { SessionStateView } from "../../src/application/ports/inbound/SessionPort";
import type { EntryData } from "../../src/domain/session/Entry";
import type { ThinkingEntryData } from "../../src/domain/session/ThinkingEntry";
import type { ToolCallRecordData } from "../../src/domain/tools/ToolCallRecord";

/**
 * 快照体量批（重连循环 bug 第二轮）：快照 DTO 字节预算回归。
 *
 * 事故现场（2026-09-20 实测，用户会话 17be1a88：3754 entries + 40 实例 +
 * 4972 tool_calls 结果共 8.5MB）：toSnapshotDto 对 instances[].channels
 * 完整不截断 → 单帧 15.51MB；welcome attach 快照 + replay subscribe ack
 * 快照 = 每连接 31MB → 慢客户端（webview 解析 15.5MB JSON 阻塞主线程）
 * 排水不及 → daemon 发送缓冲 > 8MB → close(4000) → 800ms 退避 + ~1.2s
 * 主线程阻塞 ≈ 2.0s 恒定周期自持循环（探针复现：+77ms 收 15.51MB、
 * +115ms close(4000)）。
 *
 * 修复口径：主轴尾窗 + 全部实例通道合计受 SNAPSHOT_BUDGET_BYTES（2MB）
 * 序列化字节预算约束（保最新；单条超预算保底 1 条）；被截通道携带
 * truncated: true（additive）；loadHistory 分页同预算。
 */

const KB = 1024;

function bigText(kb: number, seed: string): string {
  const unit = `${seed}-`;
  return unit.repeat(Math.ceil((kb * KB) / unit.length));
}

/** 主实例大消息条目（主轴字节窗路径）。 */
function mainMessage(id: string, atMs: number, kb: number): EntryData {
  return {
    id,
    role: "assistant",
    text: bigText(kb, id),
    turnId: null,
    isSteer: false,
    instanceId: "main",
    createdAt: new Date(atMs).toISOString(),
  };
}

/** SubAgent thinking 条目（通道字节窗路径）。 */
function agentThinking(id: string, atMs: number, kb: number, instanceId: string): ThinkingEntryData {
  return {
    kind: "thinking",
    id,
    instanceId,
    text: bigText(kb, id),
    durationMs: 10,
    createdAt: new Date(atMs).toISOString(),
  };
}

function toolCall(id: string, atMs: number, resultKb: number, instanceId?: string): ToolCallRecordData {
  return {
    id,
    toolName: "grep",
    args: { q: id },
    status: "completed",
    result: bigText(resultKb, id),
    ...(instanceId !== undefined ? { instanceId } : {}),
    startedAt: new Date(atMs).toISOString(),
    endedAt: new Date(atMs + 5).toISOString(),
  };
}

/** 大体量视图：主轴 60×100KB 消息 + 1 个 SubAgent 300×40KB 工具结果（≈15MB 级）。 */
function bigView(): SessionStateView {
  const mainEntries = Array.from({ length: 60 }, (_, i) => mainMessage(`m-${i}`, 1000 + i * 10, 100));
  const agentEntries = Array.from({ length: 50 }, (_, i) => agentThinking(`a-${i}`, 1000 + i * 10, 8, "agent-1"));
  const agentTools = Array.from({ length: 300 }, (_, i) => toolCall(`tc-${i}`, 2000 + i, 40, "agent-1"));
  return {
    session: {
      sessionId: "s-big",
      createdAt: new Date(0).toISOString(),
      entries: [...mainEntries, ...agentEntries],
      turns: [],
      pendingSteer: [],
      mainInstanceId: "main",
    },
    toolCalls: agentTools,
    instances: [
      {
        instanceId: "main",
        kind: "main",
        profileKind: "main-session",
        sessionId: "s-big",
        state: "running",
        createdAt: new Date(0).toISOString(),
      },
      {
        instanceId: "agent-1",
        kind: "subagent",
        profileKind: "subagent-worker",
        sessionId: "s-big",
        state: "done",
        createdAt: new Date(0).toISOString(),
      },
    ],
  } as unknown as SessionStateView;
}

describe("快照字节预算（重连循环第二轮修复）", () => {
  test("大体量视图：快照序列化 ≤ 预算（主轴 + 通道合计有界）——事故形态回归", () => {
    const dto = toSnapshotDto(bigView(), "anthropic/fake", "idle");
    const size = JSON.stringify(dto).length;
    // 预算约束条目集（entries/tail/channels）；DTO 元数据（usage/plan 等）留 64KB 余量
    expect(size).toBeLessThanOrEqual(SNAPSHOT_BUDGET_BYTES + 64 * KB);
  });

  test("SubAgent 通道截断：tools 通道 ≤ CHANNEL_TAIL_SIZE 且 truncated=true（300 条 40KB 工具结果不整帧下发）", () => {
    const dto = toSnapshotDto(bigView(), "anthropic/fake", "idle");
    const agent = dto.instances?.find((i) => i.instanceId === "agent-1");
    expect(agent?.channels?.tools).toBeDefined();
    expect(agent!.channels!.tools!.length).toBeLessThanOrEqual(CHANNEL_TAIL_SIZE);
    expect(agent!.channels!.tools!.length).toBeLessThan(300);
    expect(agent!.channels!.truncated).toBe(true);
    // 保最新：截断后保留的是尾部（最新）工具条目
    const ids = agent!.channels!.tools!.map((e) => e.id);
    expect(ids[ids.length - 1]).toBe("tc-299");
  });

  test("主轴字节窗：60×100KB 主消息超出预算 → tail 保最新且 tailStartCursor 指向实际首条", () => {
    const dto = toSnapshotDto(bigView(), "anthropic/fake", "idle");
    expect(dto.entries.length).toBeLessThanOrEqual(TAIL_WINDOW_SIZE);
    expect(dto.entries.length).toBeGreaterThan(0);
    // 保最新：末条必在（主轴最新条目不被预算裁掉；a-* 为 SubAgent 条目不在主轴）
    expect(dto.entries[dto.entries.length - 1]!.id).toBe("m-59");
    expect(dto.totalEntries).toBe(60); // 全量计数不因截断缩水（主轴 = 主实例 60 条）
    if (dto.entries.length < dto.totalEntries!) {
      expect(dto.tailStartCursor).toBe(dto.entries[0]!.id);
    }
  });

  // 评审 F2 #20：2MB 预算是软顶——「单条超预算保底 1 条」让单个巨型工具结果整条进帧，
  // 可重现 >8MB 背压 close(4000) 重连循环。单条必须硬顶压缩。
  test("巨型单条工具结果（6MB）→ 压进单条硬顶，整帧仍在预算内（不再击穿软顶）", () => {
    const view = {
      session: {
        sessionId: "s-giant",
        createdAt: new Date(0).toISOString(),
        entries: [],
        turns: [],
        pendingSteer: [],
        mainInstanceId: "main",
      },
      toolCalls: [toolCall("tc-giant", 1_000, 6 * 1024)],
      instances: [
        {
          instanceId: "main",
          kind: "main",
          profileKind: "main-session",
          sessionId: "s-giant",
          state: "running",
          createdAt: new Date(0).toISOString(),
        },
      ],
    } as unknown as SessionStateView;
    const dto = toSnapshotDto(view, "anthropic/fake", "idle");
    const size = JSON.stringify(dto).length;
    expect(size).toBeLessThanOrEqual(SNAPSHOT_BUDGET_BYTES + 64 * KB);
    const giant = dto.entries.find((e) => e.id === "tc-giant");
    expect(giant).toBeDefined(); // 条目仍在（保最新 + 结构保留）
    expect(String((giant as { result?: string }).result)).toContain("已截断");
  });

  test("小会话零截断：预算内通道不带 truncated 键（additive 缺省兼容）", () => {
    const view = {
      session: {
        sessionId: "s-small",
        createdAt: new Date(0).toISOString(),
        entries: [
          {
            id: "e1",
            role: "user" as const,
            text: "问题",
            turnId: "t1",
            isSteer: false,
            instanceId: "main",
            createdAt: new Date(1000).toISOString(),
          },
        ],
        turns: [],
        pendingSteer: [],
        mainInstanceId: "main",
      },
      toolCalls: [toolCall("tc-1", 2000, 1, "agent-1")],
      instances: [
        {
          instanceId: "agent-1",
          kind: "subagent" as const,
          profileKind: "subagent-worker",
          sessionId: "s-small",
          state: "done" as const,
          createdAt: new Date(0).toISOString(),
        },
      ],
    } as unknown as SessionStateView;
    const dto = toSnapshotDto(view, "anthropic/fake", "idle");
    const agent = dto.instances?.find((i) => i.instanceId === "agent-1");
    expect(agent?.channels?.tools).toHaveLength(1);
    expect(agent?.channels?.truncated).toBeUndefined();
  });

  test("单条超预算条目保底 1 条（快照非空进度保证）", () => {
    const view = {
      session: {
        sessionId: "s-one",
        createdAt: new Date(0).toISOString(),
        entries: [mainMessage("m-0", 1000, SNAPSHOT_BUDGET_BYTES / KB + 512)],
        turns: [],
        pendingSteer: [],
        mainInstanceId: "main",
      },
      toolCalls: [],
    } as unknown as SessionStateView;
    const dto = toSnapshotDto(view, "anthropic/fake", "idle");
    expect(dto.entries.length).toBe(1);
  });

  test("多实例公平分摊：40 个实例共享通道预算，无单实例独占（后位实例通道非空）", () => {
    const entries: unknown[] = [];
    const tools: ToolCallRecordData[] = [];
    const instances: unknown[] = [];
    for (let i = 0; i < 40; i++) {
      const iid = `agent-${i}`;
      instances.push({
        instanceId: iid,
        kind: "subagent",
        profileKind: "subagent-worker",
        sessionId: "s-fair",
        state: "done",
        createdAt: new Date(0).toISOString(),
      });
      for (let j = 0; j < 40; j++) {
        tools.push(toolCall(`tc-${i}-${j}`, 2000 + j, 12, iid));
      }
    }
    const view = {
      session: {
        sessionId: "s-fair",
        createdAt: new Date(0).toISOString(),
        entries,
        turns: [],
        pendingSteer: [],
        mainInstanceId: "main",
      },
      toolCalls: tools,
      instances,
    } as unknown as SessionStateView;
    const dto = toSnapshotDto(view, "anthropic/fake", "idle");
    // 首位实例吃满后，末位实例通道仍非空（公平分摊而非顺序倾占）
    const last = dto.instances?.find((i) => i.instanceId === "agent-39");
    expect((last?.channels?.tools?.length ?? 0)).toBeGreaterThan(0);
    // 总量仍受预算约束
    expect(JSON.stringify(dto).length).toBeLessThanOrEqual(SNAPSHOT_BUDGET_BYTES + 64 * KB);
  });

  test("loadHistory 分页同预算：大结果页有界（hasMore/nextCursor 语义随字节窗收敛）", () => {
    const view = bigView();
    const cursor = "m-59"; // 主轴在 m-59 之前还有 59 条大消息
    const page = historyPage(view, cursor, 200);
    expect(JSON.stringify(page.entries).length).toBeLessThanOrEqual(SNAPSHOT_BUDGET_BYTES);
    expect(page.entries.length).toBeLessThan(59);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(page.entries[0]!.id);
    // 保最新：紧邻游标的条目必在
    expect(page.entries[page.entries.length - 1]!.id).toBe("m-58");
  });
});

describe("channels 惰性化批（快照预览 + 按需分页）", () => {
  test("快照通道预览化：每槽 ≤ SNAPSHOT_CHANNEL_PREVIEW(2) 且 truncated=true（完整历史走按需拉取）", () => {
    const dto = toSnapshotDto(bigView(), "anthropic/fake", "idle");
    const agent = dto.instances?.find((i) => i.instanceId === "agent-1");
    // fixture 主轴 30 条×100KB 吃满主轴预算 → 通道份额兑底 4KB——预览槽可能
    // 被字节预算进一步压到 1 条；预览语义 = ≤2 条 + 保最新 + truncated 标记
    expect(agent!.channels!.tools!.length).toBeLessThanOrEqual(SNAPSHOT_CHANNEL_PREVIEW);
    expect(agent!.channels!.tools!.length).toBeGreaterThanOrEqual(1);
    expect(agent!.channels!.thinking!.length).toBeLessThanOrEqual(SNAPSHOT_CHANNEL_PREVIEW);
    expect(agent!.channels!.thinking!.length).toBeGreaterThanOrEqual(1);
    expect(agent?.channels?.truncated).toBe(true);
    // 保最新：预览末条是最新条目
    const tools = agent!.channels!.tools!;
    expect(tools[tools.length - 1]!.id).toBe("tc-299");
    const thinking = agent!.channels!.thinking!;
    expect(thinking[thinking.length - 1]!.id).toBe("a-49");
  });

  test("instanceChannelsPage 首页：打平时间轴保最新 limit 条 + hasMore/nextCursor 游标", () => {
    const view = bigView();
    const page = instanceChannelsPage(view, "agent-1", undefined, 10);
    // 时间线尾部 = tools（tc-290..299 都晚于全部 thinking）
    expect(page.channels.tools?.length).toBe(10);
    expect(page.channels.tools![0]!.id).toBe("tc-290");
    expect(page.channels.tools![9]!.id).toBe("tc-299");
    expect(page.channels.messages).toBeUndefined(); // 首页未触及 thinking 段
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("tc-290");
  });

  test("instanceChannelsPage 游标回溯：nextCursor 续拉更早页（跨槽归并升序）", () => {
    const view = bigView();
    // 游标 tc-270：更早段 = 270 条 tools + 50 条 thinking（thinking ts 1490 < tc-0 ts 2000）
    const page = instanceChannelsPage(view, "agent-1", "tc-270", 20);
    // 更早段尾部 20 条 = tc-250..269（tools 连续段）
    expect(page.channels.tools?.length).toBe(20);
    expect(page.channels.tools![0]!.id).toBe("tc-250");
    expect(page.channels.tools![19]!.id).toBe("tc-269");
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("tc-250");
    // 回溯到 thinking 段（游标 tc-5 → 更早段含全部 thinking）
    const page2 = instanceChannelsPage(view, "agent-1", "tc-5", 60);
    expect(page2.channels.thinking?.length).toBe(50); // thinking 全量在页内
    expect(page2.channels.tools?.length).toBe(5); // tc-0..4
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  test("instanceChannelsPage 边界：main 实例与未知实例抛错 / 大页受字节窗收敛", () => {
    const view = bigView();
    expect(() => instanceChannelsPage(view, "main", undefined, 10)).toThrow(/主实例/);
    expect(() => instanceChannelsPage(view, "agent-x", undefined, 10)).toThrow(/不在会话实例清单/);
    // limit=1000 但 350 条×40KB ≈ 12MB >> 2MB 字节预算：保最新收敛 + 游标续拉
    const full = instanceChannelsPage(view, "agent-1", undefined, 1000);
    expect(JSON.stringify(full.channels).length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(full.hasMore).toBe(true);
    expect(full.nextCursor).toBe(full.channels.tools![0]!.id);
  });
});
