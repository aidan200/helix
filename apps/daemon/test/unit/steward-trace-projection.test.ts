import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LoopEvent } from "../../src/domain/loop";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteTraceQueryAdapter } from "../../src/adapters/driven/sqlite-session/SqliteTraceQueryAdapter";
import { stewardLoopTraceBridge, STEWARD_INSTANCE_ID } from "../../src/infrastructure/assembly/stewardLoopTraceBridge";
import { SYSTEM_SESSION_ID } from "@helix/protocol";

/**
 * helix-loop L0：追踪可见性端到端（真 SQLite tmp 库——E-18 追踪唯一真实源）。
 * 链路：LoopEngine 事件 → stewardLoopTraceBridge（里程碑过滤 + 四维落位）→
 * WriteQueue.appendEvent（domain_events 落库，agent_kind 判别 = 非主实例 →
 * subagent）→ SqliteTraceQueryAdapter.queryTrace（SYSTEM_SESSION_ID）→
 * 追踪页实例面板出现管家行为历史（assembleInstancePanel fold 只读投影）。
 */
function tmpDbPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "helix-loop-trace-")), "helix.db");
}

function fullRunEvents(): LoopEvent[] {
  return [
    { type: "loop.run.started", runId: "r1", promptSummary: "在忙什么" },
    { type: "loop.turn.started", runId: "r1", turn: 1 },
    { type: "loop.message.started", runId: "r1", turn: 1 }, // 流式中间态（桥过滤）
    { type: "loop.message.delta", runId: "r1", turn: 1, delta: "段" }, // 同上
    { type: "loop.tool.started", runId: "r1", toolCallId: "c1", toolName: "list_tasks", argsSummary: "{}" },
    { type: "loop.tool.finished", runId: "r1", toolCallId: "c1", toolName: "list_tasks", isError: false, resultSummary: "2 条" },
    { type: "loop.turn.finished", runId: "r1", turn: 1, stopReason: "toolUse", tools: ["list_tasks"] },
    { type: "loop.run.finished", runId: "r1", resolution: "answer" },
  ];
}

describe("helix-loop L0：管家行为历史落库与面板投影", () => {
  test("LoopEvent → bridge → domain_events 落库 → trace.query(SYSTEM_SESSION_ID) 面板出现 steward 实例", async () => {
    const dbPath = tmpDbPath();
    try {
      const queue = new WriteQueue(dbPath);
      const trace = new SqliteTraceQueryAdapter(queue);
      // 桥 → 落库（组合根接 FanoutPublisher 的 event-row-persistence 目标；此处
      // 单点直连 WriteQueue 等价——本测试聚焦投影链路）
      const publish = (event: DomainEvent): void => {
        void queue.appendEvent(event, "subagent"); // 非主实例 → subagent（fanout 判别等价）
      };
      const bridge = stewardLoopTraceBridge({ publish, nowIso: () => "2026-09-21T10:00:00.000Z" });
      for (const event of fullRunEvents()) bridge(event);
      await queue.flush(); // WriteQueue FIFO 写入收口后查询（appendEvent 异步入队）

      // 事件页：里程碑子集落库（流式中间态被桥过滤）
      const result = trace.queryTrace({ sessionId: SYSTEM_SESSION_ID });
      const types = result.rows.map((r) => r.type);
      expect(types).toEqual([
        "loop.run.finished",
        "loop.turn.finished",
        "loop.tool.finished",
        "loop.tool.started",
        "loop.turn.started",
        "loop.run.started",
      ]); // id DESC 序
      expect(result.total).toBe(6);
      // 四维落位
      for (const row of result.rows) {
        expect(row.sessionId).toBe(SYSTEM_SESSION_ID);
        expect(row.instanceId).toBe(STEWARD_INSTANCE_ID);
        expect(row.agentKind).toBe("subagent");
      }
      // 载荷面：run.started 携 promptSummary（行为历史检索）
      const started = result.rows.find((r) => r.type === "loop.run.started");
      expect((started?.payload as { promptSummary?: string })?.promptSummary).toBe("在忙什么");

      // 实例面板：steward 实例行出现（assembleInstancePanel fold——管家行为
      // 历史追踪可见性验收）
      expect(result.instances.length).toBe(1);
      const panel = result.instances[0]!;
      expect(panel.instanceId).toBe("steward");
      expect(panel.agentKind).toBe("subagent");
      expect(panel.profileKind).toBe("subagent-worker"); // 无 instantiated/spawned → 缺省
      expect(panel.eventCount).toBe(6);
      expect(panel.startedAt).toBe("2026-09-21T10:00:00.000Z");
      expect(panel.snapshotMissing).toBe(true); // 无 profile 快照——降级标注语义

      await queue.flush();
      queue.close();
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  test("暂停链事件落库：run.paused → run.resumed(decision) → run.finished(resolved)——确认闸行为历史", async () => {
    const dbPath = tmpDbPath();
    try {
      const queue = new WriteQueue(dbPath);
      const trace = new SqliteTraceQueryAdapter(queue);
      const bridge = stewardLoopTraceBridge({
        publish: (event) => {
          void queue.appendEvent(event, "subagent");
        },
        nowIso: () => "2026-09-21T11:00:00.000Z",
      });
      for (const event of [
        { type: "loop.run.started", runId: "r2", promptSummary: "递话" },
        { type: "loop.run.paused", runId: "r2", pauseToken: "r2-pause-1", toolCallId: "c1", toolName: "propose_send", argsSummary: "{}" },
        { type: "loop.run.resumed", runId: "r2", pauseToken: "r2-pause-1", decision: "resolve" },
        { type: "loop.run.finished", runId: "r2", resolution: "resolved" },
      ] as LoopEvent[]) {
        bridge(event);
      }
      await queue.flush(); // 同上：写队列收口后查询
      const result = trace.queryTrace({ sessionId: SYSTEM_SESSION_ID });
      const types = result.rows.map((r) => r.type);
      expect(types).toContain("loop.run.paused");
      expect(types).toContain("loop.run.resumed");
      const resumed = result.rows.find((r) => r.type === "loop.run.resumed");
      expect((resumed?.payload as { decision?: string })?.decision).toBe("resolve");
      await queue.flush();
      queue.close();
    } finally {
      rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });
});
