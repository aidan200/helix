import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import type { KnowledgeWriteOp } from "../../src/domain/kg/types";

/**
 * I 层（真 SQLite tmp 库）：candidates 库内表 + proposeCandidate /
 * decideCandidate 写 op（D0 裁决 R1-R3，kg-driven-dev-loop-design.md）。
 *
 * 覆盖：
 * ① 表与发号——冷启动直建 candidates 表；CAND-<seq> 复用 meta 发号计数器
 *    只增不减；显式保号 id（迁移专用）+ 冲突拒绝 + 计数器推进；
 * ② schema 校验——title 必填 / kind 词表（sediment）/ decision 四值 /
 *    discarded 必带 reason，越界 KG_E_SCHEMA 零落库；
 * ③ 状态机——pending→applied/discarded/deferred；defer_age 逐次 +1；
 *    applied/discarded 终态再 decide → KG_E_STATE；不存在 → KG_E_ID；
 * ④ 审计——propose/decide 每 op 落 change_log（含 task_id 机械注入面）；
 * ⑤ defer 上限——年龄 ≥2 / 积压 >10 条只警告不拒绝（机械只列不修）。
 */

interface Fixture {
  readonly root: string;
  readonly database: KgDatabase;
  readonly store: SqliteKnowledgeStore;
  readonly write: KgWriteService;
  readonly graph: SqliteKnowledgeGraph;
}

const fixtures: Fixture[] = [];

afterAll(() => {
  for (const f of fixtures) {
    f.database.closeAll();
    rmSync(f.root, { recursive: true, force: true });
  }
  fixtures.length = 0;
});

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "kg-candidates-it-"));
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const write = new KgWriteService({ store });
  const fixture: Fixture = { root, database, store, write, graph };
  fixtures.push(fixture);
  return fixture;
}

interface CandidateRow {
  id: string;
  formal_id: string | null;
  kind: string;
  title: string;
  body: string;
  status: string;
  source_task_id: string | null;
  source_iteration_id: string | null;
  defer_age: number;
  created_at: string;
  decided_at: string | null;
  decision_reason: string | null;
  applied_node_id: string | null;
  /** 目标节点（修改/废弃候选的定位；新增候选恒 NULL——列级演进后可空）。 */
  target_node: string | null;
}

function probe<T>(root: string, sql: string, ...params: (string | number)[]): T[] {
  const db = new Database(kgDbPath(root), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function rows(root: string): CandidateRow[] {
  return probe<CandidateRow>(root, "SELECT * FROM candidates ORDER BY id");
}

function propose(title: string, extra: Record<string, unknown> = {}): KnowledgeWriteOp {
  return {
    kind: "proposeCandidate",
    iterationId: "iter-cand",
    candidateKind: "sediment",
    title,
    ...extra,
  } as unknown as KnowledgeWriteOp;
}

function decide(candidateId: string, decision: string, extra: Record<string, unknown> = {}): KnowledgeWriteOp {
  return {
    kind: "decideCandidate",
    iterationId: "iter-cand",
    candidateId,
    decision,
    ...extra,
  } as unknown as KnowledgeWriteOp;
}

describe("① 表与发号（CAND-<seq> 复用 meta 计数器）", () => {
  test("冷启动直建 candidates 表（status 四值 CHECK + status 索引）", () => {
    const f = makeFixture();
    f.database.knowledgeConnection(f.root);
    const tables = probe<{ name: string }>(
      f.root,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).map((r) => r.name);
    expect(tables).toContain("candidates");
    // 越界 status 被 CHECK 拒绝
    const db = new Database(kgDbPath(f.root));
    try {
      expect(() =>
        db.prepare(
          "INSERT INTO candidates (id, kind, title, status, created_at) VALUES ('CAND-x', 'sediment', 't', 'bogus', '2026-01-01')",
        ).run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("proposeCandidate 自动发号 CAND-1/CAND-2 递增；缺省 status=pending、defer_age=0", () => {
    const f = makeFixture();
    const r1 = f.write.write(f.root, propose("规则沉淀一"));
    const r2 = f.write.write(f.root, propose("规则沉淀二", { body: "正文" }));
    expect(r1.ok && r1.nodeId === "CAND-1").toBe(true);
    expect(r2.ok && r2.nodeId === "CAND-2").toBe(true);
    const all = rows(f.root);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      id: "CAND-1",
      kind: "sediment",
      title: "规则沉淀一",
      body: "",
      status: "pending",
      defer_age: 0,
      formal_id: null,
      decided_at: null,
      decision_reason: null,
      applied_node_id: null,
    });
    expect(all[1]!.body).toBe("正文");
  });

  test("sourceTaskId / sourceIterationId 溯源列落库（findings 闭环机械注入面）", () => {
    const f = makeFixture();
    const r = f.write.write(
      f.root,
      propose("带溯源", { sourceTaskId: "job-1", sourceIterationId: "iter-20260830-x" }),
    );
    expect(r1id(r)).toBe("CAND-1");
    expect(rows(f.root)[0]).toMatchObject({ source_task_id: "job-1", source_iteration_id: "iter-20260830-x" });
  });

  test("显式保号 id（迁移专用）：采用且计数器推进；重复 id → KG_E_ID；非法形态 → KG_E_SCHEMA", () => {
    const f = makeFixture();
    const kept = f.write.write(f.root, propose("迁移条目", { id: "CAND-9" }));
    expect(kept.ok && kept.nodeId === "CAND-9").toBe(true);
    const dup = f.write.write(f.root, propose("撞号", { id: "CAND-9" }));
    expect(!dup.ok && dup.error.code === "KG_E_ID").toBe(true);
    const bad = f.write.write(f.root, propose("坏号", { id: "TR-9" }));
    expect(!bad.ok && bad.error.code === "KG_E_SCHEMA").toBe(true);
    // 计数器推进：下一个自动发号 CAND-10（只增不减永不复用）
    const next = f.write.write(f.root, propose("自动接续"));
    expect(next.ok && next.nodeId === "CAND-10").toBe(true);
  });
});

function r1id(r: { ok: boolean; nodeId?: string }): string | null {
  return r.ok ? (r.nodeId ?? null) : null;
}

describe("② schema 校验（KgWriteService 前置，零落库）", () => {
  test("title 缺/空 → KG_E_SCHEMA；candidateKind 越界词表 → KG_E_SCHEMA；body 非字符串 → KG_E_SCHEMA", () => {
    const f = makeFixture();
    f.database.knowledgeConnection(f.root); // 全部拒绝场景库文件未建——先建库供 probe
    const noTitle = f.write.write(f.root, { kind: "proposeCandidate", iterationId: "i", candidateKind: "sediment" } as unknown as KnowledgeWriteOp);
    expect(!noTitle.ok && noTitle.error.code === "KG_E_SCHEMA" && noTitle.error.path === "op.title").toBe(true);
    const badKind = f.write.write(f.root, propose("t", { candidateKind: "todo" }));
    expect(!badKind.ok && badKind.error.code === "KG_E_SCHEMA" && badKind.error.path === "op.candidateKind").toBe(true);
    const badBody = f.write.write(f.root, propose("t", { body: 1 }));
    expect(!badBody.ok && badBody.error.code === "KG_E_SCHEMA").toBe(true);
    expect(rows(f.root)).toHaveLength(0);
  });

  test("decideCandidate：decision 四值外 → KG_E_SCHEMA；discarded 缺 reason → KG_E_SCHEMA；candidateId 缺 → KG_E_SCHEMA", () => {
    const f = makeFixture();
    f.write.write(f.root, propose("t"));
    const badDecision = f.write.write(f.root, decide("CAND-1", "maybe"));
    expect(!badDecision.ok && badDecision.error.code === "KG_E_SCHEMA" && badDecision.error.path === "op.decision").toBe(true);
    const noReason = f.write.write(f.root, decide("CAND-1", "discarded"));
    expect(!noReason.ok && noReason.error.code === "KG_E_SCHEMA" && noReason.error.path === "op.reason").toBe(true);
    const noId = f.write.write(f.root, { kind: "decideCandidate", iterationId: "i", decision: "applied" } as unknown as KnowledgeWriteOp);
    expect(!noId.ok && noId.error.code === "KG_E_SCHEMA").toBe(true);
    // 全部拒绝零落库：行仍为 pending
    expect(rows(f.root)[0]!.status).toBe("pending");
  });
});

describe("③ 状态机（pending→applied/discarded/deferred；终态不可逆）", () => {
  test("pending → applied：decided_at/reason/formalId/appliedNodeId 落列", () => {
    const f = makeFixture();
    f.write.write(f.root, propose("可采纳"));
    const r = f.write.write(
      f.root,
      decide("CAND-1", "applied", { reason: "人审采纳", formalId: "TR-88", appliedNodeId: "TR-88" }),
    );
    expect(r.ok).toBe(true);
    const row = rows(f.root)[0]!;
    expect(row.status).toBe("applied");
    expect(row.decided_at).not.toBeNull();
    expect(row.decision_reason).toBe("人审采纳");
    expect(row.formal_id).toBe("TR-88");
    expect(row.applied_node_id).toBe("TR-88");
  });

  test("pending → discarded（reason 落列）；终态再 decide → KG_E_STATE", () => {
    const f = makeFixture();
    f.write.write(f.root, propose("要丢弃"));
    const r = f.write.write(f.root, decide("CAND-1", "discarded", { reason: "重复沉淀" }));
    expect(r.ok).toBe(true);
    expect(rows(f.root)[0]!.status).toBe("discarded");
    const again = f.write.write(f.root, decide("CAND-1", "applied", { reason: "反悔" }));
    expect(!again.ok && again.error.code === "KG_E_STATE").toBe(true);
    const appliedAgain = f.write.write(f.root, propose("先采纳"));
    void appliedAgain;
    f.write.write(f.root, decide("CAND-2", "applied", { reason: "ok" }));
    const redecide = f.write.write(f.root, decide("CAND-2", "deferred"));
    expect(!redecide.ok && redecide.error.code === "KG_E_STATE").toBe(true);
  });

  test("pending → deferred：defer_age 逐次 +1；deferred 可再 deferred/applied", () => {
    const f = makeFixture();
    f.write.write(f.root, propose("暂缓一"));
    expect(f.write.write(f.root, decide("CAND-1", "deferred")).ok).toBe(true);
    expect(rows(f.root)[0]).toMatchObject({ status: "deferred", defer_age: 1 });
    expect(f.write.write(f.root, decide("CAND-1", "deferred")).ok).toBe(true);
    expect(rows(f.root)[0]!.defer_age).toBe(2);
    expect(f.write.write(f.root, decide("CAND-1", "applied", { reason: "终验采纳" })).ok).toBe(true);
    expect(rows(f.root)[0]!.status).toBe("applied");
  });

  test("不存在的 candidateId → KG_E_ID", () => {
    const f = makeFixture();
    const r = f.write.write(f.root, decide("CAND-99", "applied", { reason: "x" }));
    expect(!r.ok && r.error.code === "KG_E_ID").toBe(true);
  });
});

describe("④ 审计（每 op 落 change_log；task_id 机械注入面沿用）", () => {
  test("propose/decide 各落一行 change_log（node_id=CAND id；decide 记 reason）", () => {
    const f = makeFixture();
    f.write.write(f.root, propose("审计条目", { taskId: "job-7" }));
    f.write.write(f.root, decide("CAND-1", "discarded", { reason: "不要了", taskId: "job-7" }));
    const logs = probe<{ op: string; node_id: string; reason: string | null; task_id: string | null }>(
      f.root,
      "SELECT op, node_id, reason, task_id FROM change_log ORDER BY seq",
    );
    expect(logs).toEqual([
      { op: "proposeCandidate", node_id: "CAND-1", reason: null, task_id: "job-7" },
      { op: "decideCandidate", node_id: "CAND-1", reason: "不要了", task_id: "job-7" },
    ]);
  });
});

describe("⑤ defer 上限（service 层只警告不拒绝——机械只列不修）", () => {
  test("defer_age 达 2 再 defer → 仍落库但携带年龄警告", () => {
    const f = makeFixture();
    f.write.write(f.root, propose("老龄化"));
    const d1 = f.write.write(f.root, decide("CAND-1", "deferred"));
    expect(d1.ok && !(d1 as { warning?: string }).warning).toBe(true);
    const d2 = f.write.write(f.root, decide("CAND-1", "deferred"));
    expect(d2.ok).toBe(true);
    expect((d2 as { warning?: string }).warning).toContain("defer_age");
  });

  test("deferred 积压超 10 条再 defer → 仍落库但携带积压警告", () => {
    const f = makeFixture();
    for (let i = 0; i < 11; i += 1) f.write.write(f.root, propose(`积压${i}`));
    for (let i = 1; i <= 10; i += 1) f.write.write(f.root, decide(`CAND-${i}`, "deferred"));
    const r = f.write.write(f.root, decide("CAND-11", "deferred"));
    expect(r.ok).toBe(true);
    expect((r as { warning?: string }).warning).toContain("10");
  });
});

describe("⑥ purge 全清含 candidates（计数器随 meta 归零）", () => {
  test("purgeAll 后 candidates 清零；重发号自 CAND-1 起", () => {
    const f = makeFixture();
    f.write.write(f.root, propose("待清"));
    f.store.purgeAll(f.root);
    expect(rows(f.root)).toHaveLength(0);
    const r = f.write.write(f.root, propose("重启"));
    expect(r.ok && r.nodeId === "CAND-1").toBe(true);
  });
});

describe("⑦ target_node 列级演进 + 落库透传（老库无列 → ALTER 补列；存量行不回填）", () => {
  /** 无 target_node 列的旧库形态（演进前 candidates 子集 + 既有行）。 */
  function buildLegacyDb(root: string): void {
    const dbPath = kgDbPath(root);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  formal_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','applied','discarded','deferred')),
  source_task_id TEXT,
  source_iteration_id TEXT,
  defer_age INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decision_reason TEXT,
  applied_node_id TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);
    db.prepare(
      "INSERT INTO candidates (id, kind, title, status, defer_age, created_at) " +
        "VALUES ('CAND-1', 'sediment', '既有候选', 'pending', 0, '2026-01-01T00:00:00.000Z')",
    ).run();
    db.close();
  }

  test("老库打开 → 自动补 target_node 列，存量行 NULL 零变化；二次打开幂等", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kg-cand-legacy-"));
    const database = new KgDatabase();
    fixtures.push({ root, database, store: null!, write: null!, graph: null! });
    buildLegacyDb(root);

    database.knowledgeConnection(root); // 打开触发演进
    const probe = new Database(kgDbPath(root));
    try {
      const cols = (probe.prepare("PRAGMA table_info(candidates)").all() as { name: string }[]).map((c) => c.name);
      expect(cols.filter((c) => c === "target_node")).toHaveLength(1);
      const row = probe.prepare("SELECT target_node FROM candidates WHERE id = 'CAND-1'").get() as { target_node: string | null };
      expect(row.target_node).toBeNull(); // 存量行不回填
    } finally {
      probe.close();
    }

    // 二次打开幂等（ALTER 不重复执行）
    const again = new KgDatabase();
    again.knowledgeConnection(root);
    again.closeAll();
    const probe2 = new Database(kgDbPath(root));
    try {
      const cols = (probe2.prepare("PRAGMA table_info(candidates)").all() as { name: string }[]).map((c) => c.name);
      expect(cols.filter((c) => c === "target_node")).toHaveLength(1);
    } finally {
      probe2.close();
    }
  });

  test("proposeCandidate 携带 targetNode → 落库 target_node；缺省 → NULL（旧行为不变）", () => {
    const f = makeFixture();
    f.write.write(f.root, propose("带目标", { targetNode: "TR-1" }));
    f.write.write(f.root, propose("无目标"));
    const all = rows(f.root);
    expect(all).toHaveLength(2);
    const withTarget = all.find((r) => r.id === "CAND-1")!;
    const without = all.find((r) => r.id === "CAND-2")!;
    expect(withTarget.target_node).toBe("TR-1");
    expect(without.target_node).toBeNull();
  });
});

describe("⑧ 读面 listCandidates + targetNode 写面校验（agent 工具/WS 命令共同数据面）", () => {
  test("listCandidates 无过滤 → 全量行最新在前（含 body 全文 + targetNode + deferAge）；status 过滤 / limit / offset 分页", () => {
    const f = makeFixture();
    f.write.write(f.root, propose("候选一", { body: "正文一", targetNode: "TR-7" }));
    f.write.write(f.root, propose("候选二"));
    f.write.write(f.root, propose("候选三"));
    f.write.write(f.root, decide("CAND-1", "deferred"));
    f.write.write(f.root, decide("CAND-3", "applied", { reason: "采纳" }));

    const all = f.graph.listCandidates(f.root, {});
    expect(all.map((r) => r.id)).toEqual(["CAND-3", "CAND-2", "CAND-1"]); // 最新在前（rowid 序）
    const first = all.find((r) => r.id === "CAND-1")!;
    expect(first.title).toBe("候选一");
    expect(first.body).toBe("正文一"); // body 全文（agent 清台判读需要）
    expect(first.targetNode).toBe("TR-7");
    expect(first.status).toBe("deferred");
    expect(first.deferAge).toBe(1);
    expect(first.kind).toBe("sediment");
    expect(typeof first.createdAt).toBe("string");
    expect(all.find((r) => r.id === "CAND-3")!.status).toBe("applied");
    expect(all.find((r) => r.id === "CAND-3")!.decisionReason).toBe("采纳");

    const pendingOnly = f.graph.listCandidates(f.root, { status: "pending" });
    expect(pendingOnly.map((r) => r.id)).toEqual(["CAND-2"]);
    const deferred = f.graph.listCandidates(f.root, { status: "deferred" });
    expect(deferred.map((r) => r.id)).toEqual(["CAND-1"]);

    const page1 = f.graph.listCandidates(f.root, { limit: 2 });
    expect(page1.map((r) => r.id)).toEqual(["CAND-3", "CAND-2"]);
    const page2 = f.graph.listCandidates(f.root, { limit: 2, offset: 2 });
    expect(page2.map((r) => r.id)).toEqual(["CAND-1"]);
  });

  test("targetNode 写面校验：非法形态（非 TR-/E- 前缀 / 空串）→ KG_E_SCHEMA 零落库；保号复合形态合法", () => {
    const f = makeFixture();
    f.database.knowledgeConnection(f.root);
    const badPrefix = f.write.write(f.root, propose("坏前缀", { targetNode: "SPEC-2" }));
    expect(!badPrefix.ok && badPrefix.error.code === "KG_E_SCHEMA" && badPrefix.error.path === "op.targetNode").toBe(true);
    const empty = f.write.write(f.root, propose("空串", { targetNode: "" }));
    expect(!empty.ok && empty.error.code === "KG_E_SCHEMA").toBe(true);
    const compound = f.write.write(f.root, propose("保号形态", { targetNode: "TR-AD-47" }));
    expect(compound.ok).toBe(true);
    const plain = f.write.write(f.root, propose("新号形态", { targetNode: "E-3" }));
    expect(plain.ok).toBe(true);
    expect(rows(f.root)).toHaveLength(2);
  });
});
