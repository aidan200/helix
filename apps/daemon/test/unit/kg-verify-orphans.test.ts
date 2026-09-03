import { describe, expect, test } from "bun:test";
import type { AnchorDeclRow, KnowledgeNode, MaterializedAnchor } from "../../src/domain/kg/types";
import {
  findOrphanItems,
  ORPHAN_DRAFT_GRACE_MS,
  type OrphanScanInput,
} from "../../src/domain/kg/verify/orphans";

/**
 * U 层（CL-3.A6 判定面）：orphans 两口径——①物化锚 orphan=1（T2.2 符号
 * 消亡标记）②无锚无边孤儿节点（draft 新建 7 天宽限防误报）。
 */

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function node(id: string, over: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id,
    kind: "rule",
    name: `知识「${id === "TR-1" ? "分层依赖单向" : id === "TR-2" ? "写路径白名单" : id === "TR-3" ? "实体主代理" : id === "TR-4" ? "新近草稿" : "其余知识"}」`,
    digest: "摘要行",
    scene: "",
    body: "",
    domain: "tech",
    layer: null,
    status: "confirmed",
    createdAt: new Date(NOW - 90 * DAY).toISOString(),
    updatedAt: new Date(NOW - 90 * DAY).toISOString(),
    ...over,
  };
}

function anchor(nodeId: string, over: Partial<MaterializedAnchor> = {}): MaterializedAnchor {
  return { nodeId, anchorPath: "src/a.ts", anchorSymbol: "foo", anchorKind: "symbol", ...over };
}

function scan(over: Partial<OrphanScanInput> = {}): OrphanScanInput {
  return { nodes: [], edges: [], anchors: [], anchorDeclarations: [], now: NOW, ...over };
}

describe("domain/kg/verify/orphans：腐烂锚与孤儿节点判定（纯函数）", () => {
  test("① orphan 标记锚（符号锚/文件锚）→ dead_anchor 检出；superseded 节点的死锚不列（历史节点无需活锚）", () => {
    const live = node("TR-1");
    const retired = node("TR-2", { status: "superseded" });
    const items = findOrphanItems(
      scan({
        nodes: [live, retired],
        anchors: [
          anchor("TR-1", { anchorPath: "src/gone.ts", anchorSymbol: "deadFn", orphan: true }),
          anchor("TR-1", { anchorPath: "src/gone-file.ts", anchorSymbol: null, anchorKind: "path", orphan: true }),
          anchor("TR-2", { orphan: true }),
        ],
      }),
    );
    const dead = items.filter((i) => i.kind === "dead_anchor");
    expect(dead).toHaveLength(2);
    expect(dead.every((i) => i.node.id === "TR-1")).toBe(true);
    // 符号锚叙述：符号消亡 + 锚路径；文件锚叙述：文件消失
    const symbolOne = dead.find((i) => i.anchor.anchorSymbol === "deadFn")!;
    expect(symbolOne.summary).toContain("src/gone.ts#deadFn");
    expect(symbolOne.summary).toContain("知识「分层依赖单向」"); // 节点名（非裸 id）
    expect(symbolOne.summary).not.toMatch(/TR-\d+/);
    const pathOne = dead.find((i) => i.anchor.anchorKind === "path")!;
    expect(pathOne.summary).toContain("src/gone-file.ts");
  });

  test("② 活跃锚（orphan 未标/0）不误报", () => {
    const items = findOrphanItems(
      scan({ nodes: [node("TR-1")], anchors: [anchor("TR-1"), anchor("TR-1", { orphan: false })] }),
    );
    expect(items).toHaveLength(0);
  });

  test("③ 无锚无边孤儿节点（confirmed、久建）→ orphan_node 检出", () => {
    const items = findOrphanItems(scan({ nodes: [node("TR-1")] }));
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("orphan_node");
    expect(items[0]!.node.id).toBe("TR-1");
    expect(items[0]!.summary).toContain("知识「分层依赖单向」");
    expect(items[0]!.summary).not.toMatch(/TR-\d+/);
  });

  test("④ 宽限与豁免：draft 新建 7 天内不列；draft 超宽限/confirmed 均列；superseded 留史不列（与 dead_anchor 口径对称——CAND-3）", () => {
    const freshDraft = node("TR-1", { status: "draft", createdAt: new Date(NOW - 1 * DAY).toISOString() });
    const staleDraft = node("TR-2", { status: "draft", createdAt: new Date(NOW - (ORPHAN_DRAFT_GRACE_MS + DAY)).toISOString() });
    const freshConfirmed = node("TR-3", { createdAt: new Date(NOW - 1 * DAY).toISOString() });
    const retired = node("TR-4", { status: "superseded" }); // 留史节点：无活锚是常态，不列孤儿
    const items = findOrphanItems(scan({ nodes: [freshDraft, staleDraft, freshConfirmed, retired] }));
    expect(items.map((i) => i.node.id)).toEqual(["TR-2", "TR-3"]); // 宽限期边界外全列；superseded 不列
  });

  test("⑥ M1：draft createdAt 不可解析（NaN）→ 防御跳过不列孤儿（对齐 activity-mismatch 口径）", () => {
    const broken = node("TR-1", { status: "draft", createdAt: "not-a-date" });
    const staleDraft = node("TR-2", { status: "draft", createdAt: new Date(NOW - (ORPHAN_DRAFT_GRACE_MS + DAY)).toISOString() });
    const items = findOrphanItems(scan({ nodes: [broken, staleDraft] }));
    expect(items.map((i) => i.node.id)).toEqual(["TR-2"]); // 时间戳不可解析防御跳过；正常超宽限仍列
  });

  test("⑤ 有边（入/出任一）、有锚（含死锚）、有作用域声明（global 等）→ 均不列 orphan_node", () => {
    const edgeful = node("TR-1");
    const anchored = node("TR-2");
    const declared = node("TR-3");
    const deadAnchored = node("TR-4");
    const items = findOrphanItems(
      scan({
        nodes: [edgeful, anchored, declared, deadAnchored],
        edges: [
          { srcId: "TR-9", verb: "governs", dstId: "TR-1" }, // 入边即可
        ],
        anchors: [anchor("TR-2"), anchor("TR-4", { orphan: true })], // 死锚也是「有锚」（其失效由 dead_anchor 口径负责）
        anchorDeclarations: [{ nodeId: "TR-3", scopeKind: "global", pattern: "" } as AnchorDeclRow],
      }),
    );
    expect(items.filter((i) => i.kind === "orphan_node")).toHaveLength(0);
    expect(items.filter((i) => i.kind === "dead_anchor")).toHaveLength(1); // TR-4 死锚由 ① 口径列
  });

  test("⑥ 混合输出顺序确定：dead_anchor（按 nodeId/路径/符号序）在前，orphan_node（按 id 序）在后", () => {
    const input = scan({
      nodes: [node("TR-2"), node("TR-1"), node("TR-3")],
      anchors: [anchor("TR-1", { anchorPath: "src/b.ts", orphan: true }), anchor("TR-1", { anchorPath: "src/a.ts", orphan: true })],
    });
    const first = findOrphanItems(input);
    expect(first.map((i) => i.kind)).toEqual(["dead_anchor", "dead_anchor", "orphan_node", "orphan_node"]);
    const dead = first.filter((i) => i.kind === "dead_anchor");
    expect(dead.map((i) => i.anchor.anchorPath)).toEqual(["src/a.ts", "src/b.ts"]); // 路径序
    const orphans = first.filter((i) => i.kind === "orphan_node");
    expect(orphans.map((i) => i.node.id)).toEqual(["TR-2", "TR-3"]); // id 序
    expect(findOrphanItems(input)).toEqual(first);
  });
});
