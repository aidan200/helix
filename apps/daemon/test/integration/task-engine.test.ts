import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { withTaskEnv } from "../helpers/task-fixtures";

/**
 * 任务引擎服务（TaskEngineService，architecture §4；testing/test-design.md 映射）：
 * - CL-1-T6/T4/T5：createTask 全路径（fixed 三阶段落行冻结）、非法 type/params
 *   拒绝不产行、双宿主同源；
 * - CL-3-T7 引擎面：pause（running→paused + 在跑批次照常终态化 + 派发闸）、
 *   cancel（stop + 批次收口 failed 不重试）；
 * - CL-3-T12 引擎面：deleteTask 终态门控 + 四表级联清零 + kg 面零调用；
 * - CL-2-T4 引擎面：恢复扫描（in-flight 批次 failed 收口 + done stage 不重跑 +
 *   starter 重开 + 幂等）；
 * - CL-2-T5 上浮面：failBatch 重试超限上浮 stage/job failed。
 *
 * 真 SQLite @ tmp + 内存 fake starter/skill registry（TR-TEST-4 隔离）。
 */

const STORE_PORT_SOURCE = fileURLToPath(
  new URL("../../src/application/ports/outbound/TaskStorePort.ts", import.meta.url),
);
const ENGINE_PORT_SOURCE = fileURLToPath(
  new URL("../../src/application/ports/inbound/TaskEnginePort.ts", import.meta.url),
);

describe("createTask 全路径（CL-1-T6）", () => {
  test("合法 kg-bootstrap manifest → job 行 pending + stage 三行 pending（冻结）+ 编排启动", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo", scope: "core" },
        createdBy: "page",
      });
      const job = env.store.getJob(jobId);
      expect(job).toBeDefined();
      expect(job).toMatchObject({
        type: "kg-bootstrap",
        status: "pending",
        createdBy: "page",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo", scope: "core" },
        error: null,
      });
      const stages = env.store.getStages(jobId);
      expect(stages.map((s) => [s.seq, s.name, s.status])).toEqual([
        [1, "L0 核心层", "pending"],
        [2, "L1 领域层", "pending"],
        [3, "L2 实体层", "pending"],
      ]);
      expect(stages.every((s) => s.artifact === null)).toBe(true);
      // §5.2：创建成功即装配编排会话（E→O）
      expect(env.starter.starts).toContain(jobId);
    });
  });

  test("stage 冻结机械断言：TaskStorePort/TaskEnginePort 无运行期增删 stage 方法（AD-9③）", async () => {
    const storePort = await readFile(STORE_PORT_SOURCE, "utf8");
    const enginePort = await readFile(ENGINE_PORT_SOURCE, "utf8");
    // 存储端口：stage 面只允许 insertStage（createTask 定格）/updateStageStatus/读
    expect(/deleteStage|removeStage|dropStage/i.test(storePort)).toBe(false);
    // 引擎端口：无任何 stage 行增删方法（阶段计划只在 createTask 内落）
    expect(/deleteStage|removeStage|insertStage/i.test(enginePort)).toBe(false);
  });
});

describe("createTask 校验拒绝（CL-1-T4/T5 集成面，AD-8）", () => {
  test("type 无对应 skill → task.type_unknown 且 job 表无新行", async () => {
    await withTaskEnv(async (env) => {
      const before = env.store.listJobs().length;
      await expect(
        env.engine.createTask({ type: "no-such-type", projects: ["demo"], params: {}, createdBy: "page" }),
      ).rejects.toMatchObject({ code: "task.type_unknown" });
      expect(env.store.listJobs()).toHaveLength(before);
    });
  });

  test("params 违例（缺 required）→ task.validation_failed 且 job 表无新行", async () => {
    await withTaskEnv(async (env) => {
      const before = env.store.listJobs().length;
      await expect(
        env.engine.createTask({ type: "kg-bootstrap", projects: ["demo"], params: {}, createdBy: "page" }),
      ).rejects.toMatchObject({ code: "task.validation_failed" });
      expect(env.store.listJobs()).toHaveLength(before);
    });
  });

  test("projects 基数违例（0 个 / 2 个，manifest 要求恰 1）→ task.validation_failed", async () => {
    await withTaskEnv(async (env) => {
      await expect(
        env.engine.createTask({ type: "kg-bootstrap", projects: [], params: { projectRoot: "/d" }, createdBy: "page" }),
      ).rejects.toMatchObject({ code: "task.validation_failed" });
      await expect(
        env.engine.createTask({
          type: "kg-bootstrap",
          projects: ["a", "b"],
          params: { projectRoot: "/d" },
          createdBy: "page",
        }),
      ).rejects.toMatchObject({ code: "task.validation_failed" });
      expect(env.store.listJobs()).toHaveLength(0);
    });
  });

  test("projects=[] 合法创建（0..n 类型，AD-8）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "zero-project-scan",
        projects: [],
        params: {},
        createdBy: "page",
      });
      expect(env.store.getJob(jobId)).toMatchObject({ type: "zero-project-scan", projects: [], status: "pending" });
      expect(env.store.getStages(jobId)).toHaveLength(1);
    });
  });
});

describe("双宿主同源（CL-1-T4）", () => {
  test("createdBy=page/chat 两入口产物同构（type/params/projects/stage 计划一致，仅宿主与 id 异）", async () => {
    await withTaskEnv(async (env) => {
      const input = {
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
      } as const;
      const fromPage = await env.engine.createTask({ ...input, createdBy: "page" });
      const fromChat = await env.engine.createTask({ ...input, createdBy: "chat" });
      const pageJob = env.store.getJob(fromPage.jobId)!;
      const chatJob = env.store.getJob(fromChat.jobId)!;
      expect(chatJob).toMatchObject({
        type: pageJob.type,
        params: pageJob.params,
        projects: pageJob.projects,
        status: pageJob.status,
      });
      expect(pageJob.createdBy).toBe("page");
      expect(chatJob.createdBy).toBe("chat");
      expect(env.store.getStages(fromChat.jobId).map((s) => s.name)).toEqual(
        env.store.getStages(fromPage.jobId).map((s) => s.name),
      );
    });
  });
});

describe("insertBatch 机械推进 stage（T4.2，AF-T4.1.5 裂口修复）", () => {
  test("stage 首个批次落行 → stage pending→running 机械推进（job pending→running 同构）；后续批次不重复推进", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      expect(env.store.getStages(jobId).map((s) => s.status)).toEqual(["pending", "pending", "pending"]);
      await env.engine.insertBatch({ jobId, stageSeq: 1, scope: "批次 1" });
      // 机械推进：首个批次落行即 stage running（不再依赖编排 LLM 调 advanceStage）
      expect(env.store.getStages(jobId).find((s) => s.seq === 1)!.status).toBe("running");
      // 同 stage 第二批次：stage 保持 running，不报错不重复迁移
      await env.engine.insertBatch({ jobId, stageSeq: 1, scope: "批次 2" });
      expect(env.store.getStages(jobId).find((s) => s.seq === 1)!.status).toBe("running");
      expect(env.store.getBatches(jobId, 1)).toHaveLength(2);
      // 其他 stage 不受影响
      expect(env.store.getStages(jobId).find((s) => s.seq === 2)!.status).toBe("pending");
    });
  });

  test("advanceStage 幂等兼容：机械推进后再调 advanceStage 为 no-op 成功（编排 LLM 冗余调用不炸）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      await env.engine.insertBatch({ jobId, stageSeq: 1, scope: "批次 1" }); // 机械推进 stage 1 → running
      await env.engine.advanceStage(jobId, 1); // 幂等 no-op（已是 running）
      expect(env.store.getStages(jobId).find((s) => s.seq === 1)!.status).toBe("running");
    });
  });
});

describe("insertBatch seq 原子化（同轮并发竞态回归）", () => {
  test("同阶段并发 insertBatch → seq 严格 1..n（seq 计算在单写线程内，不预算）", async () => {
    await withTaskEnv(async (env) => {
      const { jobId } = await env.engine.createTask({
        type: "kg-bootstrap",
        projects: ["demo"],
        params: { projectRoot: "/tmp/demo" },
        createdBy: "page",
      });
      // 同轮并发 5 个批次插入（编排 LLM 一轮多工具调用形态）：竞态下全读
      // 到 count=0 → seq 全 1（helix.db 实证裂口）；修复后单写线程内原子
      // count+1，严格 1..5。
      const n = 5;
      await Promise.all(
        Array.from({ length: n }, (_, i) => env.engine.insertBatch({ jobId, stageSeq: 1, scope: `批次 ${i + 1}` })),
      );
      const batches = env.store.getBatches(jobId, 1);
      expect(batches).toHaveLength(n);
      expect(batches.map((b) => b.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(batches.map((b) => b.id)).size).toBe(n);
    });
  });
});
