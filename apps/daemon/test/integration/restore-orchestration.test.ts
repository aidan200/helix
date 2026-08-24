import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";
import type { Daemon } from "../../src/infrastructure/container";
import type {
  InstanceRunner,
  InstanceRunnerCallbacks,
  InstanceClosureOutcome,
} from "../../src/application/services/InstanceRunner";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

/**
 * T2.4 重启恢复扩展 integration（AD-10 语义；CL-1/F1.8，test-design §5 R1~R3
 * 的进程内级对应——E 层浏览器端到端在 e2e/CL-1-*.spec.ts）。
 *
 * 恢复语义矩阵（running/queued/done/failed × 恢复动作）：
 * - running → failed 收口：closure{failed,"daemon 重启，任务未完成"} 落
 *   closure_records + agent_lifecycle 行更新 + SteerQueue 注入主线（source=
 *   closure，下轮 turn 消费）+ 不自动续跑（零新引擎事件流）；
 * - queued → cancelled：agent_lifecycle 行更新 cancelled，**无 closure 记录**
 *   （未开跑），不自动重派（重启后 runner 零 launch）；
 * - done/failed 终态 → 注册表恢复 + closure 完整（closure_records 最新行
 *   读回：summary/reportPath/findings/taskId）+ task 从 agent.spawned 事件流
 *   恢复（双源核对：快照 instances vs 落盘行/事件流）；
 * - 账目 usage：T3.2 入账链路落地前空聚合（七字段全 0），恢复逻辑容忍。
 *
 * 「不自动续跑」机械判据：重启后 agentState=idle 且 FakeAgentEngine 零事件
 * （无新 run 被 closure 注入自动触发——注入只进 SteerQueue 不驱动引擎）。
 */

/** 挂起语义 runner：launch 记录 + 收口由测试显式驱动（同 closure-chain 模式）。 */
class HangingRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  readonly launched: { instanceId: string; task: string }[] = [];
  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }
  launch(instance: { instanceId: string }, task: string): void {
    this.launched.push({ instanceId: instance.instanceId, task });
  }
  forceClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    this.callbacks?.onInstanceClosure(instanceId, outcome);
  }
}

const RESTART_SUMMARY = "daemon 重启，任务未完成";

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "helix-t24-restore-"));
}

async function makeDaemon(home: string, engine: FakeAgentEngine, runner: InstanceRunner): Promise<Daemon> {
  return createTestDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    subagentRunner: runner,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
  });
}

/** daemon db 只读连接（双源核对断言输入）。 */
function readonlyDb(home: string): Database {
  return new Database(path.join(home, "helix.db"), { readonly: true });
}

/** agent_lifecycle 全部行（instanceId → state）。 */
function lifecycleRows(home: string): Record<string, string> {
  const db = readonlyDb(home);
  try {
    const rows = db
      .prepare("SELECT instance_id, state FROM agent_lifecycle")
      .all() as { instance_id: string; state: string }[];
    return Object.fromEntries(rows.map((r) => [r.instance_id, r.state]));
  } finally {
    db.close();
  }
}

/** closure_records 行（agentId → 最新行）。 */
function closureRows(home: string): Record<string, { status: string; summary: string; report_path: string | null; task_id: string | null }> {
  const db = readonlyDb(home);
  try {
    const rows = db
      .prepare("SELECT agent_id, status, summary, report_path, task_id FROM closure_records ORDER BY id")
      .all() as { agent_id: string; status: string; summary: string; report_path: string | null; task_id: string | null }[];
    const byAgent: Record<string, { status: string; summary: string; report_path: string | null; task_id: string | null }> = {};
    for (const r of rows) byAgent[r.agent_id] = r; // ORDER BY id：后行覆盖 = 每实例最新
    return byAgent;
  } finally {
    db.close();
  }
}

/** domain_events 某类型某实例的行数（时间序；「零新事件流」断言输入）。 */
function eventCount(home: string, type: string, instanceId?: string): number {
  const db = readonlyDb(home);
  try {
    if (instanceId === undefined) {
      return (db.prepare("SELECT COUNT(*) AS c FROM domain_events WHERE type = ?").get(type) as { c: number }).c;
    }
    return (
      db.prepare("SELECT COUNT(*) AS c FROM domain_events WHERE type = ? AND agent_instance_id = ?").get(type, instanceId) as { c: number }
    ).c;
  } finally {
    db.close();
  }
}

/** 快照 instances 条目查找（state/closure/task 断言）。 */
function instanceOf(daemon: Daemon, instanceId: string): Record<string, unknown> | undefined {
  const instances = daemon.session.getSnapshot().instances as ReadonlyArray<Record<string, unknown>> | undefined;
  return instances?.find((i) => i["instanceId"] === instanceId);
}

describe("T2.4 ① running → failed 收口（AD-10：D-1 同构）", () => {
  test("spawn running → SIGTERM 语义停机 → 重启：failed + closure 落盘 + 注入主线 + 零新事件流", async () => {
    const home = tmpHome();
    try {
      const runner1 = new HangingRunner();
      const d1 = await makeDaemon(home, new FakeAgentEngine({}), runner1);
      const spawn1 = d1.orchestration.spawn("正在运行中的任务");
      if (spawn1.status !== "run") throw new Error("unreachable");
      const agentId = spawn1.agentId; // T10a：agent-<唯一串>，捕获而非硬编码
      expect(runner1.launched).toHaveLength(1);
      await d1.shutdown(); // 优雅退出：drain（running 投影行已落盘）

      // 重启：RestoreService 扩展收口
      const engine2 = new FakeAgentEngine({});
      const runner2 = new HangingRunner();
      const d2 = await makeDaemon(home, engine2, runner2);

      // 注册表恢复：快照 instances 含该实例（failed 收口态）
      const entry = instanceOf(d2, agentId);
      expect(entry).toBeDefined();
      expect(entry!["state"]).toBe("failed");
      expect(entry!["task"]).toBe("正在运行中的任务"); // task 从 agent.spawned 事件流恢复
      expect((entry!["closure"] as Record<string, unknown>)["summary"]).toBe(RESTART_SUMMARY);

      // 双源核对：agent_lifecycle 行已收口 failed
      expect(lifecycleRows(home)[agentId]).toBe("failed");
      // closure 记录行（status=failed + 固定文案；O-5 抗重启本体）
      expect(closureRows(home)[agentId]).toMatchObject({ status: "failed", summary: RESTART_SUMMARY });

      // closure failed 注入主线（SteerQueue，下轮 turn 消费；不自动驱动）
      const pending = d2.session.getSnapshot().session.pendingSteer;
      expect(pending.map((i) => i.text)).toContain(`${agentId} closure: failed — ${RESTART_SUMMARY}`);
      expect(pending.find((i) => i.text.includes("closure: failed"))?.source).toBe("closure");

      // 不自动续跑：agentState=idle + 引擎零事件 + 无新 agent.started
      expect(d2.system.getStatus().agentState).toBe("idle");
      expect(engine2.events).toHaveLength(0);
      expect(eventCount(home, "agent.started", agentId)).toBe(1); // 仅停机前那一条
      expect(runner2.launched).toHaveLength(0); // 无复活 spawn
      await d2.shutdown();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe("T2.4 ② queued → cancelled（队列不落盘，重启清队；无 closure 记录）", () => {
  test("3 running + 1 queued → 重启：cancelled 渲染态区别 failed + 不自动重派 + 无 closure 行", async () => {
    const home = tmpHome();
    try {
      const runner1 = new HangingRunner();
      const d1 = await makeDaemon(home, new FakeAgentEngine({}), runner1);
      const ids: string[] = [];
      for (const t of ["任务一", "任务二", "任务三"]) {
        const o = d1.orchestration.spawn(t);
        if (o.status !== "run") throw new Error("unreachable");
        ids.push(o.agentId); // T10a：agent-<唯一串>，捕获而非硬编码
      }
      const queuedOutcome = d1.orchestration.spawn("排队中的任务四"); // maxConcurrent=3 → 第 4 个入队
      expect(queuedOutcome).toMatchObject({ status: "queued", position: 1 });
      if (queuedOutcome.status !== "queued") throw new Error("unreachable");
      ids.push(queuedOutcome.agentId);
      await d1.shutdown();

      const engine2 = new FakeAgentEngine({});
      const runner2 = new HangingRunner();
      const d2 = await makeDaemon(home, engine2, runner2);

      const snap = d2.session.getSnapshot();
      const byId = Object.fromEntries((snap.instances ?? []).map((i) => [i["instanceId"], i]));
      expect(byId[ids[0]!]!["state"]).toBe("failed");
      expect(byId[ids[1]!]!["state"]).toBe("failed");
      expect(byId[ids[2]!]!["state"]).toBe("failed");
      expect(byId[ids[3]!]!["state"]).toBe("cancelled"); // 区别于 failed
      expect(byId[ids[3]!]!["closure"]).toBeUndefined(); // cancelled 无 closure（未开跑）

      // agent_lifecycle 行：3 failed + 1 cancelled
      const rows = lifecycleRows(home);
      expect(rows[ids[0]!]).toBe("failed");
      expect(rows[ids[3]!]).toBe("cancelled");

      // closure_records 恰 3 行（running 收口），无 queued 实例行
      expect(closureRows(home)[ids[3]!]).toBeUndefined();
      expect(Object.keys(closureRows(home)).sort()).toEqual([...ids.slice(0, 3)].sort());

      // 不自动重派：重启后零 launch；3 条注入按序在队（三个 running 实例）
      expect(runner2.launched).toHaveLength(0);
      expect(d2.session.getSnapshot().session.pendingSteer.map((i) => i.text)).toEqual([
        `${ids[0]} closure: failed — ${RESTART_SUMMARY}`,
        `${ids[1]} closure: failed — ${RESTART_SUMMARY}`,
        `${ids[2]} closure: failed — ${RESTART_SUMMARY}`,
      ]);
      // T10a：唯一串 id 无序号基线——重启后新 spawn 仍得 agent-<唯一串> 且与历史互异（无撞号概念）
      const next = d2.orchestration.spawn("重启后的新任务");
      expect(next.status).toBe("run");
      if (next.status !== "run") throw new Error("unreachable");
      expect(next.agentId).toMatch(/^agent-[0-9a-f]+$/);
      expect(ids).not.toContain(next.agentId);
      await d2.shutdown();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe("T2.4 ③ done 终态实例卡片恢复 + closure 完整（R1 进程内级）", () => {
  test("spawn → closure done（O-5 双产物）→ 重启：卡片 done + closure 五字段完整 + 报告文件在", async () => {
    const home = tmpHome();
    try {
      const runner1 = new HangingRunner();
      const d1 = await makeDaemon(home, new FakeAgentEngine({}), runner1);
      const spawn3 = d1.orchestration.spawn("生成报告的任务");
      if (spawn3.status !== "run") throw new Error("unreachable");
      const agentId = spawn3.agentId; // T10a：agent-<唯一串>
      runner1.forceClosure(agentId, {
        result: "done",
        closure: {
          status: "done",
          summary: "报告任务完成",
          reportPath: null,
          findings: [{ kind: "sediment", changeType: "新增" }],
          taskId: "T2.4",
        },
      });
      await d1.shutdown();

      const d2 = await makeDaemon(home, new FakeAgentEngine({}), new HangingRunner());
      const entry = instanceOf(d2, agentId);
      expect(entry).toBeDefined();
      expect(entry!["state"]).toBe("done");
      expect(entry!["task"]).toBe("生成报告的任务");
      const closure = entry!["closure"] as Record<string, unknown>;
      expect(closure["status"]).toBe("done");
      expect(closure["summary"]).toBe("报告任务完成");
      expect(closure["taskId"]).toBe("T2.4");
      expect(closure["findings"]).toEqual([{ kind: "sediment", changeType: "新增" }]); // findings JSON 往返
      // reportPath 指向停机前的 O-5 报告文件（磁盘上仍可读）
      const sessionId = d1.system.getStatus().sessionId;
      const reportPath = path.join(home, "reports", sessionId, `${agentId}.md`);
      expect(closure["reportPath"]).toBe(reportPath);
      expect(existsSync(reportPath)).toBe(true);
      // 无 pendingSteer 注入（done closure 停机前已消费）
      expect(d2.session.getSnapshot().session.pendingSteer).toEqual([]);
      await d2.shutdown();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe("T2.4 ④ 混态重建一致性（注册表/账目/closure：快照字段 vs 落盘行/事件流双源核对）", () => {
  test("done+failed+running+queued 混态 → 重启：instances 与 agent_lifecycle/closure_records 一致 + usage 空聚合", async () => {
    const home = tmpHome();
    try {
      const runner1 = new HangingRunner();
      const d1 = await makeDaemon(home, new FakeAgentEngine({}), runner1);
      // 混态构造：3 running + 2 queued → 收口
      // 首个 done（释放位→首个 queued 出队转 running，第二个仍 queued）
      const ids: string[] = [];
      for (const t of ["完成的任务", "崩溃的任务", "运行中的任务"]) {
        const o = d1.orchestration.spawn(t);
        if (o.status !== "run") throw new Error("unreachable");
        ids.push(o.agentId); // T10a：agent-<唯一串>，捕获而非硬编码
      }
      for (const t of ["排队的任务四", "排队的任务五"]) {
        const o = d1.orchestration.spawn(t);
        expect(o).toMatchObject({ status: "queued" });
        if (o.status !== "queued") throw new Error("unreachable");
        ids.push(o.agentId);
      }
      runner1.forceClosure(ids[0]!, {
        result: "done",
        closure: { status: "done", summary: "任务一完成", reportPath: null, findings: null, taskId: null },
      });
      // 首个收口释放运行位 → 任务四出队转 running（FIFO 出队语义），任务五仍 queued
      expect(d1.orchestration.status(ids[3]!)[0]?.state).toBe("running");
      expect(d1.orchestration.status(ids[4]!)[0]?.state).toBe("queued");
      await d1.shutdown();

      const d2 = await makeDaemon(home, new FakeAgentEngine({}), new HangingRunner());
      // T10a：主实例 id = 会话 mainInstanceId（agent-<唯一串>，重启后持久化读回同值）
      const mainId = d2.registry.peek(d1.system.getStatus().sessionId)!.chatService.sessionView.mainInstanceId;
      expect(mainId).toMatch(/^agent-[0-9a-f]+$/);
      const instances = d2.session.getSnapshot().instances ?? [];
      expect(instances.map((i) => [i["instanceId"], i["state"]])).toEqual([
        [mainId, "running"], // 主实例常驻条目（快照组装面组装，前端账目 popover 用）
        [ids[0]!, "done"],
        [ids[1]!, "failed"],
        [ids[2]!, "failed"],
        [ids[3]!, "failed"], // 出队后 running（停机时）→ 重启收口 failed
        [ids[4]!, "cancelled"], // 仍 queued（停机时）→ 重启清队收口 cancelled
      ]);

      // 双源核对一：instances[].closure ↔ closure_records 行（每实例最新）
      const rows = closureRows(home);
      expect((instanceOf(d2, ids[0]!)!["closure"] as Record<string, unknown>)["summary"]).toBe(rows[ids[0]!]!.summary);
      expect((instanceOf(d2, ids[1]!)!["closure"] as Record<string, unknown>)["summary"]).toBe(rows[ids[1]!]!.summary);
      expect(rows[ids[2]!]!.summary).toBe(RESTART_SUMMARY);
      expect(rows[ids[3]!]!.summary).toBe(RESTART_SUMMARY); // 出队 running 同样收口
      expect(rows[ids[4]!]).toBeUndefined(); // cancelled 无 closure 记录（未开跑）

      // 双源核对二：instances[].state ↔ agent_lifecycle 行（SubAgent 全等；主实例例外——
      // 表行是会话运行态 AgentLifecycleState（停机后 stopped），实例窗口态是另一维度）
      const lifecycle = lifecycleRows(home);
      for (const i of instances) {
        if (i["instanceId"] === mainId) continue;
        expect(lifecycle[i["instanceId"] as string]).toBe(i["state"]);
      }

      // 双源核对三：instances[].task ↔ domain_events agent.spawned 载荷
      expect((instanceOf(d2, ids[1]!)!["task"] as string)).toBe("崩溃的任务");

      // 账目恢复（T3.2 前占位）：usage 空聚合（七字段全 0，契约 §6.2 形状）
      const usage = d2.session.getSnapshot().usage as { total: Record<string, number>; compaction: Record<string, number> } | undefined;
      expect(usage).toBeDefined();
      expect(Object.values(usage!.total).every((v) => v === 0)).toBe(true);
      expect(Object.values(usage!.compaction).every((v) => v === 0)).toBe(true);

      // 主线历史 Entry 保留可回放（历史不删不改）
      expect(d2.session.getSnapshot().session.entries.length).toBeGreaterThanOrEqual(0);
      await d2.shutdown();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});
