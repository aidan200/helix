import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import {
  openTaskLedgerDatabase,
} from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { TaskStore } from "../../src/adapters/driven/sqlite-session/TaskStore";
import {
  WorkLedger,
  parentWorkLedger,
} from "../../src/adapters/driven/sqlite-session/WorkLedger";
import type {
  BatchData,
  JobData,
  StageData,
  StageArtifact,
} from "../../src/application/ports/outbound/TaskStorePort";
import { DomainError } from "../../src/domain/DomainError";

/**
 * 任务四表存储面（O-1：helix.db 新表域；testing/test-design.md 映射）：
 * - CL-2-T1：四表建表/迁移幂等 + RowMapper roundtrip（projects 空数组合法）；
 * - 父进程写路径：TaskStore 各写方法落库可查证，updateJobStatus 非法迁移
 *   由 domain 守卫拒绝（与 T1.1 联用）；
 * - CL-2-T7 存储面：跨进程双连接（父/子）同库，WAL + busy_timeout 串行化
 *   ——子连接自设两 PRAGMA、父读不阻塞子写；
 * - CL-3-T12 存储面：deleteJobCascade 三表级联清零 + work_item 经
 *   instanceId 关联清理（F3.6 清孤儿台账）。
 *
 * 全程真 SQLite @ tmp（TR-TEST-4 隔离，不碰真实 ~/.helix）。
 */

function tmpHome(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-task-"));
  return { dir, dbPath: path.join(dir, "helix.db") };
}

function jobOf(id: string, over: Partial<JobData> = {}): JobData {
  return {
    id,
    type: "kg-bootstrap",
    params: { depth: 2, restart: false },
    projects: ["demo"],
    status: "pending",
    createdBy: "page",
    createdAt: "2026-08-29T10:00:00.000Z",
    updatedAt: "2026-08-29T10:00:00.000Z",
    error: null,
    ...over,
  };
}

function stageOf(
  jobId: string,
  seq: number,
  name: string,
  over: Partial<StageData> = {},
): StageData {
  return {
    jobId,
    seq,
    name,
    status: "pending",
    artifact: null,
    updatedAt: "2026-08-29T10:00:01.000Z",
    ...over,
  };
}

function batchOf(
  id: string,
  jobId: string,
  stageSeq: number,
  seq: number,
  over: Partial<BatchData> = {},
): BatchData {
  return {
    id,
    jobId,
    stageSeq,
    seq,
    scope: "批次范围：demo 项目 L0 探索",
    status: "pending",
    retryCount: 0,
    retryNote: null,
    instanceId: null,
    createdAt: "2026-08-29T10:00:02.000Z",
    updatedAt: "2026-08-29T10:00:02.000Z",
    ...over,
  };
}

function columnsOf(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

function pkOf(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[])
    .filter((c) => c.pk > 0)
    .map((c) => c.name);
}

function tableSql(db: Database, table: string): string {
  return (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as {
      sql: string;
    }
  ).sql;
}

// ── 1. 四表建表 + 迁移幂等（CL-2-T1） ─────────────────────────

describe("任务四表建表 + 迁移幂等（CL-2-T1）", () => {
  test("新库初始化 → 四表存在，列名/主键按 §3.2 权威 DDL；状态列无 CHECK", async () => {
    const { dir, dbPath } = tmpHome();
    try {
      const queue = new WriteQueue(dbPath);
      const probe = new Database(dbPath, { readonly: true });

      expect(columnsOf(probe, "job")).toEqual([
        "id",
        "type",
        "params",
        "projects",
        "status",
        "created_by",
        "created_at",
        "updated_at",
        "error",
      ]);
      expect(pkOf(probe, "job")).toEqual(["id"]);

      expect(columnsOf(probe, "stage")).toEqual([
        "job_id",
        "seq",
        "name",
        "status",
        "artifact",
        "updated_at",
      ]);
      expect(pkOf(probe, "stage")).toEqual(["job_id", "seq"]);

      expect(columnsOf(probe, "batch")).toEqual([
        "id",
        "job_id",
        "stage_seq",
        "seq",
        "scope",
        "status",
        "retry_count",
        "retry_note",
        "instance_id",
        "created_at",
        "updated_at",
      ]);
      expect(pkOf(probe, "batch")).toEqual(["id"]);

      expect(columnsOf(probe, "work_item")).toEqual([
        "instance_id",
        "seq",
        "content",
        "status",
        "note",
        "updated_at",
      ]);
      expect(pkOf(probe, "work_item")).toEqual(["instance_id", "seq"]);

      // 状态列不加 CHECK（TR-AD-3：行模型哑、domain 聪明——状态机收口在 domain）
      for (const table of ["job", "stage", "batch", "work_item"]) {
        expect(tableSql(probe, table).includes("CHECK")).toBe(false);
      }

      probe.close();
      await queue.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("老库（无任务表）additive 补建四表；同库二次装配不抛错、已有行保留", async () => {
    const { dir, dbPath } = tmpHome();
    try {
      // 模拟老库：仅含会话域一张表（任务四表不存在）
      const legacy = new Database(dbPath);
      legacy.exec(
        "CREATE TABLE session_state (session_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, " +
          "entries TEXT NOT NULL, turns TEXT NOT NULL, updated_at TEXT NOT NULL)",
      );
      legacy.exec(
        "INSERT INTO session_state VALUES ('s-old', '2024-01-01T00:00:00.000Z', '[]', '[]', '2024-01-01T00:00:00.000Z')",
      );
      legacy.close();

      // 首次装配：additive 补建 + 写入任务行
      const q1 = new WriteQueue(dbPath);
      const store1 = new TaskStore(q1);
      await store1.insertJob(jobOf("task-old"));
      await store1.insertStage(stageOf("task-old", 1, "L0 探索"));
      await q1.close();

      // 二次装配：不抛错 + 会话旧行与任务行均保留
      const q2 = new WriteQueue(dbPath);
      const store2 = new TaskStore(q2);
      expect(store2.getJob("task-old")?.type).toBe("kg-bootstrap");
      expect(store2.getStages("task-old").map((s) => s.name)).toEqual(["L0 探索"]);
      const probe = new Database(dbPath, { readonly: true });
      expect(
        (probe.prepare("SELECT session_id FROM session_state").get() as { session_id: string })
          .session_id,
      ).toBe("s-old");
      probe.close();
      await q2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 2. RowMapper roundtrip（CL-2-T1、AD-8） ──────────────────

describe("任务四表 RowMapper roundtrip", () => {
  test("旧 artifact JSON（含 nodeIds）兼容读：多余 key 被忽略，读回 { summary } 不炸", async () => {
    const { dir, dbPath } = tmpHome();
    try {
      const queue = new WriteQueue(dbPath);
      const store = new TaskStore(queue);
      await store.insertJob(jobOf("task-legacy"));
      await store.insertStage(stageOf("task-legacy", 1, "L0 探索"));
      // 旧形状直写（旁路连接模拟历史库行：{ nodeIds, summary }）
      const legacy = new Database(dbPath);
      legacy
        .prepare("UPDATE stage SET artifact = ? WHERE job_id = ? AND seq = ?")
        .run(JSON.stringify({ nodeIds: ["AD-1", "AD-2"], summary: "历史聚合" }), "task-legacy", 1);
      legacy.close();
      const stage = store.getStages("task-legacy")[0]!;
      expect(stage.artifact).toEqual({ summary: "历史聚合" });
      expect(stage.artifact).not.toHaveProperty("nodeIds");
      // D2 additive：旧行无 body → body 键缺席（undefined 语义，不炸）
      expect(stage.artifact).not.toHaveProperty("body");
      await queue.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("artifact body additive（D2）：含 body 形状直写兼容读 + updateStageStatus 聚合往返", async () => {
    const { dir, dbPath } = tmpHome();
    try {
      const queue = new WriteQueue(dbPath);
      const store = new TaskStore(queue);
      await store.insertJob(jobOf("task-body"));
      await store.insertStage(stageOf("task-body", 1, "L0 探索"));
      await store.insertStage(stageOf("task-body", 2, "L1 规则"));
      // 含 body 的 JSON 直写（旁路连接）：兼容读把 body 带出
      const direct = new Database(dbPath);
      direct
        .prepare("UPDATE stage SET artifact = ? WHERE job_id = ? AND seq = ?")
        .run(JSON.stringify({ summary: "审 3 模块", body: "## 发现\n\n- A\n- B" }), "task-body", 1);
      direct.close();
      const stageDirect = store.getStages("task-body")[0]!;
      expect(stageDirect.artifact).toEqual({ summary: "审 3 模块", body: "## 发现\n\n- A\n- B" });
      // 写路径：updateStageStatus 聚合 { summary, body } 落库往返逐字段相等
      await store.updateStageStatus("task-body", 2, "running");
      const artifact: StageArtifact = { summary: "两节点聚合", body: "### 明细\n正文" };
      await store.updateStageStatus("task-body", 2, "done", artifact);
      const stageAfter = store.getStages("task-body")[1]!;
      expect(stageAfter.status).toBe("done");
      expect(stageAfter.artifact).toEqual(artifact);
      // 未携带 body 的写 → 读回无 body 键（语义不变）
      await store.insertStage(stageOf("task-body", 3, "L2 实体"));
      await store.updateStageStatus("task-body", 3, "running");
      await store.updateStageStatus("task-body", 3, "done", { summary: "仅摘要" });
      const stageNoBody = store.getStages("task-body")[2]!;
      expect(stageNoBody.artifact).toEqual({ summary: "仅摘要" });
      expect(stageNoBody.artifact).not.toHaveProperty("body");
      await queue.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("job/stage/batch/work_item 各插一行读回逐字段相等；projects 空数组往返保 []", async () => {
    const { dir, dbPath } = tmpHome();
    try {
      const queue = new WriteQueue(dbPath);
      const store = new TaskStore(queue);
      const ledgerDb = openTaskLedgerDatabase(dbPath);
      const ledger = new WorkLedger(ledgerDb);

      // job：projects 空数组合法（AD-8：0..n 类型；空数组非 null 非报错）
      const job = jobOf("task-empty", { projects: [], params: {} });
      await store.insertJob(job);
      expect(store.getJob("task-empty")).toEqual(job);

      // stage：插入往返 + artifact 经 updateStageStatus 聚合落库往返
      const stage = stageOf("task-empty", 1, "L0 探索");
      await store.insertStage(stage);
      expect(store.getStages("task-empty")).toEqual([stage]);
      await store.updateStageStatus("task-empty", 1, "running");
      const artifact: StageArtifact = { summary: "两节点聚合" };
      await store.updateStageStatus("task-empty", 1, "done", artifact);
      const stageAfter = store.getStages("task-empty")[0]!;
      expect(stageAfter.status).toBe("done");
      expect(stageAfter.artifact).toEqual(artifact);

      // batch：插入往返 + updateBatch 整行替换往返（instance/retry 字段）
      const batch = batchOf("batch-1", "task-empty", 1, 1);
      await store.insertBatch(batch);
      expect(store.getBatches("task-empty", 1)).toEqual([batch]);
      const batchUpdated = {
        ...batch,
        status: "running" as const,
        retryCount: 1,
        retryNote: "实例超时，自动重试",
        instanceId: "agent-1",
      };
      await store.updateBatch(batchUpdated);
      const batchAfter = store.getBatches("task-empty", 1)[0]!;
      expect(batchAfter).toMatchObject({
        id: "batch-1",
        status: "running",
        retryCount: 1,
        retryNote: "实例超时，自动重试",
        instanceId: "agent-1",
      });
      expect(typeof batchAfter.updatedAt).toBe("string");

      // work_item：insertItems（入口 pending/note null）+ updateItem 状态/note 往返
      await ledger.insertItems("agent-1", [
        { seq: 1, content: "探索 A 目录结构" },
        { seq: 2, content: "探索 B 入口文件" },
      ]);
      expect(ledger.getItems("agent-1")).toEqual([
        {
          instanceId: "agent-1",
          seq: 1,
          content: "探索 A 目录结构",
          status: "pending",
          note: null,
          updatedAt: expect.any(String),
        },
        {
          instanceId: "agent-1",
          seq: 2,
          content: "探索 B 入口文件",
          status: "pending",
          note: null,
          updatedAt: expect.any(String),
        },
      ]);
      await ledger.updateItem("agent-1", 1, "in_progress");
      await ledger.updateItem("agent-1", 2, "done", "产物：docs/architecture.md");
      const items = ledger.getItems("agent-1");
      expect(items[0]).toMatchObject({ status: "in_progress", note: null });
      expect(items[1]).toMatchObject({ status: "done", note: "产物：docs/architecture.md" });

      ledgerDb.close();
      await queue.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 3. 父进程写路径 + domain 守卫（与 T1.1 联用） ──────────────

describe("父进程写路径：TaskStore 写方法落库可查证 + 状态守卫", () => {
  test("updateJobStatus 非法迁移被 domain 守卫拒绝；合法迁移链落库；listJobs 过滤", async () => {
    const { dir, dbPath } = tmpHome();
    try {
      const queue = new WriteQueue(dbPath);
      const store = new TaskStore(queue);

      await store.insertJob(jobOf("task-g3"));
      await store.insertJob(jobOf("task-g3b"));

      // 非法迁移（pending → done 终态跳迁）：DomainError，库内 status 未被污染
      let threw: unknown;
      try {
        await store.updateJobStatus("task-g3", "done");
      } catch (error) {
        threw = error;
      }
      expect(threw).toBeInstanceOf(DomainError);
      expect((threw as Error).message).toContain("pending→done");
      expect(store.getJob("task-g3")?.status).toBe("pending");

      // 合法迁移链：pending → running → paused → running → failed(error 落列)
      await store.updateJobStatus("task-g3", "running");
      await store.updateJobStatus("task-g3", "paused");
      await store.updateJobStatus("task-g3", "running");
      await store.updateJobStatus("task-g3", "failed", "重试耗尽");
      expect(store.getJob("task-g3")).toMatchObject({ status: "failed", error: "重试耗尽" });

      // 不存在的 job：守卫前置失败（不静默 no-op）
      let threwMissing: unknown;
      try {
        await store.updateJobStatus("task-none", "running");
      } catch (error) {
        threwMissing = error;
      }
      expect(threwMissing).toBeInstanceOf(DomainError);

      // listJobs：全量 + 状态过滤（created_at 倒序）
      expect(store.listJobs().map((j) => j.id).sort()).toEqual(["task-g3", "task-g3b"]);
      expect(store.listJobs({ status: "failed" }).map((j) => j.id)).toEqual(["task-g3"]);
      expect(store.listJobs({ status: "pending" }).map((j) => j.id)).toEqual(["task-g3b"]);

      await queue.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("updateStageStatus 非法迁移同样被守卫拒绝（pending → done）", async () => {
    const { dir, dbPath } = tmpHome();
    try {
      const queue = new WriteQueue(dbPath);
      const store = new TaskStore(queue);
      await store.insertJob(jobOf("task-st"));
      await store.insertStage(stageOf("task-st", 1, "L0"));

      let threw: unknown;
      try {
        await store.updateStageStatus("task-st", 1, "done");
      } catch (error) {
        threw = error;
      }
      expect(threw).toBeInstanceOf(DomainError);
      expect((threw as Error).message).toContain("pending→done");
      expect(store.getStages("task-st")[0]!.status).toBe("pending");

      await queue.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 4. 跨进程语义：双连接 WAL + busy_timeout（CL-2-T7 存储面） ──

describe("跨进程双连接（父/子）同库：WAL + busy_timeout 串行化", () => {
  test("子直连连接自设 WAL + busy_timeout；父读见子写；子持读事务时父清理写不阻塞", async () => {
    const { dir, dbPath } = tmpHome();
    try {
      // 父：WriteQueue 建库（会话域 + 任务表域）；父装配面 = 只读 + F3.6 清理
      const queue = new WriteQueue(dbPath);
      const parent = parentWorkLedger(queue);
      // 子：直连（T1.4 plan 工具装配形态）
      const childDb = openTaskLedgerDatabase(dbPath);
      const child = new WorkLedger(childDb);

      // 直连连接建立处两 PRAGMA 齐全（busy_timeout 连接级——不能依赖父进程设置；
      // SQLite 结果列名为 timeout）
      expect(
        (childDb.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
      ).toBe(10000);
      expect(
        (childDb.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
      ).toBe("wal");

      // 交错读写循环：子写 → 父读即见（WAL 读不阻塞写、写提交即可见）
      for (let i = 0; i < 10; i++) {
        await child.insertItems(`agent-${i}`, [{ seq: 1, content: `项-${i}` }]);
        expect(parent.getItems(`agent-${i}`).length).toBe(1);
      }

      // WAL 硬证明：子连接持读事务期间，父面清理写即时成功（回滚日志模式下
      // 此处会锁冲突 BUSY）
      await child.insertItems("agent-hold", [{ seq: 1, content: "持读事务行" }]);
      childDb.exec("BEGIN");
      childDb
        .prepare("SELECT COUNT(*) AS n FROM work_item WHERE instance_id = ?")
        .get("agent-hold");
      await parent.deleteByInstanceIds(["agent-hold"]);
      childDb.exec("COMMIT");
      expect(parent.getItems("agent-hold")).toEqual([]);

      // 空集 no-op（不构造非法 IN ()）
      await parent.deleteByInstanceIds([]);

      childDb.close();
      await queue.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 5. deleteJobCascade：级联清零（CL-3-T12 存储面，F3.6） ────

describe("deleteJobCascade 级联删除 + work_item 关联清理", () => {
  test("级联后四表相关行清零、他任务行不动；返回各表删除计数", async () => {
    const { dir, dbPath } = tmpHome();
    try {
      const queue = new WriteQueue(dbPath);
      const store = new TaskStore(queue);
      const ledgerDb = openTaskLedgerDatabase(dbPath);
      const ledger = new WorkLedger(ledgerDb);
      const parent = parentWorkLedger(queue);

      // 任务 A：1 job + 2 stages + 3 batches（2 实例已派发）；任务 B：1/1/1
      await store.insertJob(jobOf("task-a"));
      await store.insertStage(stageOf("task-a", 1, "L0 探索"));
      await store.insertStage(stageOf("task-a", 2, "L1 落盘"));
      await store.insertBatch(batchOf("batch-a1", "task-a", 1, 1, { instanceId: "agent-a1" }));
      await store.insertBatch(batchOf("batch-a2", "task-a", 1, 2, { instanceId: "agent-a2" }));
      await store.insertBatch(batchOf("batch-a3", "task-a", 2, 1));
      await store.insertJob(jobOf("task-b"));
      await store.insertStage(stageOf("task-b", 1, "L0 探索"));
      await store.insertBatch(batchOf("batch-b1", "task-b", 1, 1, { instanceId: "agent-b1" }));
      for (const inst of ["agent-a1", "agent-a2", "agent-b1"]) {
        await ledger.insertItems(inst, [
          { seq: 1, content: "步骤一" },
          { seq: 2, content: "步骤二" },
        ]);
      }

      // 引擎语义（T1.3 落地）：删除前收集任务 A 全部批次 instanceId →
      // 三表级联删 + work_item 清孤儿台账
      const instances = store
        .getStages("task-a")
        .flatMap((s) => store.getBatches("task-a", s.seq))
        .map((b) => b.instanceId)
        .filter((id): id is string => id !== null);
      expect(instances.sort()).toEqual(["agent-a1", "agent-a2"]);

      const counts = await store.deleteJobCascade("task-a", "task:task-a");
      expect(counts).toEqual({
        jobs: 1,
        stages: 2,
        batches: 3,
        events: 0,
        lifecycleRows: 0,
        closures: 0,
        steerRows: 0,
        toolCallRows: 0,
        pendingSyncs: 0,
      });
      await parent.deleteByInstanceIds(instances);

      // 任务 A 四表清零
      expect(store.getJob("task-a")).toBeUndefined();
      expect(store.getStages("task-a")).toEqual([]);
      expect(store.getBatches("task-a", 1)).toEqual([]);
      expect(parent.getItems("agent-a1")).toEqual([]);
      expect(parent.getItems("agent-a2")).toEqual([]);

      // 他任务行不动
      expect(store.getJob("task-b")?.id).toBe("task-b");
      expect(store.getStages("task-b").length).toBe(1);
      expect(store.getBatches("task-b", 1).length).toBe(1);
      expect(parent.getItems("agent-b1").length).toBe(2);

      ledgerDb.close();
      await queue.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
