import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import {
  parseCandidatesMd,
  runApply,
  runDryRun,
  type CandidatesMigrateStack,
} from "../../../../scripts/oneoff/kg-candidates-migrate";

/**
 * W1-C 收尾（R3）：docs/kg/candidates.md 四分区 → candidates 表一次性迁移。
 * - 解析正确性：四分区 + `### title` + `- key: value` 字段行；
 * - 幂等：内容哈希去重，重复 apply 行数不变；
 * - 发号兼容：先查表内最大 seq（与计数器取大者）续号；
 * - 字段映射：status/formal_id/applied_node_id/decision_reason 落列正确。
 */

const disposers: Array<() => void> = [];

function freshStack(): CandidatesMigrateStack & { root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "helix-candidates-migrate-"));
  const database = new KgDatabase();
  const stack: CandidatesMigrateStack = {
    database,
    store: new SqliteKnowledgeStore({ database }),
    service: new KgWriteService({ store: new SqliteKnowledgeStore({ database }) }),
  };
  disposers.push(() => {
    database.closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  return { ...stack, root };
}

afterAll(() => {
  for (const dispose of disposers) dispose();
});

/** fixture：四分区 + 字段形态覆盖（targetNode/formalId 有无、同 title 不同 body）。 */
const FIXTURE_MD = `# 候选台账（candidates）

## pending

### P-新规则候选
- changeType: 新增
- scope: domain
- project: helix
- reason: 某闭环发现的沉淀
- evidence: some.test.ts 1 例
- implementationStatus: 完整实现
- implementedCode: src/a.ts
- sourceTask: task-x（某 agent，2026-08-30）
- createdIn: iter-20260830-w1c

## deferred

## applied

### E-Demo-r1
- changeType: 修改
- targetNode: E-Demo
- scope: docs/kg/domain.md E-Demo
- project: helix
- reason: 修改落点原因
- evidence: demo.test.ts 2 例
- implementationStatus: 完整实现
- implementedCode: src/demo.ts
- sourceTask: task-apply-1（直查，2026-08-29）
- createdIn: iter-20260829-a1
- decisionLog: 用户裁决「apply吧」（2026-08-29）——正文直写

### E-Demo-r1
- changeType: 修改
- targetNode: E-Demo
- scope: docs/kg/domain.md E-Demo（同名不同内容——两条都须保留）
- project: helix
- reason: 另一条同题修改
- evidence: demo2.test.ts 1 例
- implementationStatus: 部分实现
- implementedCode: src/demo2.ts
- sourceTask: task-apply-2
- createdIn: iter-20260829-a2
- decisionLog: 用户裁决「apply吧」——第二批

### SPEC-new-1
- changeType: 新增
- scope: domain
- project: helix
- reason: 新增沉淀（无 targetNode，formalId 签发）
- evidence: commit abc123
- implementationStatus: 完整实现
- implementedCode: src/new.ts
- sourceTask: task-apply-3
- createdIn: iter-20260829-a3
- formalId: TR-NEW-1
- decisionLog: 终验签发正式号 TR-NEW-1

## discarded

### SPEC-drop-1
- changeType: 新增
- scope: domain
- project: helix
- reason: 与既有条目合并
- evidence: commit def456
- implementationStatus: 完整实现
- implementedCode: src/drop.ts
- sourceTask: task-drop-1
- createdIn: iter-20260828-d1
- decisionLog: 终验决策：合并落库，本条 discard 保留审计痕
`;

function writeFixture(root: string, markdown: string = FIXTURE_MD): void {
  const docsDir = path.join(root, "docs", "kg");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(docsDir, "candidates.md"), markdown);
}

interface CandidateDbRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  source_task_id: string | null;
  source_iteration_id: string | null;
  defer_age: number;
  decided_at: string | null;
  decision_reason: string | null;
  formal_id: string | null;
  applied_node_id: string | null;
}

function readRows(root: string): CandidateDbRow[] {
  if (!existsSync(kgDbPath(root))) return []; // 从未写入 = 库文件未建
  const db = new Database(kgDbPath(root), { readonly: true });
  try {
    return db
      .query(
        "SELECT id, kind, title, body, status, source_task_id, source_iteration_id, defer_age, " +
          "decided_at, decision_reason, formal_id, applied_node_id FROM candidates ORDER BY CAST(SUBSTR(id, 6) AS INTEGER)",
      )
      .all() as CandidateDbRow[];
  } finally {
    db.close();
  }
}

describe("kg-candidates-migrate 解析", () => {
  test("fixture：四分区计数 + 字段保序 + 同名不同 body 两条皆保留", () => {
    const parsed = parseCandidatesMd(FIXTURE_MD);
    expect(parsed.issues).toEqual([]);
    expect(parsed.counts).toEqual({ pending: 1, deferred: 0, applied: 3, discarded: 1 });
    expect(parsed.entries).toHaveLength(5);
    const twins = parsed.entries.filter((e) => e.title === "E-Demo-r1");
    expect(twins).toHaveLength(2);
    expect(twins[0]!.contentKey).not.toBe(twins[1]!.contentKey);
    const first = parsed.entries[0]!;
    expect(first.section).toBe("pending");
    expect(first.fields[0]).toEqual(["changeType", "新增"]);
  });

  test("解析问题：分区外条目 / 条目内非字段行记 issue", () => {
    const bad = parseCandidatesMd(
      "# t\n\n### 游离条目\n- reason: x\n\n## applied\n\n### A\n- reason: y\n非字段行\n",
    );
    expect(bad.issues).toHaveLength(2);
    expect(bad.issues[0]!.message).toContain("四分区之外");
    expect(bad.issues[1]!.message).toContain("非字段行");
    expect(bad.entries).toHaveLength(1);
  });

  test("真实 docs/kg/candidates.md：149 条目（pending=0 deferred=0 applied=90 discarded=59）零 issue", () => {
    const repoRoot = path.resolve(__dirname, "../../../..");
    const markdown = readFileSync(path.join(repoRoot, "docs", "kg", "candidates.md"), "utf8");
    const parsed = parseCandidatesMd(markdown);
    expect(parsed.issues).toEqual([]);
    expect(parsed.counts).toEqual({ pending: 0, deferred: 0, applied: 90, discarded: 59 });
    expect(parsed.entries).toHaveLength(149);
  });
});

describe("kg-candidates-migrate dry-run", () => {
  test("计数 + 发号预演（库内既有 CAND-1 时续 CAND-2 起）", () => {
    const { root, service } = freshStack();
    writeFixture(root);
    // 预置一条自动发号候选（CAND-1）——发号兼容性基线
    const seeded = service.write(root, {
      kind: "proposeCandidate",
      iterationId: "iter-seed",
      candidateKind: "sediment",
      title: "库内既有候选",
      body: "- reason: 既有行",
    });
    expect(seeded.ok).toBe(true);

    const dry = runDryRun(root);
    expect(dry.ok).toBe(true);
    expect(dry.counts).toEqual({ pending: 1, deferred: 0, applied: 3, discarded: 1 });
    expect(dry.toMigrate).toBe(5);
    expect(dry.alreadyMigrated).toBe(0);
    expect(dry.nextSeq).toBe(1);
    expect(dry.summary).toContain("CAND-2 起");
  });

  test("discarded 缺 decisionLog → dry-run 不过 + apply 拒绝切换", () => {
    const { root, database, store, service } = freshStack();
    writeFixture(
      root,
      "# t\n\n## discarded\n\n### D-1\n- changeType: 新增\n- scope: domain\n- project: helix\n- reason: x\n",
    );
    const dry = runDryRun(root);
    expect(dry.ok).toBe(false);
    expect(dry.errors[0]).toContain("discarded 缺 decisionLog");
    const result = runApply(root, { database, store, service });
    expect(result.ok).toBe(false);
    expect(readRows(root)).toHaveLength(0);
  });
});

describe("kg-candidates-migrate apply", () => {
  test("字段映射 + 显式保号续号 + 状态机落终态", () => {
    const { root, database, store, service } = freshStack();
    writeFixture(root);
    const seeded = service.write(root, {
      kind: "proposeCandidate",
      iterationId: "iter-seed",
      candidateKind: "sediment",
      title: "库内既有候选",
      body: "- reason: 既有行",
    });
    expect(seeded.ok).toBe(true);

    const result = runApply(root, { database, store, service });
    expect(result.ok).toBe(true);
    expect(result.created).toEqual(["CAND-2", "CAND-3", "CAND-4", "CAND-5", "CAND-6"]);
    expect(result.skipped).toEqual([]);

    const rows = readRows(root);
    expect(rows).toHaveLength(6);

    const pending = rows.find((r) => r.title === "P-新规则候选")!;
    expect(pending.status).toBe("pending");
    expect(pending.kind).toBe("sediment");
    expect(pending.decided_at).toBeNull();
    expect(pending.decision_reason).toBeNull();
    expect(pending.source_task_id).toBe("task-x");
    expect(pending.source_iteration_id).toBe("iter-20260830-w1c");
    expect(pending.body).toContain("- changeType: 新增");

    // 同 title 两条皆迁（内容哈希区分，不塌缩）
    const twins = rows.filter((r) => r.title === "E-Demo-r1");
    expect(twins).toHaveLength(2);
    for (const twin of twins) {
      expect(twin.status).toBe("applied");
      expect(twin.formal_id).toBe("E-Demo");
      expect(twin.applied_node_id).toBe("E-Demo");
      expect(twin.decision_reason).toContain("apply");
      expect(twin.decided_at).not.toBeNull();
    }

    const added = rows.find((r) => r.title === "SPEC-new-1")!;
    expect(added.status).toBe("applied");
    expect(added.formal_id).toBe("TR-NEW-1");
    expect(added.applied_node_id).toBe("TR-NEW-1"); // 无 targetNode → formalId 兜底

    const dropped = rows.find((r) => r.title === "SPEC-drop-1")!;
    expect(dropped.status).toBe("discarded");
    expect(dropped.formal_id).toBeNull();
    expect(dropped.applied_node_id).toBeNull();
    expect(dropped.decision_reason).toContain("保留审计痕");
  });

  test("幂等：重复 apply 全部跳过、行数不变", () => {
    const { root, database, store, service } = freshStack();
    writeFixture(root);
    const first = runApply(root, { database, store, service });
    expect(first.ok).toBe(true);
    expect(first.created).toHaveLength(5);
    const countAfterFirst = readRows(root).length;

    const second = runApply(root, { database, store, service });
    expect(second.ok).toBe(true);
    expect(second.created).toEqual([]);
    expect(second.skipped).toHaveLength(5);
    expect(readRows(root)).toHaveLength(countAfterFirst);

    const dry = runDryRun(root);
    expect(dry.toMigrate).toBe(0);
    expect(dry.alreadyMigrated).toBe(5);
  });
});
