import { describe, expect, test } from "bun:test";
import { toSnapshotDto, historyPage } from "../../src/adapters/driving/ws-server/DtoMapper";
import {
  CHANNEL_TAIL_SIZE,
  SNAPSHOT_BUDGET_BYTES,
  TAIL_WINDOW_SIZE,
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
