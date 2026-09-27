import { describe, expect, test } from "bun:test";
import type { TaskEnginePort } from "../../src/application/ports/inbound/TaskEnginePort";
import type { KnowledgeGraphPort } from "../../src/application/ports/outbound/KnowledgeGraphPort";
import type { TaskStorePort } from "../../src/application/ports/outbound/TaskStorePort";
import { KgTriageService, type TriageEligibility } from "../../src/application/services/kg/KgTriageService";
import type { KgProjectService } from "../../src/application/services/kg/KgProjectService";
import type { KgVerifyService } from "../../src/application/services/kg/KgVerifyService";
import type { CandidateStatusCounts } from "../../src/domain/kg/types";
import type { OrphanItem } from "../../src/domain/kg/verify/orphans";
import type { JobRow } from "../../src/adapters/driven/sqlite-session/rows/TaskRows";

/**
 * KgTriageService 单测（kg-triage P1）：准入三态（index_absent / nothing_pending /
 * task_running）+ 待办面三计数（pending+deferred+dead_anchor）+ create 发起路径。
 *
 * nothing_pending 是 triage 与 kg-review 准入的唯一语义差（空待办不发起空任务）；
 * 三计数同时是 /project 页发起按钮可用性数据源（设计 §5.1）。
 */

const ROOT = "/tmp/unit-triage/alpha";

function makeService(opts: {
  hasIndex?: boolean;
  candidateCounts?: Partial<CandidateStatusCounts>;
  deadAnchors?: number;
  otherOrphans?: number;
  activeTriageJobs?: JobRow[];
  createResult?: { jobId: string } | { code: string; message: string };
}): { service: KgTriageService; created: unknown[] } {
  const created: unknown[] = [];
  const service = new KgTriageService({
    project: {
      hasIndex: () => opts.hasIndex ?? true,
      resolve: (p: string) => (p === "alpha" ? ROOT : undefined),
    } as unknown as KgProjectService,
    taskEngine: {
      createTask: (req: unknown) => {
        created.push(req);
        if (opts.createResult && "code" in opts.createResult) {
          throw Object.assign(new Error(opts.createResult.message), { code: opts.createResult.code });
        }
        return Promise.resolve({ jobId: (opts.createResult as { jobId: string } | undefined)?.jobId ?? "job-t1" });
      },
    } as unknown as TaskEnginePort,
    store: { listJobs: () => opts.activeTriageJobs ?? [] } as unknown as TaskStorePort,
    graph: {
      countCandidatesByStatus: (_root: string): CandidateStatusCounts => ({
        pending: opts.candidateCounts?.pending ?? 0,
        deferred: opts.candidateCounts?.deferred ?? 0,
        applied: 0,
        discarded: 0,
      }),
    } as unknown as KnowledgeGraphPort,
    verify: {
      findOrphans: (_root: string): OrphanItem[] => [
        ...(opts.deadAnchors ? (Array.from({ length: opts.deadAnchors }, () => ({ kind: "dead_anchor" } as const)) as OrphanItem[]) : []),
        ...(opts.otherOrphans ? (Array.from({ length: opts.otherOrphans }, () => ({ kind: "orphan_node" } as const)) as OrphanItem[]) : []),
      ],
    } as unknown as KgVerifyService,
  });
  return { service, created };
}

function triageJob(active: boolean): JobRow {
  return {
    jobId: active ? "job-running" : "job-done",
    type: "kg-triage",
    title: "t",
    status: active ? "running" : "done",
    projects: ["alpha"],
    createdBy: "page",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    progress: null,
    error: null,
  } as unknown as JobRow;
}

describe("KgTriageService 准入三态（与 kg-review 的唯一差 = nothing_pending 门槛）", () => {
  test("① index_absent：无索引拒绝（证据验证依赖代码索引）", () => {
    const { service } = makeService({ hasIndex: false, candidateCounts: { pending: 2 } });
    expect(service.eligibility(ROOT)).toEqual({ eligible: false, reason: "index_absent" } satisfies TriageEligibility);
  });

  test("② nothing_pending：三计数全零拒绝（空待办不发起空任务）——孤儿节点不计入（只数 dead_anchor）", () => {
    const onlyOrphanNodes = makeService({ candidateCounts: { pending: 0 }, otherOrphans: 3 });
    expect(onlyOrphanNodes.service.eligibility(ROOT)).toEqual({ eligible: false, reason: "nothing_pending" } satisfies TriageEligibility);
    const allZero = makeService({ candidateCounts: { pending: 0, deferred: 0 }, deadAnchors: 0 });
    expect(allZero.service.eligibility(ROOT)).toEqual({ eligible: false, reason: "nothing_pending" } satisfies TriageEligibility);
  });

  test("③ task_running：非终态 kg-triage job 拒绝（仅禁并发）；终态 job 放行", () => {
    const running = makeService({ candidateCounts: { pending: 1 }, activeTriageJobs: [triageJob(true)] });
    expect(running.service.eligibility(ROOT)).toEqual({ eligible: false, reason: "task_running" } satisfies TriageEligibility);
    const done = makeService({ candidateCounts: { pending: 1 }, activeTriageJobs: [triageJob(false)] });
    expect(done.service.eligibility(ROOT)).toEqual({ eligible: true } satisfies TriageEligibility);
  });

  test("④ eligible：待办面非空（任一路有量即过——pending/deferred/dead_anchor）", () => {
    expect(makeService({ candidateCounts: { deferred: 1 } }).service.eligibility(ROOT)).toEqual({ eligible: true });
    expect(makeService({ deadAnchors: 2 }).service.eligibility(ROOT)).toEqual({ eligible: true });
  });
});

describe("KgTriageService 待办面三计数（发起按钮可用性同源）", () => {
  test("pending + deferred + dead_anchor 求和；orphan_node/unanchored 不计入", () => {
    const { service } = makeService({ candidateCounts: { pending: 2, deferred: 1 }, deadAnchors: 3, otherOrphans: 5 });
    expect(service.pendingCount(ROOT)).toBe(6);
  });
});

describe("KgTriageService create 发起路径", () => {
  test("成功：type=kg-triage、params 带 projectRoot、createdBy=page", async () => {
    const { service, created } = makeService({ candidateCounts: { pending: 1 }, createResult: { jobId: "job-9" } });
    const result = await service.create("alpha");
    expect(result).toEqual({ ok: true, value: { jobId: "job-9" } });
    expect(created).toEqual([
      { type: "kg-triage", projects: ["alpha"], params: { projectRoot: ROOT }, createdBy: "page" },
    ]);
  });

  test("项目无法解析：KG_E_PARAM（path=payload.project）", async () => {
    const { service } = makeService({ candidateCounts: { pending: 1 } });
    const result = await service.create("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("KG_E_PARAM");
      expect(result.error.path).toBe("payload.project");
    }
  });

  test("nothing_pending 拒绝：kg.triage.not_eligible 且 message 含 nothing_pending", async () => {
    const { service } = makeService({});
    const result = await service.create("alpha");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("kg.triage.not_eligible");
      expect(result.error.message).toContain("nothing_pending");
    }
  });

  test("引擎错误归一：type_unknown 原码透传（skill 未装载时防线）", async () => {
    const { service } = makeService({ candidateCounts: { pending: 1 }, createResult: { code: "task.type_unknown", message: "类型未知" } });
    const result = await service.create("alpha");
    expect(result).toEqual({
      ok: false,
      error: { code: "task.type_unknown", message: "类型未知" },
    });
  });
});
