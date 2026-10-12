import { describe, expect, test } from "bun:test";
import type { TaskStorePort, JobData } from "../../src/application/ports/outbound/TaskStorePort";
import type { KnowledgeGraphPort } from "../../src/application/ports/outbound/KnowledgeGraphPort";
import type { OccupancyLeaseData } from "../../src/domain/agent/OccupancyLease";
import type { WorkspaceStack } from "../../src/application/services/workspace/WorkspaceService";
import type { KgTriageService, KgTriageResult, KgTriageCreateView } from "../../src/application/services/kg/KgTriageService";
import {
  KgTriageAutoTrigger,
  KG_TRIAGE_AUTO_COOLDOWN_MS,
  KG_TRIAGE_AUTO_WATERMARK_AGE_MS,
  KG_TRIAGE_AUTO_WATERMARK_COUNT,
} from "../../src/application/services/kg/KgTriageAutoTrigger";

/**
 * KgTriageAutoTrigger 单测（B批：静默点自动触发）：
 * 水位双判据（pending 数 / 年龄，只计 pending 不计 deferred）→ 静默门
 * （无 pending/running 任务 + 无 active 写租约）→ 冷却窗 → create
 * （createdBy="auto"）。静默门是降险不是安全前提——被挡即推迟，下轮
 * 通知/sweep 重评（无状态）。
 */

const ROOT = "/tmp/unit-auto-triage/alpha";
const NOW = Date.parse("2026-10-12T12:00:00Z");

function jobRow(over: Partial<JobData>): JobData {
  return {
    id: "job-t",
    type: "dev-task",
    params: {},
    projects: ["alpha"],
    status: "done",
    createdBy: "page",
    createdAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    error: null,
    ...over,
  };
}

function pendingRow(ageMs: number): { createdAt: string } {
  return { createdAt: new Date(NOW - ageMs).toISOString() };
}

interface Harness {
  trigger: KgTriageAutoTrigger;
  creates: Array<{ project: string; createdBy: string }>;
  reads: string[];
}

function makeTrigger(opts: {
  hasIndex?: boolean;
  pending?: Array<{ createdAt: string }>;
  jobs?: JobData[];
  leases?: OccupancyLeaseData[];
  createOk?: boolean;
  triageBound?: boolean;
  stackBound?: boolean;
}): Harness {
  const creates: Array<{ project: string; createdBy: string }> = [];
  const reads: string[] = [];
  const pending = opts.pending ?? [];
  const triage = {
    create: (project: string, o?: { createdBy?: string }): Promise<KgTriageResult<KgTriageCreateView>> => {
      creates.push({ project, createdBy: o?.createdBy ?? "page" });
      return opts.createOk === false
        ? Promise.resolve({ ok: false, error: { code: "kg.triage.not_eligible", message: "nothing_pending" } })
        : Promise.resolve({ ok: true, value: { jobId: "job-auto-1" } });
    },
  } as unknown as KgTriageService;
  const stack = {
    projectService: {
      hasIndex: () => opts.hasIndex ?? true,
      listProjects: () => [{ name: "alpha", path: ROOT }],
    },
    graph: {
      listCandidates: (root: string, q: { status?: string }) => {
        reads.push(`${root}:${q.status ?? "*"}`);
        return pending;
      },
    } as unknown as KnowledgeGraphPort,
  } as unknown as WorkspaceStack;
  const trigger = new KgTriageAutoTrigger({
    triage: () => (opts.triageBound === false ? undefined : triage),
    stack: () => (opts.stackBound === false ? null : stack),
    listJobs: () => opts.jobs ?? [],
    leases: () => opts.leases ?? [],
    now: () => NOW,
    debounceMs: 0,
  });
  return { trigger, creates, reads };
}

function lease(over: Partial<OccupancyLeaseData>): OccupancyLeaseData {
  return {
    leaseId: "lease-1",
    ownerSessionId: "s1",
    ownerAgentId: "main",
    executors: [],
    scope: { kind: "project", projectRoot: ROOT },
    intent: "改代码",
    source: "claimed",
    status: "active",
    claimedAt: NOW - 60_000,
    lastActivityAt: NOW,
    ...over,
  };
}

describe("KgTriageAutoTrigger 水位", () => {
  test("pending ≥ 20 + 静默 → 自动发起（createdBy=auto）", async () => {
    const h = makeTrigger({ pending: Array.from({ length: KG_TRIAGE_AUTO_WATERMARK_COUNT }, () => pendingRow(60_000)) });
    h.trigger.evaluate(ROOT);
    await Promise.resolve();
    expect(h.creates).toEqual([{ project: ROOT, createdBy: "auto" }]);
  });

  test("最老 pending ≥ 48h（条数不足）也命中年龄水位", async () => {
    const h = makeTrigger({ pending: [pendingRow(KG_TRIAGE_AUTO_WATERMARK_AGE_MS + 1000)] });
    h.trigger.evaluate(ROOT);
    await Promise.resolve();
    expect(h.creates.length).toBe(1);
  });

  test("水位不足（少而新）→ 不发起", () => {
    const h = makeTrigger({ pending: [pendingRow(60_000), pendingRow(30_000)] });
    h.trigger.evaluate(ROOT);
    expect(h.creates.length).toBe(0);
  });

  test("零 pending → 不发起不空读", () => {
    const h = makeTrigger({ pending: [] });
    h.trigger.evaluate(ROOT);
    expect(h.creates.length).toBe(0);
    expect(h.reads).toEqual([`${ROOT}:pending`]);
  });
});

describe("KgTriageAutoTrigger 静默门", () => {
  test("pending/running 任务在跑 → 推迟；终态后 sweep 补触发", async () => {
    const pending = Array.from({ length: KG_TRIAGE_AUTO_WATERMARK_COUNT }, () => pendingRow(60_000));
    const h = makeTrigger({ pending, jobs: [jobRow({ status: "running" })] });
    h.trigger.evaluate(ROOT);
    expect(h.creates.length).toBe(0);
    // 任务终态 + 冷却窗内（同 job 3h 前创建）→ 冷却仍挡；换新触发器模拟 7h 后
    const h2 = makeTrigger({
      pending,
      jobs: [jobRow({ status: "done", createdAt: new Date(NOW - 7 * 60 * 60 * 1000).toISOString() })],
    });
    h2.trigger.evaluate(ROOT);
    await Promise.resolve();
    expect(h2.creates.length).toBe(1);
  });

  test("paused 任务不算忙（显式挂起）", async () => {
    const h = makeTrigger({
      pending: Array.from({ length: KG_TRIAGE_AUTO_WATERMARK_COUNT }, () => pendingRow(60_000)),
      jobs: [jobRow({ status: "paused" })],
    });
    h.trigger.evaluate(ROOT);
    await Promise.resolve();
    expect(h.creates.length).toBe(1);
  });

  test("active 写租约 → 推迟；settled 租约不挡", async () => {
    const pending = Array.from({ length: KG_TRIAGE_AUTO_WATERMARK_COUNT }, () => pendingRow(60_000));
    const h = makeTrigger({ pending, leases: [lease({})] });
    h.trigger.evaluate(ROOT);
    expect(h.creates.length).toBe(0);
    const h2 = makeTrigger({ pending, leases: [lease({ status: "settled" })] });
    h2.trigger.evaluate(ROOT);
    await Promise.resolve();
    expect(h2.creates.length).toBe(1);
  });

  test("paths 租约指向项目内 = 在写（双向前缀）", () => {
    const h = makeTrigger({
      pending: Array.from({ length: KG_TRIAGE_AUTO_WATERMARK_COUNT }, () => pendingRow(60_000)),
      leases: [lease({ scope: { kind: "paths", patterns: [`${ROOT}/src/foo.ts`] } })],
    });
    h.trigger.evaluate(ROOT);
    expect(h.creates.length).toBe(0);
  });
});

describe("KgTriageAutoTrigger 冷却与边界", () => {
  test("6h 内已有 kg-triage job（含终态）→ 冷却不再自动发", () => {
    const h = makeTrigger({
      pending: Array.from({ length: KG_TRIAGE_AUTO_WATERMARK_COUNT }, () => pendingRow(60_000)),
      jobs: [jobRow({ type: "kg-triage" })],
    });
    h.trigger.evaluate(ROOT);
    expect(h.creates.length).toBe(0);
  });

  test("冷却窗外的旧 triage job 不挡", async () => {
    const h = makeTrigger({
      pending: Array.from({ length: KG_TRIAGE_AUTO_WATERMARK_COUNT }, () => pendingRow(60_000)),
      jobs: [jobRow({ type: "kg-triage", createdAt: new Date(NOW - KG_TRIAGE_AUTO_COOLDOWN_MS - 1000).toISOString() })],
    });
    h.trigger.evaluate(ROOT);
    await Promise.resolve();
    expect(h.creates.length).toBe(1);
  });

  test("索引 absent → 短路零读零发起（读 port 连接即建库红线）", () => {
    const h = makeTrigger({ hasIndex: false, pending: [pendingRow(KG_TRIAGE_AUTO_WATERMARK_AGE_MS * 2)] });
    h.trigger.evaluate(ROOT);
    expect(h.creates.length).toBe(0);
    expect(h.reads.length).toBe(0);
  });

  test("stack/triage 未绑定 → 零动作不炸", () => {
    const h = makeTrigger({ triageBound: false, stackBound: false });
    h.trigger.evaluate(ROOT);
    h.trigger.sweep();
    expect(h.creates.length).toBe(0);
  });

  test("create 被准入拒绝 → 记录一次不重试风暴", async () => {
    const h = makeTrigger({
      pending: Array.from({ length: KG_TRIAGE_AUTO_WATERMARK_COUNT }, () => pendingRow(60_000)),
      createOk: false,
    });
    h.trigger.evaluate(ROOT);
    await Promise.resolve();
    expect(h.creates.length).toBe(1);
    h.trigger.evaluate(ROOT);
    await Promise.resolve();
    expect(h.creates.length).toBe(2); // 每次评估各试一次，无内部重试循环
  });
});

describe("KgTriageAutoTrigger 通知防抖与 sweep", () => {
  test("候选变化通知防抖合流：3 通知 → 1 次评估", async () => {
    const h = makeTrigger({ pending: Array.from({ length: KG_TRIAGE_AUTO_WATERMARK_COUNT }, () => pendingRow(60_000)) });
    h.trigger.notifyCandidateChange(ROOT);
    h.trigger.notifyCandidateChange(ROOT);
    h.trigger.notifyCandidateChange(ROOT);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.creates.length).toBe(1);
  });

  test("sweep 按项目清单逐评估", async () => {
    const h = makeTrigger({ pending: [pendingRow(KG_TRIAGE_AUTO_WATERMARK_AGE_MS * 2)] });
    h.trigger.sweep();
    await Promise.resolve();
    expect(h.creates).toEqual([{ project: ROOT, createdBy: "auto" }]);
  });
});
