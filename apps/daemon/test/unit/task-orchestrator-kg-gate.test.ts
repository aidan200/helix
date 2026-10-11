/**
 * kg-bootstrap 硬闸（D2，批1 WP-A）单测——TaskOrchestratorService.startOrchestrator
 * 任务开工检查（最小 fake deps：闸在装配/批次循环之前短路）。
 *
 * 断言面：
 * 1. kg-bootstrap 任务开工 ∧ 默认 embedding 端点缺席（resolveDefault null）→
 *    任务失败（failJob）+ 提示「请先配置默认 embedding 端点」+ 零装配零 spawn；
 * 2. 默认端点在场 → 照常开工（编排会话装配发生）；
 * 3. 非 kg-bootstrap 任务不受闸影响（范围钳制：只挡 kg-bootstrap，D2）。
 */
import { describe, expect, test } from "bun:test";
import { TaskOrchestratorService } from "../../src/application/services/task/TaskOrchestratorService";
import type { TaskEnginePort } from "../../src/application/ports/inbound/TaskEnginePort";
import type { JobData } from "../../src/application/ports/outbound/TaskStorePort";

function makeService(opts: { type: string; hasDefault: boolean }) {
  const failed: { jobId: string; error: string }[] = [];
  let sessionsCreated = 0;
  const job: JobData = {
    id: "job-1",
    type: opts.type,
    status: "pending",
    projects: ["helix"],
    params: {},
    createdBy: "page",
    createdAt: "2026-10-11T00:00:00.000Z",
  } as unknown as JobData;
  const service = new TaskOrchestratorService({
    store: {
      getJob: (id: string) => (id === "job-1" ? job : undefined),
      getStages: () => [],
      getBatches: () => [],
      listJobs: () => [job],
    },
    taskEngine: {
      failJob: async (jobId: string, error: string) => {
        failed.push({ jobId, error });
      },
    } as unknown as TaskEnginePort,
    ledger: {},
    skills: { getSkill: () => undefined },
    skillTextOf: async () => undefined,
    rawSpawn: () => ({ ok: true, agentId: "a-1" }),
    instanceOutcome: () => undefined,
    killInstance: () => {},
    parkInstance: async () => ({ parked: true }),
    resumeInstance: async () => ({ queued: true }),
    createSession: () => {
      sessionsCreated += 1;
      return {
        drive: async () => {},
        inject: () => {},
        abort: () => {},
      };
    },
    planHardConstraint: "",
    reportsDirFor: (sessionId: string) => `/tmp/${sessionId}`,
    hasDefaultEmbeddingEndpoint: () => opts.hasDefault,
  } as unknown as ConstructorParameters<typeof TaskOrchestratorService>[0]);
  return { service, failed, sessions: () => sessionsCreated };
}

describe("kg-bootstrap 硬闸（D2：任务开工检查默认 embedding 端点）", () => {
  test("① 无默认端点 → 任务失败 + 提示配置；零装配零 spawn", async () => {
    const { service, failed, sessions } = makeService({ type: "kg-bootstrap", hasDefault: false });
    await service.startOrchestrator("job-1");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.jobId).toBe("job-1");
    expect(failed[0]!.error).toContain("请先配置默认 embedding 端点");
    expect(sessions()).toBe(0); // 不装配编排会话（任务直接失败收口）
  });

  test("② 默认端点在场 → 照常开工（编排会话装配发生）", async () => {
    const { service, failed, sessions } = makeService({ type: "kg-bootstrap", hasDefault: true });
    await service.startOrchestrator("job-1");
    expect(failed).toEqual([]);
    expect(sessions()).toBe(1);
  });

  test("③ 非 kg-bootstrap 任务零影响（范围钳制：D2 只挡 kg-bootstrap）", async () => {
    const { service, failed, sessions } = makeService({ type: "code-review", hasDefault: false });
    await service.startOrchestrator("job-1");
    expect(failed).toEqual([]);
    expect(sessions()).toBe(1);
  });
});
