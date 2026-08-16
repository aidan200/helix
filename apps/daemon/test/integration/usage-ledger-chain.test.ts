import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDaemon } from "../../src/infrastructure/container";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import type {
  InstanceRunner,
  InstanceRunnerCallbacks,
} from "../../src/application/services/InstanceRunner";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import type { UsageRecordedPayload } from "../../src/domain/events/DomainEvent";
import type { SessionStateView } from "../../src/application/ports/inbound/SessionPort";

/**
 * T3.2 RED：usage 账目全链路 integration（container 装配级）——
 * ① 剧本多轮 + SubAgent（剧本 runner 上行）后快照 usage 聚合与
 *    instances[].usage 小计自洽（Σ 小计 = total；compaction ⊆ total）；
 * ② compaction 入账（source=compaction 计入 total 与 compaction 小计，恰一条不重复）；
 * ③ 重启（进程内级）：RestoreService 事件流重放重建账本——合计与
 *    per-instance 明细与重启前完全一致；
 * ④ domain_events 四维可查（session × instance × type × time）。
 */

/** 主线 turn 用量剧本（三 turn + 一次 compaction）。 */
const U1 = { input: 10, output: 20, reasoning: 5, totalTokens: 35, cost: 0.01 };
const U2 = { input: 20, output: 30, totalTokens: 50, cost: 0.02 };
const UC = { input: 40, output: 6, totalTokens: 46, cost: 0.03 };
const U3 = { input: 1, output: 2, totalTokens: 3, cost: 0.001 };
/** SubAgent turn 用量（剧本 runner 上行）。 */
const USUB = { input: 100, output: 200, reasoning: 0, totalTokens: 300, cost: 0.1 };

/** 剧本 runner：launch 即上行一条 message_end(usage) 引擎事件 + done 收口（T2.2 上行同构）。 */
class UsageEmitRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }
  launch(instance: { instanceId: string }): void {
    const event: AgentEngineEvent = {
      type: "message_end",
      role: "assistant",
      text: `<<<CLOSURE {"status":"done","summary":"done"} CLOSURE>>>`,
      stopReason: "stop",
      usage: { cacheRead: 0, cacheWrite: 0, ...USUB },
    };
    this.callbacks?.onInstanceEvent(instance.instanceId, event);
    this.callbacks?.onInstanceClosure(instance.instanceId, {
      result: "done",
      closure: { status: "done", summary: "任务完成", reportPath: null, findings: null, taskId: null },
    });
  }
}

async function createUsageDaemon(home: string, engine: FakeAgentEngine): Promise<ReturnType<typeof createDaemon>> {
  return createDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    subagentRunner: new UsageEmitRunner(),
  });
}

/** 轮询等待主线回 idle（closure 注入触发的内部 turn 收口）。 */
async function awaitIdle(d: { system: { getStatus(): { agentState: string } } }, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (d.system.getStatus().agentState !== "idle") {
    if (Date.now() - t0 > timeoutMs) throw new Error("awaitIdle 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function instanceUsage(view: SessionStateView, instanceId: string) {
  const found = view.instances!.find((i) => i.instanceId === instanceId);
  expect(found).toBeDefined();
  return found!.usage;
}

describe("T3.2 usage 账目全链路（container 级）", () => {
  test("多轮 + SubAgent + compaction：快照聚合自洽、compaction 入账、重启一致、四维可查", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t32-ledger-"));
    try {
      // ── 第一段：跑账（主线三 turn + 一次 compaction + SubAgent 一 turn） ──
      const engine1 = new FakeAgentEngine({
        replies: [
          { text: "答一。", usage: U1 },
          // closure 注入触发的内部 turn（SubAgent 收口消息回主线）
          { text: "答二（closure 注入）。", usage: U2, compaction: { tokensBefore: 900, tokensAfter: 90, summary: "压缩", usage: UC } },
          { text: "答三。", usage: U3 },
        ],
      });
      const d1 = await createUsageDaemon(home, engine1);
      const sessionId = d1.system.getStatus().sessionId;

      // 订阅面（SessionService.notify ← fan-out，与 WS 事件流同源）：
      // 订阅方应收到与入账事件等量的 usage.recorded
      const received: string[] = [];
      d1.session.subscribe((event) => {
        if ("type" in event && event.type === "usage.recorded") {
          received.push((event.payload as UsageRecordedPayload).source);
        }
      });

      await d1.chat.sendMessage("问一");
      const spawnOutcome = d1.orchestration.spawn("统计文件");
      expect(spawnOutcome.status).toBe("run");
      await awaitIdle(d1); // SubAgent usage 上行 + closure 注入 → 内部 turn（答二 + compaction）
      await d1.chat.sendMessage("问三");
      expect(d1.system.getStatus().agentState).toBe("idle");

      const view1 = d1.session.getSnapshot();
      const usage1 = view1.usage!;
      expect(usage1).toBeDefined();

      // ① per-instance 小计：main = U1+U2+UC+U3（compaction 归属 main）、agent-1 = USUB
      expect(instanceUsage(view1, "main")).toEqual({
        input: 10 + 20 + 40 + 1,
        output: 20 + 30 + 6 + 2,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 5,
        totalTokens: 35 + 50 + 46 + 3,
        cost: 0.01 + 0.02 + 0.03 + 0.001,
      });
      expect(instanceUsage(view1, "agent-1")!.totalTokens).toBe(300);

      // 聚合自洽：total = Σ 小计（含 main 与 agent-N）；compaction 小计 ⊆ total
      const instanceSum = view1.instances!.reduce((acc, i) => acc + (i.usage?.totalTokens ?? 0), 0);
      expect(usage1.total.totalTokens).toBe(instanceSum);
      expect(usage1.total.totalTokens).toBe(35 + 50 + 46 + 3 + 300);
      expect(usage1.compaction).toEqual({ input: 40, output: 6, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 46, cost: 0.03 });
      expect(usage1.compaction.totalTokens).toBeLessThanOrEqual(usage1.total.totalTokens);

      await d1.shutdown(); // 优雅退出：drain 写队列（domain_events 落账）

      // ── 第二段：四维查询（session × instance × type × time；agent_kind 附带维） ──
      const readQueue = new WriteQueue(path.join(home, "helix.db"));
      const repo = new SqliteSessionRepository(readQueue);
      const allUsage = repo.queryEvents({ sessionId, type: "usage.recorded" });
      expect(allUsage).toHaveLength(5); // U1 + USUB + U2 + UC + U3
      expect(allUsage.filter((e) => (e.instanceId ?? "main") === "main")).toHaveLength(4);
      expect(allUsage.filter((e) => e.instanceId === "agent-1")).toHaveLength(1);
      const subRow = repo.queryEvents({ sessionId, instanceId: "agent-1", type: "usage.recorded" });
      expect(subRow).toHaveLength(1);
      expect((subRow[0]!.payload as UsageRecordedPayload).usage.input).toBe(100);
      // 时间维：早于一切的 until → 空；覆盖全程的 since → 全量
      expect(repo.queryEvents({ sessionId, type: "usage.recorded", until: "2000-01-01T00:00:00.000Z" })).toHaveLength(0);
      expect(repo.queryEvents({ sessionId, type: "usage.recorded", since: "2000-01-01T00:00:00.000Z" })).toHaveLength(5);
      // source 维度核对（payload）：turn 4 条 + compaction 恰 1 条（不重复发）
      const sources = allUsage.map((e) => (e.payload as UsageRecordedPayload).source).sort();
      expect(sources).toEqual(["compaction", "turn", "turn", "turn", "turn"]);
      // 订阅方收到的账目事件与落盘行等量（turn 4 + compaction 1）
      expect(received.filter((s) => s === "turn")).toHaveLength(4);
      expect(received.filter((s) => s === "compaction")).toHaveLength(1);
      await readQueue.close();

      // ── 第三段：重启（进程内级）→ RestoreService 事件流重放重建账本 ──
      const engine2 = new FakeAgentEngine({ replies: [{ text: "重启后新答。" }] });
      const d2 = await createUsageDaemon(home, engine2);
      const view2 = d2.session.getSnapshot();

      // ③ 重启后快照 usage 聚合与重启前完全一致（合计 + compaction 小计）
      expect(view2.usage).toEqual(usage1);
      // per-instance 明细一致（main + agent-1）
      expect(instanceUsage(view2, "main")).toEqual(instanceUsage(view1, "main"));
      expect(instanceUsage(view2, "agent-1")).toEqual(instanceUsage(view1, "agent-1"));
      expect(view2.usage!.total.totalTokens).toBe(usage1.total.totalTokens);

      // 重启后账目延续：续对话入账在恢复基线上累加（+1 条 turn 账）
      await d2.chat.sendMessage("续问");
      const view3 = d2.session.getSnapshot();
      expect(view3.usage!.total.totalTokens).toBe(usage1.total.totalTokens + 0); // 新剧本无 usage：合计不变
      expect(view3.usage!.total.input).toBe(usage1.total.input);
      await d2.shutdown();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});
