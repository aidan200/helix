import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core/node";
import { KgDatabase } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { SqliteKnowledgeGraph } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeGraph";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import { KgQueryService } from "../../src/application/services/kg/KgQueryService";
import { createKgTool } from "../../src/adapters/driven/tools/kg/KgTool";
import type { MaterializedAnchor, SymbolBatch } from "../../src/domain/kg/types";

/**
 * I 层（真 SQLite tmp 库）：kg 锚反查 op affected（R20 裁决，
 * kg-driven-dev-loop-design.md D3：意图→codegraph 落地符号→锚反查链路的
 * 中间环——edit 📎 附着同查询的主动调用版）。
 *
 * 覆盖：
 * ① target 为相对路径 → path 锚与同路径 symbol 锚皆命中；
 * ② target 为符号名 / path#symbol 复合形态 → symbol 锚命中；
 * ③ orphan 锚排除（失效即静默，与附着快照同纪律）；superseded 节点排除；
 * ④ 物化零命中时 anchor_decl 声明反查兑底（viaDecl 标记——锚未物化）；
 * ⑤ 结果含 scene + digest + kg get 指针；空 scene 兑底不渲染 scene 段；
 * ⑥ 跨项目聚合 + 未建库项目不出现（读面 absent 短路）。
 */

interface Fixture {
  readonly root: string;
  readonly projA: string;
  readonly projB: string;
  readonly database: KgDatabase;
  readonly store: SqliteKnowledgeStore;
  readonly graph: SqliteKnowledgeGraph;
  readonly write: KgWriteService;
  readonly query: KgQueryService;
  readonly kg: AgentHarnessTool<ExecutionToolContext, any, any>;
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

async function execText(f: Fixture, params: Record<string, unknown>): Promise<string> {
  const result = await f.kg.execute("call-1", params, undefined, undefined, f.env as any);
  return result.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text).join("\n");
}

function seedNode(f: Fixture, proj: string, name: string, scene: string): string {
  const r = f.write.write(proj, {
    kind: "createNode",
    iterationId: "iter-aff",
    draft: { kind: "rule", name, digest: `${name}摘要`, scene },
  });
  if (!r.ok) throw new Error(`seed failed: ${r.error.message}`);
  return r.nodeId;
}

async function seedAnchors(f: Fixture, proj: string, anchors: readonly MaterializedAnchor[]): Promise<void> {
  const batch: SymbolBatch = {
    files: [{ path: "src/foo.ts", mtime: 1, sha256: "h" }],
    symbols: [],
    containsEdges: [],
    materializedAnchors: anchors,
    baseline: "b1",
    degraded: false,
  };
  await f.store.applySync(proj, batch);
}

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "kg-affected-it-"));
  const projA = path.join(root, "projA");
  const projB = path.join(root, "projB"); // 永不建库——absent 短路断言面
  const database = new KgDatabase();
  const store = new SqliteKnowledgeStore({ database });
  const graph = new SqliteKnowledgeGraph({ database });
  const write = new KgWriteService({ store });
  const query = new KgQueryService({
    graph,
    // 已建 .kg 项目列表由注入方过滤（读面绝不新建库文件）——projB 模拟未建库不出现
    projects: () => [projA],
  });
  const kg = createKgTool({ query });
  const fixture: Fixture = { root, projA, projB, database, store, graph, write, query, kg, env: new NodeExecutionEnv({ cwd: root }) };
  fixtures.push(fixture);
  return fixture;
}

describe("①② affected 反查：路径 / 符号 / 复合形态", () => {
  test("target=相对路径 → path 锚与同路径 symbol 锚皆命中；target=符号名与 path#symbol → symbol 锚命中", async () => {
    const f = makeFixture();
    const pathNode = seedNode(f, f.projA, "写通道纪律", "改动 kg 写路径前");
    const symbolNode = seedNode(f, f.projA, "发号规则", "改动 id 发号前");
    await seedAnchors(f, f.projA, [
      { nodeId: pathNode, anchorKind: "path", anchorPath: "src/foo.ts", anchorSymbol: null },
      { nodeId: symbolNode, anchorKind: "symbol", anchorPath: "src/foo.ts", anchorSymbol: "allocateSeq" },
    ]);

    const byPath = f.query.affected("src/foo.ts");
    expect(byPath.map((h) => h.nodeId).sort()).toEqual([pathNode, symbolNode].sort());

    const bySymbol = f.query.affected("allocateSeq");
    expect(bySymbol).toHaveLength(1);
    expect(bySymbol[0]!.nodeId).toBe(symbolNode);

    const byComposite = f.query.affected("src/foo.ts#allocateSeq");
    expect(byComposite).toHaveLength(1);
    expect(byComposite[0]!.nodeId).toBe(symbolNode);

    // 命中行携带 scene + digest + 锚信息（kg get 指针由渲染层出）
    expect(byPath.find((h) => h.nodeId === pathNode)).toMatchObject({
      scene: "改动 kg 写路径前",
      digest: "写通道纪律摘要",
      anchorKind: "path",
      viaDecl: false,
    });
  });
});

describe("③ orphan / superseded 排除（失效即静默）", () => {
  test("orphan=1 锚不返回；superseded 节点锚不返回", async () => {
    const f = makeFixture();
    const orphanNode = seedNode(f, f.projA, "失效锚节点", "场景");
    const deadNode = seedNode(f, f.projA, "已推翻节点", "场景");
    await seedAnchors(f, f.projA, [
      { nodeId: orphanNode, anchorKind: "symbol", anchorPath: "src/foo.ts", anchorSymbol: "gone" },
      { nodeId: deadNode, anchorKind: "path", anchorPath: "src/dead.ts", anchorSymbol: null },
    ]);
    // orphan 标记（符号消亡通道；物化锚清单不再含该锚——upsert 会置回活跃）
    await f.store.applySync(f.projA, {
      files: [{ path: "src/foo.ts", mtime: 2, sha256: "h2" }],
      symbols: [],
      containsEdges: [],
      materializedAnchors: [],
      orphanedAnchors: [{ nodeId: orphanNode, anchorKind: "symbol", anchorPath: "src/foo.ts", anchorSymbol: "gone" }],
      baseline: "b2",
      degraded: false,
    });
    const s = f.write.write(f.projA, { kind: "supersede", iterationId: "iter-aff", nodeId: deadNode, reason: "推翻" });
    expect(s.ok).toBe(true);

    expect(f.query.affected("gone")).toHaveLength(0); // orphan 排除
    expect(f.query.affected("src/dead.ts")).toHaveLength(0); // superseded 排除
  });
});

describe("④ 物化零命中 → anchor_decl 声明反查兑底（viaDecl）", () => {
  test("声明了 symbol 锚但未物化（索引未建）→ viaDecl=true 命中；声明与物化双命中不重复", async () => {
    const f = makeFixture();
    const declOnly = seedNode(f, f.projA, "声明未物化", "场景");
    const materialized = seedNode(f, f.projA, "已物化", "场景");
    f.write.write(f.projA, {
      kind: "declareAnchors",
      iterationId: "iter-aff",
      nodeId: declOnly,
      anchors: [{ scopeKind: "symbol", pattern: "src/bar.ts#doThing" }],
    });
    f.write.write(f.projA, {
      kind: "declareAnchors",
      iterationId: "iter-aff",
      nodeId: materialized,
      anchors: [{ scopeKind: "path", pattern: "src/foo.ts" }],
    });
    await seedAnchors(f, f.projA, [
      { nodeId: materialized, anchorKind: "path", anchorPath: "src/foo.ts", anchorSymbol: null },
    ]);

    const decl = f.query.affected("src/bar.ts#doThing");
    expect(decl).toHaveLength(1);
    expect(decl[0]).toMatchObject({ nodeId: declOnly, viaDecl: true, anchorPath: "src/bar.ts", anchorSymbol: "doThing" });

    const mat = f.query.affected("src/foo.ts");
    expect(mat).toHaveLength(1); // 物化命中优先——同节点不再出声明兑底行
    expect(mat[0]).toMatchObject({ nodeId: materialized, viaDecl: false });
  });
});

describe("⑤⑥ 工具面渲染 + absent 短路", () => {
  test("kg affected 渲染 name | scene | digest | kg get 指针；空 scene 不渲染 scene 段；无命中给提示", async () => {
    const f = makeFixture();
    const withScene = seedNode(f, f.projA, "有场景节点", "改动 foo 模块前");
    const noScene = f.write.write(f.projA, {
      kind: "createNode",
      iterationId: "iter-aff",
      id: "TR-OLD-1",
      draft: { kind: "rule", name: "无场景存量", digest: "存量摘要" },
    });
    if (!noScene.ok) throw new Error("seed failed");
    await seedAnchors(f, f.projA, [
      { nodeId: withScene, anchorKind: "path", anchorPath: "src/foo.ts", anchorSymbol: null },
      { nodeId: noScene.nodeId, anchorKind: "symbol", anchorPath: "src/foo.ts", anchorSymbol: "legacy" },
    ]);

    const out = await execText(f, { op: "affected", target: "src/foo.ts" });
    expect(out).toContain("**有场景节点** [rule]");
    expect(out).toContain("适用：改动 foo 模块前");
    expect(out).toContain(`kg get ${withScene}`);
    expect(out).toContain("**无场景存量** [rule]");
    // 空 scene 兑底：该节点条目不出现「适用」段（全块仅 1 处适用行，属有场景节点）
    expect(out.match(/适用：/g)).toHaveLength(1);
    expect(out).toContain(`kg get ${noScene.nodeId}`);

    const empty = await execText(f, { op: "affected", target: "src/nowhere.ts" });
    expect(empty).toContain("无命中");
  });

  test("target 缺失/空白 → 结构化报错；project 行伴随（多项目聚合面）", async () => {
    const f = makeFixture();
    await expect(execText(f, { op: "affected" })).rejects.toThrow("target");
    const node = seedNode(f, f.projA, "唯一节点", "场景");
    await seedAnchors(f, f.projA, [{ nodeId: node, anchorKind: "path", anchorPath: "src/foo.ts", anchorSymbol: null }]);
    const out = await execText(f, { op: "affected", target: "src/foo.ts" });
    expect(out).toContain("projA"); // project 伴随（跨项目聚合形态同 search）
  });
});
