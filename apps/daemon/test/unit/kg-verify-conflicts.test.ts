import { describe, expect, test } from "bun:test";
import type { KnowledgeNode, NodeId } from "../../src/domain/kg/types";
import {
  findEdgeConflicts,
  type ConflictScanInput,
} from "../../src/domain/kg/verify/conflicts";

/**
 * U 层（CL-3.A6 前半；AD-6 只列不修的判定面）：conflicts 机械确定性判定
 * ——①A governs B 且 B governs A（双向矛盾）②verb 不在封闭词表 ③自环边。
 * 叙述面无裸 id（AD-16 纪律在判定层即生效）。
 */

const DAY = 86_400_000;

function node(id: string, over: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id,
    kind: "rule",
    name: `知识-${id === "TR-1" ? "分层依赖单向" : id === "TR-2" ? "双向往返" : "其余规则"}`,
    digest: "摘要第一行\n摘要第二行",
    scene: "",
    body: "",
    domain: "tech",
    layer: null,
    status: "confirmed",
    createdAt: new Date(Date.now() - 30 * DAY).toISOString(),
    updatedAt: new Date(Date.now() - 30 * DAY).toISOString(),
    ...over,
  };
}

function scan(nodes: KnowledgeNode[], edges: { srcId: string; verb: string; dstId: string }[]): ConflictScanInput {
  return { edges, nodesById: new Map<NodeId, KnowledgeNode>(nodes.map((n) => [n.id, n])) };
}

describe("domain/kg/verify/conflicts：机械确定性判定（纯函数）", () => {
  test("① 双向 governs 矛盾：A governs B 且 B governs A → 单条 mutual_governs 检出（含两边与两节点引用）", () => {
    const nodes = [node("TR-1"), node("TR-2"), node("TR-3")];
    const input = scan(nodes, [
      { srcId: "TR-1", verb: "governs", dstId: "TR-2" },
      { srcId: "TR-2", verb: "governs", dstId: "TR-1" },
      { srcId: "TR-1", verb: "governs", dstId: "TR-3" }, // 单向合法边
    ]);
    const items = findEdgeConflicts(input);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("mutual_governs");
    expect(items[0]!.edges).toHaveLength(2);
    expect(items[0]!.nodes.map((n) => n.id).sort()).toEqual(["TR-1", "TR-2"]);
    // 叙述句含两个节点名 + 双向矛盾语义（无裸 id）
    expect(items[0]!.summary).toContain("分层依赖单向");
    expect(items[0]!.summary).toContain("双向往返");
    expect(items[0]!.summary).toContain("governs");
    expect(items[0]!.summary).not.toMatch(/TR-\d+/);
  });

  test("② 无矛盾（单向 governs / references / dependsOn 全词表内）→ 零检出", () => {
    const nodes = [node("TR-1"), node("TR-2"), node("TR-3")];
    const items = findEdgeConflicts(
      scan(nodes, [
        { srcId: "TR-1", verb: "governs", dstId: "TR-2" },
        { srcId: "TR-1", verb: "references", dstId: "TR-3" },
        { srcId: "TR-3", verb: "dependsOn", dstId: "TR-2" },
      ]),
    );
    expect(items).toHaveLength(0);
  });

  test("③ 词表外 verb（封闭词表破坏）→ unknown_verb 检出，叙述含越界动词与词表", () => {
    const nodes = [node("TR-1"), node("TR-2")];
    const items = findEdgeConflicts(scan(nodes, [{ srcId: "TR-1", verb: "relatesTo", dstId: "TR-2" }]));
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("unknown_verb");
    expect(items[0]!.summary).toContain("relatesTo");
    expect(items[0]!.summary).toContain("governs"); // 词表枚举提示
    expect(items[0]!.summary).not.toMatch(/TR-\d+/);
  });

  test("④ 自环边（src=dst）→ self_loop 检出", () => {
    const nodes = [node("TR-1")];
    const items = findEdgeConflicts(scan(nodes, [{ srcId: "TR-1", verb: "references", dstId: "TR-1" }]));
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("self_loop");
    expect(items[0]!.summary).toContain("分层依赖单向");
    expect(items[0]!.summary).not.toMatch(/TR-\d+/);
  });

  test("⑤ 混合输入：三类各检出且顺序确定；同输入两次调用结果逐字相等", () => {
    const nodes = [node("TR-1"), node("TR-2"), node("TR-3")];
    const input = scan(nodes, [
      { srcId: "TR-1", verb: "relatesTo", dstId: "TR-2" },
      { srcId: "TR-1", verb: "governs", dstId: "TR-2" },
      { srcId: "TR-2", verb: "governs", dstId: "TR-1" },
      { srcId: "TR-3", verb: "references", dstId: "TR-3" },
    ]);
    const first = findEdgeConflicts(input);
    expect(first.map((i) => i.kind)).toEqual(["mutual_governs", "self_loop", "unknown_verb"]);
    expect(findEdgeConflicts(input)).toEqual(first); // 确定性
  });

  test("⑥ 节点引用形态（AD-16）：nodes 携带 name/kind/digestFirstLine，id 仅供链接", () => {
    const nodes = [node("TR-1", { digest: "首行甲\n次行乙" }), node("TR-2")];
    const items = findEdgeConflicts(scan(nodes, [{ srcId: "TR-1", verb: "owns", dstId: "TR-2" }]));
    const ref = items[0]!.nodes.find((n) => n.id === "TR-1");
    expect(ref).toEqual({ id: "TR-1", name: "知识-分层依赖单向", kind: "rule", digestFirstLine: "首行甲" });
  });
});
