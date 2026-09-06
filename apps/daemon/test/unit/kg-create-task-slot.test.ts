import { describe, expect, test } from "bun:test";
import type { TaskEnginePort } from "../../src/application/ports/inbound/TaskEnginePort";
import type { KnowledgeGraphPort } from "../../src/application/ports/outbound/KnowledgeGraphPort";
import type { TaskStorePort } from "../../src/application/ports/outbound/TaskStorePort";
import type { TaskSkillRegistryPort } from "../../src/application/ports/outbound/TaskSkillRegistryPort";
import { CodeReviewService } from "../../src/application/services/kg/CodeReviewService";
import { KgBootstrapService } from "../../src/application/services/kg/KgBootstrapService";
import { KgReviewService } from "../../src/application/services/kg/KgReviewService";
import type { KgProjectService } from "../../src/application/services/kg/KgProjectService";
import type { KgSyncService } from "../../src/application/services/kg/KgSyncService";
import type { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import {
  claimCreateSlot,
  createTaskWithSlot,
  normalizeCreateTaskError,
  releaseCreateSlot,
} from "../../src/application/services/kg/job-activity";

/**
 * create 共享骨架（code-review M7④）单测：
 * normalizeCreateTaskError 错误归一词表 + createTaskWithSlot「互斥槽 claim →
 * createTask → 错误归一 → finally release」+ 三服务（KgBootstrapService /
 * KgReviewService / CodeReviewService）错误归一同构（同一引擎抛错 → 同一
 * 归一形态；码域差仅在槽占用/准入错误——各服务自持）。
 */

const ROOT = "/tmp/unit-create-slot/alpha";

describe("normalizeCreateTaskError 错误归一（M7④ 收口，含 M7 错误透传裁决）", () => {
  test("validation_failed / type_unknown 原码透传", () => {
    expect(normalizeCreateTaskError(Object.assign(new Error("参数坏"), { code: "task.validation_failed" }))).toEqual({
      code: "task.validation_failed",
      message: "参数坏",
    });
    expect(normalizeCreateTaskError(Object.assign(new Error("类型未知"), { code: "task.type_unknown" }))).toEqual({
      code: "task.type_unknown",
      message: "类型未知",
    });
  });

  test("其余 string code 透传原码（不再伪装 validation_failed）；无 code → task.internal", () => {
    expect(normalizeCreateTaskError(Object.assign(new Error("数据库锁"), { code: "task.store_busy" })).code).toBe("task.store_busy");
    expect(normalizeCreateTaskError(new Error("裸异常"))).toEqual({ code: "task.internal", message: "裸异常" });
    expect(normalizeCreateTaskError("字符串异常")).toEqual({ code: "task.internal", message: "字符串异常" });
    expect(normalizeCreateTaskError(Object.assign(new Error("空码"), { code: "" })).code).toBe("task.internal");
  });
});

describe("createTaskWithSlot 共享骨架（M7④）", () => {
  test("成功路径：返回 jobId 且 finally 释放互斥槽（可再 claim）", async () => {
    const result = await createTaskWithSlot({
      taskType: "kg-bootstrap",
      projectName: "alpha",
      slotBusyError: () => ({ code: "busy", message: "忙" }),
      createTask: () => Promise.resolve({ jobId: "job-1" }),
    });
    expect(result).toEqual({ ok: true, jobId: "job-1" });
    expect(claimCreateSlot("kg-bootstrap", "alpha")).toBe(true); // 已释放
    releaseCreateSlot("kg-bootstrap", "alpha");
  });

  test("槽占用：返回各服务自持的 busy 错误且不调 createTask", async () => {
    expect(claimCreateSlot("kg-review", "beta")).toBe(true);
    let called = 0;
    const result = await createTaskWithSlot({
      taskType: "kg-review",
      projectName: "beta",
      slotBusyError: () => ({ code: "kg.review.not_eligible", message: "task_running" }),
      createTask: () => {
        called += 1;
        return Promise.resolve({ jobId: "x" });
      },
    });
    expect(result).toEqual({ ok: false, error: { code: "kg.review.not_eligible", message: "task_running" } });
    expect(called).toBe(0);
    releaseCreateSlot("kg-review", "beta");
  });

  test("createTask 抛错：归一返回且槽仍释放", async () => {
    const result = await createTaskWithSlot({
      taskType: "code-review",
      projectName: "gamma",
      slotBusyError: () => ({ code: "busy", message: "忙" }),
      createTask: () => Promise.reject(Object.assign(new Error("校验失败"), { code: "task.validation_failed" })),
    });
    expect(result).toEqual({ ok: false, error: { code: "task.validation_failed", message: "校验失败" } });
    expect(claimCreateSlot("code-review", "gamma")).toBe(true);
    releaseCreateSlot("code-review", "gamma");
  });
});

// ── 三服务错误归一同构（stub 引擎同一抛错 → 同一归一形态） ──

const projectStub = {
  resolve: (p: string) => (p === "alpha" ? ROOT : undefined),
  hasIndex: () => true,
} as unknown as KgProjectService;

const storeStub = { listJobs: () => [] } as unknown as TaskStorePort;

function engineThrowing(err: unknown): TaskEnginePort {
  return {
    createTask: () => Promise.reject(err),
  } as unknown as TaskEnginePort;
}

function makeThree(err: unknown) {
  const bootstrap = new KgBootstrapService({
    project: projectStub,
    graph: { countActiveLayeredNodes: () => 0 } as unknown as KnowledgeGraphPort,
    write: {} as unknown as KgWriteService,
    sync: {
      isBuilding: () => false,
      getStatus: () => ({ phase: "synced", baseline: "1", symbolCount: 1, degraded: false, syncedAt: null }),
    } as unknown as Pick<KgSyncService, "getStatus" | "isBuilding">,
    taskEngine: engineThrowing(err),
    store: storeStub,
    skills: {} as unknown as TaskSkillRegistryPort,
  });
  const review = new KgReviewService({ project: projectStub, taskEngine: engineThrowing(err), store: storeStub });
  const codeReview = new CodeReviewService({ project: projectStub, taskEngine: engineThrowing(err), store: storeStub });
  return { bootstrap, review, codeReview };
}

describe("三服务 create 错误归一同构（M7④ 验收）", () => {
  test("同一引擎抛错 → 三服务归一形态逐字相同", async () => {
    for (const err of [
      Object.assign(new Error("校验失败"), { code: "task.validation_failed" }),
      Object.assign(new Error("类型未知"), { code: "task.type_unknown" }),
      Object.assign(new Error("存储忙"), { code: "task.store_busy" }),
      new Error("裸内部错误"),
    ]) {
      const { bootstrap, review, codeReview } = makeThree(err);
      const [b, r, c] = await Promise.all([bootstrap.create("alpha"), review.create("alpha"), codeReview.create("alpha")]);
      expect(b.ok).toBe(false);
      expect(r.ok).toBe(false);
      expect(c.ok).toBe(false);
      if (!b.ok && !r.ok && !c.ok) {
        const shape = (e: { code: string; message: string; path?: string }) => `${e.code}｜${e.message}｜${e.path ?? ""}`;
        expect(shape(b.error)).toBe(shape(r.error));
        expect(shape(r.error)).toBe(shape(c.error));
      }
    }
  });

  test("码域差仅在槽占用/准入错误（各服务自持）：互斥槽占用 → 各自码域", async () => {
    const { bootstrap, review, codeReview } = makeThree(new Error("不应到达"));
    expect(claimCreateSlot("kg-bootstrap", "alpha")).toBe(true);
    expect(claimCreateSlot("kg-review", "alpha")).toBe(true);
    expect(claimCreateSlot("code-review", "alpha")).toBe(true);
    try {
      const [b, r, c] = await Promise.all([bootstrap.create("alpha"), review.create("alpha"), codeReview.create("alpha")]);
      expect(!b.ok && b.error.code).toBe("kg.bootstrap.not_eligible");
      expect(!r.ok && r.error.code).toBe("kg.review.not_eligible");
      expect(!c.ok && c.error.code).toBe("task.task_running");
    } finally {
      releaseCreateSlot("kg-bootstrap", "alpha");
      releaseCreateSlot("kg-review", "alpha");
      releaseCreateSlot("code-review", "alpha");
    }
  });
});
