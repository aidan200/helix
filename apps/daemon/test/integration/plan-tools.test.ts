import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core/node";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { parentWorkLedger } from "../../src/adapters/driven/sqlite-session/WorkLedger";
import { LazyWorkLedger } from "../../src/adapters/driven/sqlite-session/WorkLedger";
import { WorkLedgerService } from "../../src/application/services/task/WorkLedgerService";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";

/**
 * I 层：plan 工具族（T1.4，CL-2 F2.5，AD-6①⑤）——真 SQLite @ tmp。
 *
 * 装配镜像 ChildMain 本地栈（LazyWorkLedger + WorkLedgerService + 
 * CoreToolExecutor plan 注入面 + resolveTools 按名装配），父进程读口 =
 * parentWorkLedger（WriteQueue 连接）上的 WorkLedgerService——同一读口
 * 两面（AD-6③）。
 *
 * 覆盖（test-design CL-2-T7/T8）：
 * ① plan_create → work_item 落 n 行 pending（seq 1..n）；重复 create → error；
 * ② plan_update 状态机 pending→in_progress→done/abandoned；abandoned 空
 *    note → error；非法 seq → error；终态无出边；
 * ③ plan_read 只回本实例行（实例作用域隔离）；
 * ⑤ isFullyResolved 机械判定（12 项 11 done 1 in_progress → false 等）；
 * ⑥ 跨进程：子连接（直连 LazyWorkLedger）写 work_item 时父连接 getPlan
 *    并行读不阻塞（WAL）。
 */

interface PlanFixture {
  readonly dir: string;
  readonly dbPath: string;
  readonly queue: WriteQueue;
  /** 父进程读口（AD-6③：chat MainAgent 与编排器共用同一读面）。 */
  readonly parent: WorkLedgerService;
  /** 子进程本地栈装配（镜像 ChildMain.buildLocalWorkLedgerStack）。 */
  readonly ledger: LazyWorkLedger;
  readonly service: WorkLedgerService;
  readonly planCreate: AgentHarnessTool<ExecutionToolContext, any, any>;
  readonly planUpdate: AgentHarnessTool<ExecutionToolContext, any, any>;
  readonly planRead: AgentHarnessTool<ExecutionToolContext, any, any>;
  readonly env: NodeExecutionEnv;
}

const fixtures: PlanFixture[] = [];

afterAll(async () => {
  for (const f of fixtures) {
    f.ledger.close();
    await f.queue.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
  fixtures.length = 0;
});

/** 父连接建库（表域先行——生产时序：父进程写 batch.instance_id 后才拉子进程）。 */
function makeFixture(instanceId: string): PlanFixture {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-plan-tools-"));
  const dbPath = path.join(dir, "helix.db");
  const queue = new WriteQueue(dbPath);
  const parent = new WorkLedgerService({ reader: parentWorkLedger(queue) });
  // 子面（镜像 ChildMain 装配：LazyWorkLedger + 双面 service）
  const ledger = new LazyWorkLedger(dbPath);
  const service = new WorkLedgerService({ reader: ledger, writer: ledger });
  const executor = new CoreToolExecutor({
    cwd: dir,
    plan: { service, instanceId },
  });
  const [planCreate, planUpdate, planRead] = executor.resolveTools([
    "plan_create",
    "plan_update",
    "plan_read",
  ]) as unknown as AgentHarnessTool<ExecutionToolContext, any, any>[];
  const f: PlanFixture = {
    dir,
    dbPath,
    queue,
    parent,
    ledger,
    service,
    planCreate: planCreate!,
    planUpdate: planUpdate!,
    planRead: planRead!,
    env: new NodeExecutionEnv({ cwd: dir }),
  };
  fixtures.push(f);
  return f;
}

type RunResult = { ok: true; text: string } | { ok: false; error: string };

async function run(
  tool: AgentHarnessTool<ExecutionToolContext, any, any>,
  args: unknown,
  env: NodeExecutionEnv,
): Promise<RunResult> {
  try {
    const result = await tool.execute("tc-plan", args as never, undefined, undefined, { env });
    return {
      ok: true,
      text: (result.content as any[]).map((b) => (b.type === "text" ? b.text : `(${b.type})`)).join("\n"),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

describe("① plan_create（CL-2-T7：建台账 + 拒重复）", () => {
  test("n 项落库：seq 1..n、全 pending、note 空；父进程 getPlan 读到一致内容", async () => {
    const f = makeFixture("agent-p1");
    const r = await run(f.planCreate, { items: ["调研现状", "实现方案", "回归验证"] }, f.env);
    if (!r.ok) throw new Error(`plan_create 失败：${r.error}`);
    expect(r.text).toContain("3");

    // 子进程读口（plan_read）与父进程读口（getPlan）内容一致
    const rows = f.parent.getPlan("agent-p1");
    expect(rows.map((x) => [x.seq, x.content, x.status, x.note])).toEqual([
      [1, "调研现状", "pending", null],
      [2, "实现方案", "pending", null],
      [3, "回归验证", "pending", null],
    ]);
    // 真库断言：work_item 表行数 + updatedAt 非空
    const raw = f.queue.database
      .prepare("SELECT COUNT(*) AS n, MAX(updated_at IS NOT NULL AND updated_at != '') AS ts FROM work_item WHERE instance_id = ?")
      .get("agent-p1") as { n: number; ts: number };
    expect(raw.n).toBe(3);
    expect(raw.ts).toBe(1);
  });

  test("同实例重复 create → error（非静默）；他实例不受影响", async () => {
    const f = makeFixture("agent-p2");
    expect((await run(f.planCreate, { items: ["唯一一次"] }, f.env)).ok).toBe(true);
    const dup = await run(f.planCreate, { items: ["再来一次"] }, f.env);
    expect(dup.ok).toBe(false);
    expect(dup.ok === false && /已有|重复|仅一次/.test(dup.error)).toBe(true);
    // 落库仍是首份（1 行）
    expect(f.parent.getPlan("agent-p2")).toHaveLength(1);
  });

  test("空 items / 空白条目 → error", async () => {
    const f = makeFixture("agent-p3");
    const empty = await run(f.planCreate, { items: [] }, f.env);
    expect(empty.ok).toBe(false);
    const blank = await run(f.planCreate, { items: ["正常项", "   "] }, f.env);
    expect(blank.ok).toBe(false);
    expect(f.parent.getPlan("agent-p3")).toHaveLength(0); // 零部分落库
  });
});

describe("② plan_update 状态机（CL-2-T7：pending→in_progress→done/abandoned）", () => {
  async function seeded(instanceId: string, n = 3): Promise<PlanFixture> {
    const f = makeFixture(instanceId);
    expect((await run(f.planCreate, { items: Array.from({ length: n }, (_, i) => `项${i + 1}`) }, f.env)).ok).toBe(true);
    return f;
  }

  test("全链：#1 pending→in_progress→done（带 note）；#2 →abandoned（带理由）", async () => {
    const f = await seeded("agent-u1");
    expect((await run(f.planUpdate, { seq: 1, status: "in_progress" }, f.env)).ok).toBe(true);
    expect((await run(f.planUpdate, { seq: 1, status: "done", note: "产物：src/a.ts" }, f.env)).ok).toBe(true);
    expect((await run(f.planUpdate, { seq: 2, status: "in_progress" }, f.env)).ok).toBe(true);
    const abandon = await run(f.planUpdate, { seq: 2, status: "abandoned", note: "范围外：依赖服务未就绪" }, f.env);
    expect(abandon.ok).toBe(true);

    const rows = f.parent.getPlan("agent-u1");
    expect(rows[0]).toMatchObject({ seq: 1, status: "done", note: "产物：src/a.ts" });
    expect(rows[1]).toMatchObject({ seq: 2, status: "abandoned", note: "范围外：依赖服务未就绪" });
    expect(rows[2]).toMatchObject({ seq: 3, status: "pending" });
  });

  test("abandoned 空 note → error（非静默，行不动）", async () => {
    const f = await seeded("agent-u2");
    await run(f.planUpdate, { seq: 1, status: "in_progress" }, f.env);
    const noNote = await run(f.planUpdate, { seq: 1, status: "abandoned" }, f.env);
    expect(noNote.ok).toBe(false);
    expect(noNote.ok === false && /note|理由/.test(noNote.error)).toBe(true);
    const blank = await run(f.planUpdate, { seq: 1, status: "abandoned", note: "   " }, f.env);
    expect(blank.ok).toBe(false);
    expect(f.parent.getPlan("agent-u2")[0]).toMatchObject({ status: "in_progress", note: null });
  });

  test("非法 seq → error（现有范围外）", async () => {
    const f = await seeded("agent-u3", 2);
    const r = await run(f.planUpdate, { seq: 9, status: "in_progress" }, f.env);
    expect(r.ok).toBe(false);
    expect(r.ok === false && /#9|序号/.test(r.error)).toBe(true);
  });

  test("非法迁移 → error：pending→done 跳步、done 终态无出边", async () => {
    const f = await seeded("agent-u4");
    const skip = await run(f.planUpdate, { seq: 1, status: "done" }, f.env);
    expect(skip.ok).toBe(false);
    expect(skip.ok === false && skip.error).toContain("pending→done");
    // 终态封锁：done 后不可再动
    await run(f.planUpdate, { seq: 1, status: "in_progress" }, f.env);
    await run(f.planUpdate, { seq: 1, status: "done" }, f.env);
    const revive = await run(f.planUpdate, { seq: 1, status: "in_progress" }, f.env);
    expect(revive.ok).toBe(false);
    expect(f.parent.getPlan("agent-u4")[0]).toMatchObject({ status: "done" });
  });
});

describe("③ plan_read 实例作用域隔离（CL-2-T7）", () => {
  test("只回本实例全行；他实例行不可见", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-plan-scope-"));
    const dbPath = path.join(dir, "helix.db");
    const queue = new WriteQueue(dbPath);
    try {
      const parent = new WorkLedgerService({ reader: parentWorkLedger(queue) });
      const ledgerA = new LazyWorkLedger(dbPath);
      const ledgerB = new LazyWorkLedger(dbPath);
      const mk = (ledger: LazyWorkLedger, instanceId: string) => {
        const service = new WorkLedgerService({ reader: ledger, writer: ledger });
        const executor = new CoreToolExecutor({ cwd: dir, plan: { service, instanceId } });
        return executor.resolveTools(["plan_create", "plan_read"]) as unknown as AgentHarnessTool<
          ExecutionToolContext,
          any,
          any
        >[];
      };
      const env = new NodeExecutionEnv({ cwd: dir });
      const [createA, readA] = mk(ledgerA, "agent-scope-a");
      const [createB, readB] = mk(ledgerB, "agent-scope-b");
      await createA!.execute("t", { items: ["A1", "A2"] } as never, undefined, undefined, { env });
      await createB!.execute("t", { items: ["B1", "B2", "B3"] } as never, undefined, undefined, { env });

      const ra = await run(readA!, {}, env);
      const rb = await run(readB!, {}, env);
      expect(ra.ok && (ra.text.match(/#(\d+)/g) ?? []).length).toBe(2);
      expect(ra.ok && ra.text).toContain("A1");
      expect(ra.ok && ra.text).not.toContain("B1");
      expect(rb.ok && (rb.text.match(/#(\d+)/g) ?? []).length).toBe(3);
      expect(rb.ok && rb.text).toContain("B3");
      expect(rb.ok && rb.text).not.toContain("A1");

      // 父进程读口按实例隔离（派发方判进度不串台）
      expect(parent.getPlan("agent-scope-a").map((x) => x.content)).toEqual(["A1", "A2"]);
      expect(parent.getPlan("agent-scope-b")).toHaveLength(3);
      ledgerA.close();
      ledgerB.close();
    } finally {
      await queue.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("⑤ isFullyResolved closure 硬约束机械判定（CL-2-T8，AD-6⑤）", () => {
  test("12 项中 11 done 1 in_progress → resolved=false 且 unresolved 含该 seq", async () => {
    const f = makeFixture("agent-r1");
    await f.service.createPlan("agent-r1", Array.from({ length: 12 }, (_, i) => `项${i + 1}`));
    for (let seq = 1; seq <= 11; seq++) {
      await f.service.updateItem("agent-r1", seq, "in_progress");
      await f.service.updateItem("agent-r1", seq, "done", `note-${seq}`);
    }
    await f.service.updateItem("agent-r1", 12, "in_progress");

    // 父进程判定面（T2.2 消费；本任务只交付判定面）
    const verdict = f.parent.isFullyResolved("agent-r1");
    expect(verdict.resolved).toBe(false);
    expect(verdict.unresolved).toEqual([{ seq: 12, status: "in_progress" }]);
  });

  test("全 done → true；abandoned 带 note → true（含 done/abandoned 混合）", async () => {
    const f = makeFixture("agent-r2");
    await f.service.createPlan("agent-r2", ["a", "b", "c"]);
    await f.service.updateItem("agent-r2", 1, "in_progress");
    await f.service.updateItem("agent-r2", 1, "done");
    await f.service.updateItem("agent-r2", 2, "in_progress");
    await f.service.updateItem("agent-r2", 2, "abandoned", "重复覆盖 #1，不重做");
    await f.service.updateItem("agent-r2", 3, "in_progress");
    await f.service.updateItem("agent-r2", 3, "done");
    const verdict = f.parent.isFullyResolved("agent-r2");
    expect(verdict.resolved).toBe(true);
    expect(verdict.unresolved).toEqual([]);
  });

  test("abandoned 无 note（写面守卫外直写构造）→ resolved=false 且列出该 seq", async () => {
    const f = makeFixture("agent-r3");
    await f.service.createPlan("agent-r3", ["x", "y"]);
    await f.service.updateItem("agent-r3", 1, "in_progress");
    await f.service.updateItem("agent-r3", 1, "done");
    await f.service.updateItem("agent-r3", 2, "in_progress");
    // 机械判定独立于写面守卫：直写 port 构造「abandoned 空 note」脏行
    await f.service.updateItem("agent-r3", 2, "abandoned", "占位");
    f.queue.database
      .prepare("UPDATE work_item SET note = NULL WHERE instance_id = ? AND seq = 2")
      .run("agent-r3");
    const verdict = f.parent.isFullyResolved("agent-r3");
    expect(verdict.resolved).toBe(false);
    expect(verdict.unresolved).toEqual([{ seq: 2, status: "abandoned" }]);
  });

  test("空台账（无 plan 实例）→ resolved=true（轻量实例无台账约束，AD-6⑥ 按 brief 装配）", () => {
    const f = makeFixture("agent-r4");
    expect(f.parent.isFullyResolved("agent-r4")).toEqual({ resolved: true, unresolved: [] });
  });

  test("pending 项未决 → false 且逐项列出", async () => {
    const f = makeFixture("agent-r5");
    await f.service.createPlan("agent-r5", ["p1", "p2"]);
    const verdict = f.parent.isFullyResolved("agent-r5");
    expect(verdict.resolved).toBe(false);
    expect(verdict.unresolved).toEqual([
      { seq: 1, status: "pending" },
      { seq: 2, status: "pending" },
    ]);
  });
});

describe("⑥ 跨进程：子连接写 work_item 时父连接读不阻塞（WAL，与 T1.2 联用）", () => {
  test("子直连（LazyWorkLedger）批量落账 + 父 getPlan 并行读：零异常、终态一致", async () => {
    const f = makeFixture("agent-w1");
    // 父连接并发读循环与子连接整批落账并行（WAL：读事务不阻塞写提交）
    const childWrite = f.service.createPlan(
      "agent-w1",
      Array.from({ length: 50 }, (_, i) => `项${i + 1}`),
    );
    const parentReads = Promise.all(
      Array.from({ length: 20 }, () => Promise.resolve(f.parent.getPlan("agent-w1").length)),
    );
    await Promise.all([childWrite, parentReads]);
    // 终态一致：父读口见全部 50 行（读未抛 BUSY、行数收敛）
    expect(f.parent.getPlan("agent-w1")).toHaveLength(50);
    // 子连接转态 + 父读即见（跨连接 write-through 可见性）
    await f.service.updateItem("agent-w1", 50, "in_progress");
    expect(f.parent.getPlan("agent-w1")[49]).toMatchObject({ seq: 50, status: "in_progress" });
  });
});
