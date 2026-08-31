import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core/node";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createKgUpdateTool } from "../../src/adapters/driven/tools/kg-update/KgUpdateTool";
import { KgDatabase } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import type { KnowledgeWriteOp, WriteResult } from "../../src/domain/kg/types";

/**
 * I 层：kg-update 工具 batchCreateNodes 薄壳（T2.1，O-5 裁决——LLM 按写入量
 * 自选单条/批量，两 op 并存；契约层不设选择规则）。
 *
 * 覆盖：
 * - 工具 schema 词表 additive 扩（op enum + nodes 数组），既有 createNode
 *   语义不动（A 组回归见 kg-tools.test.ts，本文件零触碰）；
 * - nodes 数组逐项透传 KgWriteService（唯一写入口，结构化错误透传含序号路径）；
 * - 校验错误消息含非法项序号（nodes[i] 定位）。
 */

interface Fixture {
  readonly root: string;
  readonly proj: string;
  readonly database: KgDatabase;
  readonly write: KgWriteService;
  readonly writeCalls: KnowledgeWriteOp[];
  readonly tool: AgentHarnessTool<ExecutionToolContext, any, undefined>;
  readonly env: NodeExecutionEnv;
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
  const root = mkdtempSync(path.join(tmpdir(), "kg-update-batch-"));
  const proj = path.join(root, "proj");
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const write = new KgWriteService({ store });
  const writeCalls: KnowledgeWriteOp[] = [];
  const recorder = {
    write: (projectRoot: string, op: KnowledgeWriteOp): WriteResult => {
      writeCalls.push(op);
      return write.write(projectRoot, op);
    },
  };
  const graph = new SqliteKnowledgeGraph({ database });
  const tool = createKgUpdateTool({
    query: {
      locate: () => [], // batch 路径不消费 locate（无既有节点引用）
    },
    write: recorder,
    workspaceRoot: root,
    scanProjects: () => [proj],
  });
  const f: Fixture = { root, proj, database, write, writeCalls, tool, env: new NodeExecutionEnv({ cwd: root }) };
  fixtures.push(f);
  return f;
}

type RunResult = { ok: true; text: string } | { ok: false; error: string };

async function run(f: Fixture, args: unknown): Promise<RunResult> {
  try {
    const result = await f.tool.execute("tc-batch", args as never, undefined, undefined, { env: f.env });
    return { ok: true, text: (result.content as any[]).map((b) => (b.type === "text" ? b.text : `(${b.type})`)).join("\n") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

describe("kg-update batchCreateNodes 批量带锚（P1 ②：items 补 anchors，形态同单条）", () => {
  test("① 批量带锚 → 节点 + anchor_decl + declareAnchors 审计行齐建（单事务原子）", async () => {
    const f = makeFixture();
    const r = await run(f, {
      op: "batchCreateNodes",
      nodes: [
        { kind: "rule", name: "带锚规则", digest: "摘要一", scene: "测试场景", anchors: [{ scopeKind: "global" }, { scopeKind: "path", pattern: "src/**" }] },
        { kind: "entity", name: "带锚实体", digest: "摘要二", scene: "测试场景", anchors: [{ scopeKind: "symbol", pattern: "src/x.ts#fn" }] },
      ],
      iterationId: "iter-batch-anchor",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain("锚声明 3 条");
    const db = f.database.knowledgeConnection(f.proj);
    // 节点 2 + 锚声明 3 行（逐项全集替换语义）
    expect((db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n).toBe(2);
    const decls = db.prepare("SELECT node_id, scope_kind, pattern FROM anchor_decl ORDER BY node_id, scope_kind").all() as Record<string, string>[];
    expect(decls).toEqual([
      { node_id: "E-1", scope_kind: "symbol", pattern: "src/x.ts#fn" },
      { node_id: "TR-1", scope_kind: "global", pattern: "" },
      { node_id: "TR-1", scope_kind: "path", pattern: "src/**" },
    ]);
    // 审计链：createNode ×2 + declareAnchors ×2（与单条两拍同形）
    const ops = (db.prepare("SELECT op FROM change_log ORDER BY rowid").all() as { op: string }[]).map((x) => x.op);
    expect(ops).toEqual(["createNode", "declareAnchors", "createNode", "declareAnchors"]);
  });

  test("② 部分项带锚：无锚项照常（锚可选，不携带零 declareAnchors 行）", async () => {
    const f = makeFixture();
    const r = await run(f, {
      op: "batchCreateNodes",
      nodes: [
        { kind: "rule", name: "带锚", digest: "摘要一", scene: "测试场景", anchors: [{ scopeKind: "global" }] },
        { kind: "rule", name: "无锚", digest: "摘要二", scene: "测试场景" },
      ],
      iterationId: "iter-batch-anchor",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const db = f.database.knowledgeConnection(f.proj);
    const ops = (db.prepare("SELECT op FROM change_log ORDER BY rowid").all() as { op: string }[]).map((x) => x.op);
    expect(ops).toEqual(["createNode", "declareAnchors", "createNode"]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM anchor_decl").get() as { n: number }).n).toBe(1);
  });

  test("③ 锚参数非法（nodes[0].anchors scopeKind 越界）→ 整批拒绝零落库", async () => {
    const f = makeFixture();
    const r = await run(f, {
      op: "batchCreateNodes",
      nodes: [
        { kind: "rule", name: "坏锚", digest: "摘要一", scene: "测试场景", anchors: [{ scopeKind: "weird" }] },
        { kind: "rule", name: "好项", digest: "摘要二", scene: "测试场景" },
      ],
      iterationId: "iter-batch-anchor",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("nodes[0]");
      expect(r.error).toContain("scopeKind");
    }
    const db = f.database.knowledgeConnection(f.proj);
    for (const table of ["nodes", "anchor_decl", "change_log"]) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
  });

  test("④ 锚形态非法（path 锚空 pattern）→ 服务层 KG_E_SCHEMA 序号路径（防线二道）", async () => {
    const f = makeFixture();
    const r = f.write.write(f.proj, {
      kind: "batchCreateNodes",
      iterationId: "iter-svc",
      nodes: [
        {
          draft: { kind: "rule", name: "服务层校验", digest: "d", scene: "测试场景" },
          anchors: [{ scopeKind: "path", pattern: "" }],
        },
      ],
    } as never) as { ok: boolean; error?: { code: string; path?: string } };
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error!.code).toBe("KG_E_SCHEMA");
      expect(r.error!.path).toBe("op.nodes[0].anchors[0].pattern");
    }
    const db = f.database.knowledgeConnection(f.proj);
    expect((db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n).toBe(0);
  });
});

describe("kg-update batchCreateNodes 薄壳（O-5：单条/批量两 op 并存）", () => {
  test("① 3 节点批量 → 单 op 经 KgWriteService 落库 + 全部自动发号", async () => {
    const f = makeFixture();
    const r = await run(f, {
      op: "batchCreateNodes",
      nodes: [
        { kind: "rule", name: "批量一", digest: "摘要一", scene: "测试场景" },
        { kind: "rule", name: "批量二", digest: "摘要二", scene: "测试场景" },
        { kind: "entity", name: "批量实体", digest: "摘要三", scene: "测试场景", domain: "tech" },
      ],
      iterationId: "iter-batch-tool",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(f.writeCalls).toHaveLength(1);
    expect(f.writeCalls[0]!.kind).toBe("batchCreateNodes");
    // 落库终态：3 节点 + 3 行 change_log
    const db = f.database.knowledgeConnection(f.proj);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n;
    const c = (db.prepare("SELECT COUNT(*) AS n FROM change_log").get() as { n: number }).n;
    expect(n).toBe(3);
    expect(c).toBe(3);
    expect(r.text).toContain("3");
    expect(r.text).toMatch(/TR-3|E-1/); // 末节点 id 回显
  });

  test("② 节点载荷形态错误（nodes[1] 缺 digest）→ 错误消息含非法项序号（薄壳直拒，同单条 createNode 先例）", async () => {
    const f = makeFixture();
    const r = await run(f, {
      op: "batchCreateNodes",
      nodes: [
        { kind: "rule", name: "好", digest: "d", scene: "测试场景" },
        { kind: "rule", name: "坏", scene: "测试场景" },
      ],
      iterationId: "iter-batch-tool",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("digest");
      expect(r.error).toContain("nodes[1]"); // 序号定位非法项
    }
  });

  test("③ 空 nodes → 薄壳直拒（必填非空数组）", async () => {
    const f = makeFixture();
    const r = await run(f, { op: "batchCreateNodes", nodes: [], iterationId: "iter-batch-tool" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("nodes");
  });

  test("④ 既有 createNode 语义不动：单条路径照常（回归对照）", async () => {
    const f = makeFixture();
    const r = await run(f, {
      op: "createNode",
      kind: "rule",
      name: "单条回归",
      digest: "单条摘要",
      scene: "测试场景",
      iterationId: "iter-single",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(f.writeCalls[0]!.kind).toBe("createNode");
    const db = f.database.knowledgeConnection(f.proj);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n;
    expect(n).toBe(1);
    expect(r.text).toContain("TR-1");
  });
});
