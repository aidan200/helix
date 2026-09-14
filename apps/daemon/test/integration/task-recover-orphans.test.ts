import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import { TaskEngineService } from "../../src/application/services/task/TaskEngineService";
import type { TaskEngineEnv } from "../helpers/task-fixtures";
import { buildTaskEngineEnv } from "../helpers/task-fixtures";

/**
 * 恢复链幽灵实例收口（task-efd68911 事故实证）：
 * daemon 非优雅退出后，任务 SubAgent 的 agent_lifecycle 投影行停留非终态
 * （实证：3 行 running 停在暴毙前一刻——批次层已被 recoverJob 对账重派，
 * 实例行无人收口 → trace 观测面永远显示活跃）。recoverOnStartup 首段收口：
 * - running/parked → failed + 补发 agent.failed（daemon_restarted）；
 * - queued → cancelled（TR-35 分态语义；cancelled 无 closure 记录不发事件）；
 * 判据：instance_id 为 agent-* 形态（main 行归会话恢复链管辖）+ 非终态 +
 * updated_at 早于本代 bootedAt（防误伤本代新 spawn 实例）。幂等：终态不再命中。
 */

interface OrphanFixture {
  readonly dispose: () => void;
  readonly engine: ReturnType<typeof buildTaskEngineEnv>["engine"];
  readonly repo: SqliteSessionRepository;
  readonly published: DomainEvent[];
  readonly bootedAtMs: number;
}

/** 真库 + 幽灵行现场：bootedAt = now；幽灵行 updated_at 一分钟前，本代行一小时后。 */
async function orphanEnv(rows: readonly { session: string; instance: string; state: string; updatedIso: string }[]): Promise<OrphanFixture> {
  const env = buildTaskEngineEnv();
  const repo = new SqliteSessionRepository(env.queue);
  const bootedAtMs = Date.now();
  for (const r of rows) {
    env.queue.database
      .prepare("INSERT INTO agent_lifecycle (session_id, instance_id, state, updated_at) VALUES (?, ?, ?, ?)")
      .run(r.session, r.instance, r.state, r.updatedIso);
  }
  const published: DomainEvent[] = [];
  const clock = { now: () => new Date().toISOString(), nowMs: () => Date.now() };
  const engine = new TaskEngineService({
    store: env.store,
    skills: env.skills,
    starter: env.starter,
    workLedger: env.workLedger,
    clock,
    agentProjections: repo,
    events: { publish: (e) => published.push(e) },
    bootedAtMs,
  });
  return {
    dispose: () => void env.dispose(),
    engine,
    repo,
    published,
    bootedAtMs,
  };
}



const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

describe("恢复链幽灵实例收口（task-efd68911 事故）", () => {
  test("running/parked 幽灵行 → failed + agent.failed（daemon_restarted）；queued → cancelled 零事件", async () => {
    const fx = await orphanEnv([
      { session: "task:job-1", instance: "agent-aaa111", state: "running", updatedIso: PAST },
      { session: "task:job-1", instance: "agent-bbb222", state: "parked", updatedIso: PAST },
      { session: "task:job-1", instance: "agent-ccc333", state: "queued", updatedIso: PAST },
    ]);
    try {
      await fx.engine.recoverOnStartup();

      const rows = await fx.repo.queryAgentLifecycles("task:job-1");
      const byId = new Map(rows.map((r) => [r.instanceId, r.state]));
      expect(byId.get("agent-aaa111")).toBe("failed");
      expect(byId.get("agent-bbb222")).toBe("failed");
      expect(byId.get("agent-ccc333")).toBe("cancelled");

      const failures = fx.published.filter((e) => e.type === "agent.failed");
      expect(failures.map((e) => e.instanceId).sort()).toEqual(["agent-aaa111", "agent-bbb222"]);
      for (const e of failures) {
        expect((e.payload as { error: string }).error).toContain("daemon_restarted");
      }
    } finally {
      fx.dispose();
    }
  });

  test("main 行与本代新实例行不误伤", async () => {
    const fx = await orphanEnv([
      { session: "chat-1", instance: "main", state: "running", updatedIso: PAST },
      { session: "task:job-2", instance: "agent-new999", state: "running", updatedIso: FUTURE },
    ]);
    try {
      await fx.engine.recoverOnStartup();

      const chat = await fx.repo.queryAgentLifecycles("chat-1");
      expect(chat.find((r) => r.instanceId === "main")?.state).toBe("running");
      const task2 = await fx.repo.queryAgentLifecycles("task:job-2");
      expect(task2.find((r) => r.instanceId === "agent-new999")?.state).toBe("running");
      expect(fx.published).toHaveLength(0);
    } finally {
      fx.dispose();
    }
  });

  test("幂等：二次 recoverOnStartup 零新事件、行保持终态", async () => {
    const fx = await orphanEnv([{ session: "task:job-3", instance: "agent-ddd444", state: "running", updatedIso: PAST }]);
    try {
      await fx.engine.recoverOnStartup();
      const first = fx.published.length;
      await fx.engine.recoverOnStartup();
      expect(fx.published.length).toBe(first);
      const rows = await fx.repo.queryAgentLifecycles("task:job-3");
      expect(rows.find((r) => r.instanceId === "agent-ddd444")?.state).toBe("failed");
    } finally {
      fx.dispose();
    }
  });

  test("未注入收口依赖（缺省形态）零行为——纯引擎测试面兼容", async () => {
    const env = buildTaskEngineEnv();
    try {
      env.queue.database
        .prepare("INSERT INTO agent_lifecycle (session_id, instance_id, state, updated_at) VALUES (?, ?, ?, ?)")
        .run("task:job-4", "agent-eee555", "running", PAST);
      // env.engine 未注入 agentProjections/bootedAtMs——不扫描不收口不炸
      await env.engine.recoverOnStartup();
      const rows = await new SqliteSessionRepository(env.queue).queryAgentLifecycles("task:job-4");
      expect(rows.find((r) => r.instanceId === "agent-eee555")?.state).toBe("running");
    } finally {
      await env.dispose();
    }
  });
});
