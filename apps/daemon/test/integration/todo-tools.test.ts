import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentHarnessTool, ExecutionToolContext } from "../../src/adapters/driven/tools/vendor/pi-harness";
import { NodeExecutionEnv } from "../../src/adapters/driven/tools/vendor/pi-harness";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { parentWorkLedger } from "../../src/adapters/driven/sqlite-session/WorkLedger";
import { LazyWorkLedger } from "../../src/adapters/driven/sqlite-session/WorkLedger";
import { WorkLedgerService } from "../../src/application/services/task/WorkLedgerService";
import { CoreToolExecutor } from "../../src/adapters/driven/tools/CoreToolExecutor";
import { BACKGROUND_CONTEXT } from "../../src/adapters/driven/tools/vendor/pi-harness";

/**
 * I 层：todo 工具族（plan 三工具改名批，C+B）——真 SQLite @ tmp。
 *
 * 装配镜像 ChildMain 本地栈（LazyWorkLedger + WorkLedgerService +
 * CoreToolExecutor plan 注入面 + resolveTools 按名装配），父进程读口 =
 * parentWorkLedger（WriteQueue 连接）上的 WorkLedgerService——同一读口
 * 两面。
 *
 * 覆盖：
 * ① todo_write → work_item 落 n 行（status 随入参；seq 由位置 1..n）；
 *    空 todos / 空白 content / abandoned 无 note → error；
 * ② 全量替换语义：二次写入整表替换（含 pending→done 直达——旧逐项状态机
 *    的 787 次/历史 拒绝面归零）；replace 后行数/序号收敛；
 * ③ todo_read 只回本实例行（实例作用域隔离）；
 * ⑤ isFullyResolved 机械判定（writeTodos 直构状态面）；
 * ⑥ 跨进程：子连接写 work_item 时父连接 getPlan 并行读不阻塞（WAL）；
 * ⑦ forceResolveInProgress 收口兑底（仅 in_progress；pending 不兜）。
 */

interface TodoFixture {
  readonly dir: string;
  readonly dbPath: string;
  readonly queue: WriteQueue;
  /** 父进程读口（chat MainAgent 与编排器共用同一读面）。 */
  readonly parent: WorkLedgerService;
  /** 子进程本地栈装配（镜像 ChildMain.buildLocalWorkLedgerStack）。 */
  readonly ledger: LazyWorkLedger;
  readonly service: WorkLedgerService;
  readonly todoWrite: AgentHarnessTool<ExecutionToolContext, any, any>;
  readonly todoRead: AgentHarnessTool<ExecutionToolContext, any, any>;
  readonly env: NodeExecutionEnv;
}

const fixtures: TodoFixture[] = [];

afterAll(async () => {
  for (const f of fixtures) {
    f.ledger.close();
    await f.queue.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
  fixtures.length = 0;
});

/** 父连接建库（表域先行——生产时序：父进程写 batch.instance_id 后才拉子进程）。 */
function makeFixture(instanceId: string): TodoFixture {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-todo-tools-"));
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
  const [todoWrite, todoRead] = executor.resolveTools([
    "todo_write",
    "todo_read",
  ]) as unknown as AgentHarnessTool<ExecutionToolContext, any, any>[];
  const f: TodoFixture = {
    dir,
    dbPath,
    queue,
    parent,
    ledger,
    service,
    todoWrite: todoWrite!,
    todoRead: todoRead!,
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
    const result = await tool.execute("tc-todo", args as never, undefined as never, { env }, undefined as never, BACKGROUND_CONTEXT);
    return {
      ok: true,
      text: (result.content as any[]).map((b) => (b.type === "text" ? b.text : `(${b.type})`)).join("\n"),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

describe("① todo_write（建清单 + 入参校验）", () => {
  test("n 项落库：seq 1..n（位置隐含）、status 随入参、note 落行；父进程 getPlan 读到一致内容", async () => {
    const f = makeFixture("agent-p1");
    const r = await run(
      f.todoWrite,
      {
        todos: [
          { content: "调研现状", status: "done", note: "产物：docs/x.md" },
          { content: "实现方案", status: "in_progress" },
          { content: "回归验证", status: "pending" },
        ],
      },
      f.env,
    );
    if (!r.ok) throw new Error(`todo_write 失败：${r.error}`);
    expect(r.text).toContain("3");

    // 子进程读口（todo_read）与父进程读口（getPlan）内容一致
    const rows = f.parent.getPlan("agent-p1");
    expect(rows.map((x) => [x.seq, x.content, x.status, x.note])).toEqual([
      [1, "调研现状", "done", "产物：docs/x.md"],
      [2, "实现方案", "in_progress", null],
      [3, "回归验证", "pending", null],
    ]);
    // 真库断言：work_item 表行数 + updatedAt 非空
    const raw = f.queue.database
      .prepare("SELECT COUNT(*) AS n, MAX(updated_at IS NOT NULL AND updated_at != '') AS ts FROM work_item WHERE instance_id = ?")
      .get("agent-p1") as { n: number; ts: number };
    expect(raw.n).toBe(3);
    expect(raw.ts).toBe(1);
  });

  test("空 todos / 空白 content / 非对象条目 → error（零部分落库）", async () => {
    const f = makeFixture("agent-p2");
    const empty = await run(f.todoWrite, { todos: [] }, f.env);
    expect(empty.ok).toBe(false);
    const blank = await run(f.todoWrite, { todos: [{ content: "   ", status: "pending" }] }, f.env);
    expect(blank.ok).toBe(false);
    const notObject = await run(f.todoWrite, { todos: ["纯字符串"] }, f.env);
    expect(notObject.ok).toBe(false);
    expect(f.parent.getPlan("agent-p2")).toHaveLength(0);
  });

  test("abandoned 无 note / 空白 note / 非法 status → error", async () => {
    const f = makeFixture("agent-p3");
    const noNote = await run(f.todoWrite, { todos: [{ content: "x", status: "abandoned" }] }, f.env);
    expect(noNote.ok).toBe(false);
    expect(noNote.ok === false && /note|理由/.test(noNote.error)).toBe(true);
    const blankNote = await run(f.todoWrite, { todos: [{ content: "x", status: "abandoned", note: "   " }] }, f.env);
    expect(blankNote.ok).toBe(false);
    const badStatus = await run(f.todoWrite, { todos: [{ content: "x", status: "completed" }] }, f.env);
    expect(badStatus.ok).toBe(false);
    expect(f.parent.getPlan("agent-p3")).toHaveLength(0);
  });
});

describe("② 全量替换语义（pending→done 直达；整表替换）", () => {
  test("二次写入整表替换：旧行清、seq 由新清单位置重排、行数收敛（可缩可扩）", async () => {
    const f = makeFixture("agent-u1");
    expect(
      (
        await run(
          f.todoWrite,
          { todos: [{ content: "项1", status: "pending" }, { content: "项2", status: "pending" }, { content: "项3", status: "pending" }] },
          f.env,
        )
      ).ok,
    ).toBe(true);
    // 全量替换：3 项缩 2 项，#1 直接 done（旧状态机 pending→done 两步强制退役）
    const r = await run(
      f.todoWrite,
      { todos: [{ content: "项1", status: "done", note: "产物：src/a.ts" }, { content: "项2（改）", status: "in_progress" }] },
      f.env,
    );
    expect(r.ok).toBe(true);
    const rows = f.parent.getPlan("agent-u1");
    expect(rows.map((x) => [x.seq, x.content, x.status, x.note])).toEqual([
      [1, "项1", "done", "产物：src/a.ts"],
      [2, "项2（改）", "in_progress", null],
    ]);
    const raw = f.queue.database
      .prepare("SELECT COUNT(*) AS n FROM work_item WHERE instance_id = ?")
      .get("agent-u1") as { n: number };
    expect(raw.n).toBe(2); // 零残留
  });

  test("abandoned 带理由直达；清单内混合状态一次成型", async () => {
    const f = makeFixture("agent-u2");
    const r = await run(
      f.todoWrite,
      {
        todos: [
          { content: "已完成项", status: "done" },
          { content: "放弃项", status: "abandoned", note: "范围外：依赖服务未就绪" },
          { content: "进行项", status: "in_progress" },
        ],
      },
      f.env,
    );
    expect(r.ok).toBe(true);
    const rows = f.parent.getPlan("agent-u2");
    expect(rows[0]).toMatchObject({ status: "done" });
    expect(rows[1]).toMatchObject({ status: "abandoned", note: "范围外：依赖服务未就绪" });
    expect(rows[2]).toMatchObject({ status: "in_progress" });
  });
});

describe("③ todo_read 实例作用域隔离", () => {
  test("只回本实例全行；他实例行不可见", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-todo-scope-"));
    const dbPath = path.join(dir, "helix.db");
    const queue = new WriteQueue(dbPath);
    try {
      const parent = new WorkLedgerService({ reader: parentWorkLedger(queue) });
      const ledgerA = new LazyWorkLedger(dbPath);
      const ledgerB = new LazyWorkLedger(dbPath);
      const mk = (ledger: LazyWorkLedger, instanceId: string) => {
        const service = new WorkLedgerService({ reader: ledger, writer: ledger });
        const executor = new CoreToolExecutor({ cwd: dir, plan: { service, instanceId } });
        return executor.resolveTools(["todo_write", "todo_read"]) as unknown as AgentHarnessTool<
          ExecutionToolContext,
          any,
          any
        >[];
      };
      const env = new NodeExecutionEnv({ cwd: dir });
      const [writeA, readA] = mk(ledgerA, "agent-scope-a");
      const [writeB, readB] = mk(ledgerB, "agent-scope-b");
      await writeA!.execute("t", { todos: [{ content: "A1", status: "pending" }, { content: "A2", status: "pending" }] } as never, undefined as never, { env }, undefined as never, BACKGROUND_CONTEXT);
      await writeB!.execute("t", { todos: [{ content: "B1", status: "pending" }, { content: "B2", status: "pending" }, { content: "B3", status: "pending" }] } as never, undefined as never, { env }, undefined as never, BACKGROUND_CONTEXT);

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

describe("⑤ isFullyResolved closure 硬约束机械判定", () => {
  test("12 项中 11 done 1 in_progress → resolved=false 且 unresolved 含该 seq", async () => {
    const f = makeFixture("agent-r1");
    await f.service.writeTodos(
      "agent-r1",
      Array.from({ length: 12 }, (_, i) => ({
        content: `项${i + 1}`,
        status: i < 11 ? ("done" as const) : ("in_progress" as const),
        ...(i < 11 ? { note: `note-${i + 1}` } : {}),
      })),
    );
    const verdict = f.parent.isFullyResolved("agent-r1");
    expect(verdict.resolved).toBe(false);
    expect(verdict.unresolved).toEqual([{ seq: 12, status: "in_progress" }]);
  });

  test("全 done → true；abandoned 带 note → true（含 done/abandoned 混合）", async () => {
    const f = makeFixture("agent-r2");
    await f.service.writeTodos("agent-r2", [
      { content: "a", status: "done" },
      { content: "b", status: "abandoned", note: "重复覆盖 #1，不重做" },
      { content: "c", status: "done" },
    ]);
    const verdict = f.parent.isFullyResolved("agent-r2");
    expect(verdict.resolved).toBe(true);
    expect(verdict.unresolved).toEqual([]);
  });

  test("abandoned 无 note（写面守卫外直写构造）→ resolved=false 且列出该 seq", async () => {
    const f = makeFixture("agent-r3");
    await f.service.writeTodos("agent-r3", [
      { content: "x", status: "done" },
      { content: "y", status: "abandoned", note: "占位" },
    ]);
    // 机械判定独立于写面守卫：直写构造「abandoned 空 note」脏行
    f.queue.database
      .prepare("UPDATE work_item SET note = NULL WHERE instance_id = ? AND seq = 2")
      .run("agent-r3");
    const verdict = f.parent.isFullyResolved("agent-r3");
    expect(verdict.resolved).toBe(false);
    expect(verdict.unresolved).toEqual([{ seq: 2, status: "abandoned" }]);
  });

  test("空清单（无 todo 实例）→ resolved=true（轻量实例无清单约束，按 brief 装配）", () => {
    const f = makeFixture("agent-r4");
    expect(f.parent.isFullyResolved("agent-r4")).toEqual({ resolved: true, unresolved: [] });
  });

  test("pending 项未决 → false 且逐项列出", async () => {
    const f = makeFixture("agent-r5");
    await f.service.writeTodos("agent-r5", [
      { content: "p1", status: "pending" },
      { content: "p2", status: "pending" },
    ]);
    const verdict = f.parent.isFullyResolved("agent-r5");
    expect(verdict.resolved).toBe(false);
    expect(verdict.unresolved).toEqual([
      { seq: 1, status: "pending" },
      { seq: 2, status: "pending" },
    ]);
  });
});

describe("⑥ 跨进程：子连接写 work_item 时父连接读不阻塞（WAL）", () => {
  test("子直连（LazyWorkLedger）批量落账 + 父 getPlan 并行读：零异常、终态一致", async () => {
    const f = makeFixture("agent-w1");
    const childWrite = f.service.writeTodos(
      "agent-w1",
      Array.from({ length: 50 }, (_, i) => ({ content: `项${i + 1}`, status: "pending" as const })),
    );
    const parentReads = Promise.all(
      Array.from({ length: 20 }, () => Promise.resolve(f.parent.getPlan("agent-w1").length)),
    );
    await Promise.all([childWrite, parentReads]);
    expect(f.parent.getPlan("agent-w1")).toHaveLength(50);
    // 子连接全量替换 + 父读即见（跨连接 write-through 可见性）
    await f.service.writeTodos(
      "agent-w1",
      Array.from({ length: 50 }, (_, i) => ({
        content: `项${i + 1}`,
        status: i === 49 ? ("in_progress" as const) : ("pending" as const),
      })),
    );
    expect(f.parent.getPlan("agent-w1")[49]).toMatchObject({ seq: 50, status: "in_progress" });
  });
});

// ── ⑦ closure done 收口前机械兑底（实例忘 todo_write 标记收口项 →
//    父进程判据② failBatch → 重试耗尽全损）──

describe("⑦ forceResolveInProgress：closure done 收口前机械兑底（仅 in_progress）", () => {
  test("in_progress→done 带机械 note；pending 不兜（真漏做照旧未决）；幂等无害", async () => {
    const f = makeFixture("agent-b1");
    await f.service.writeTodos("agent-b1", [
      { content: "开工项", status: "done" },
      { content: "收口项", status: "in_progress" }, // 忘标记的收口项（task-8659b320 #5 同型）
      { content: "从未开工项", status: "pending" }, // 留 pending
    ]);

    const out = await f.service.forceResolveInProgress("agent-b1", "closure done 机械兑底（实例未逐项标记）");
    expect(out).toEqual({ resolved: 1 }); // 只兜 in_progress 的 #2

    const plan = f.service.getPlan("agent-b1");
    expect(plan[1]).toMatchObject({ seq: 2, status: "done", note: "closure done 机械兑底（实例未逐项标记）" });
    expect(plan[2]).toMatchObject({ seq: 3, status: "pending", note: null }); // pending 不兜——防漏做判据保留

    // 父读口同见（跨连接可见性——父进程 settleInstance 判据②读取面）
    const verdict = f.parent.isFullyResolved("agent-b1");
    expect(verdict.resolved).toBe(false); // #3 pending 仍判未决（有意保守）
    expect(verdict.unresolved).toEqual([{ seq: 3, status: "pending" }]);
  });

  test("只读面（父进程构造）调用 → 写面未装配错误（表分域不破）", async () => {
    const f = makeFixture("agent-b2");
    await f.service.writeTodos("agent-b2", [{ content: "x", status: "in_progress" }]);
    expect(f.parent.forceResolveInProgress("agent-b2", "n").catch((e: Error) => e.message)).resolves.toContain(
      "写面未装配",
    );
  });
});
