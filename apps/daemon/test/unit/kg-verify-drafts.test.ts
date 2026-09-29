import { describe, expect, test } from "bun:test";
import type { AnchorDeclRow, KnowledgeNode, MaterializedAnchor } from "../../src/domain/kg/types";
import { classifyDrafts, type DraftScanInput } from "../../src/domain/kg/verify/drafts";

/**
 * U 层（P3 L0 读面）：draft 处置需求三分类——
 * ① ready：有活锚且 ≤7 天（只差裁决动作，triage ④ 路输入）
 * ② stale：有活锚且 >7 天（ready 的超龄版，同一裁决通道，面板标积压）
 * ③ anchor-debt：无活锚且无锚声明（先挂锚再裁决——triage ③ 路输入；
 *    全死锚也归此类：重挂与补挂是同一动作，死锚本身另归 dead_anchor ① 路）
 * 豁免口径与 findOrphanItems ②③ 对齐：有锚声明（global 等刻意锚定决策）
 * 不列；非 draft 节点不列（本读面只管草稿）。
 */

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function node(id: string, over: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id,
    kind: "rule",
    name: `知识「${id === "TR-1" ? "分层依赖单向" : id === "TR-2" ? "写路径白名单" : id === "TR-3" ? "实体主代理" : `规则${id.slice(3)}号`}」`,
    digest: "摘要行",
    scene: "",
    body: "",
    domain: "tech",
    layer: null,
    status: "draft",
    createdAt: new Date(NOW - 90 * DAY).toISOString(),
    updatedAt: new Date(NOW - 90 * DAY).toISOString(),
    ...over,
  };
}

function anchor(nodeId: string, over: Partial<MaterializedAnchor> = {}): MaterializedAnchor {
  return { nodeId, anchorPath: "src/a.ts", anchorSymbol: "foo", anchorKind: "symbol", ...over };
}

function decl(nodeId: string, over: Partial<AnchorDeclRow> = {}): AnchorDeclRow {
  return { nodeId, scopeKind: "global", pattern: "", ...over };
}

function scan(over: Partial<DraftScanInput> = {}): DraftScanInput {
  return { nodes: [], anchors: [], anchorDeclarations: [], now: NOW, ...over };
}

describe("domain/kg/verify/drafts：draft 处置需求三分类（纯函数）", () => {
  test("ready：新近草稿 + 活锚 → 只差裁决", () => {
    const items = classifyDrafts(scan({ nodes: [node("TR-1", { createdAt: new Date(NOW - 2 * DAY).toISOString() })], anchors: [anchor("TR-1")] }));
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("ready");
    expect(items[0]!.ageDays).toBe(2);
    expect(items[0]!.summary).toContain("分层依赖单向");
    expect(items[0]!.summary).not.toMatch(/TR-\d+/); // 节点名叙述非裸 id（AD-16）
  });

  test("stale：超 7 天宽限的活锚草稿 → 积压信号", () => {
    const items = classifyDrafts(scan({ nodes: [node("TR-1", { createdAt: new Date(NOW - 12 * DAY).toISOString() })], anchors: [anchor("TR-1")] }));
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("stale");
    expect(items[0]!.ageDays).toBe(12);
  });

  test("宽限边界：恰好 7 天 = stale（>= 宽限，与孤儿检测 passesDraftGrace 同语义）", () => {
    const items = classifyDrafts(scan({ nodes: [node("TR-1", { createdAt: new Date(NOW - 7 * DAY).toISOString() })], anchors: [anchor("TR-1")] }));
    expect(items[0]!.kind).toBe("stale");
  });

  test("anchor-debt：无锚无声明草稿（含全死锚——重挂与补挂同动作）", () => {
    const bare = node("TR-1");
    const allDead = node("TR-2", { createdAt: new Date(NOW - 2 * DAY).toISOString() });
    const items = classifyDrafts(scan({ nodes: [bare, allDead], anchors: [anchor("TR-2", { orphan: true })] }));
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === "anchor-debt")).toBe(true);
  });

  test("豁免：非 draft 节点不列（本读面只管草稿）", () => {
    const items = classifyDrafts(scan({ nodes: [node("TR-1", { status: "confirmed" })] }));
    expect(items).toHaveLength(0);
  });

  test("豁免：有锚声明的草稿不列（global 等刻意锚定决策，与 ②③ 豁免口径对齐）", () => {
    const items = classifyDrafts(scan({ nodes: [node("TR-1")], anchorDeclarations: [decl("TR-1")] }));
    expect(items).toHaveLength(0);
  });

  test("混合锚：活锚 + 死锚并存 → ready/stale（内容裁决不被死锚阻塞；死锚另归 dead_anchor 路）", () => {
    const items = classifyDrafts(scan({ nodes: [node("TR-1", { createdAt: new Date(NOW - 1 * DAY).toISOString() })], anchors: [anchor("TR-1"), anchor("TR-1", { anchorPath: "src/gone.ts", anchorSymbol: "deadFn", orphan: true })] }));
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("ready");
  });

  test("createdAt 不可解析（NaN 防御）→ 按 stale 列（可见性优先：错列可裁决，漏列永不消化）；ageDays = null", () => {
    const items = classifyDrafts(scan({ nodes: [node("TR-1", { createdAt: "not-a-date" })], anchors: [anchor("TR-1")] }));
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("stale");
    expect(items[0]!.ageDays).toBeNull();
  });

  test("输出顺序确定：按节点 id 升序", () => {
    const items = classifyDrafts(
      scan({
        nodes: [
          node("TR-9", { createdAt: new Date(NOW - 2 * DAY).toISOString() }),
          node("TR-2", { createdAt: new Date(NOW - 2 * DAY).toISOString() }),
          node("TR-10", { createdAt: new Date(NOW - 2 * DAY).toISOString() }),
        ],
        anchors: [anchor("TR-9"), anchor("TR-2"), anchor("TR-10")],
      }),
    );
    expect(items.map((i) => i.node.id)).toEqual(["TR-10", "TR-2", "TR-9"]);
  });

  test("summary 含分类专属叙述（ready=可裁决 / stale=积压 / anchor-debt=需挂锚）", () => {
    const items = classifyDrafts(
      scan({
        nodes: [
          node("TR-1", { createdAt: new Date(NOW - 2 * DAY).toISOString() }),
          node("TR-2", { createdAt: new Date(NOW - 12 * DAY).toISOString() }),
          node("TR-3"),
        ],
        anchors: [anchor("TR-1"), anchor("TR-2")],
      }),
    );
    const byId = new Map(items.map((i) => [i.node.id, i]));
    expect(byId.get("TR-1")!.summary).toContain("裁决");
    expect(byId.get("TR-2")!.summary).toContain("积压");
    expect(byId.get("TR-3")!.summary).toContain("挂锚");
  });
});
