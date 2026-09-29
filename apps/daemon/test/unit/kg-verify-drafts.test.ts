import { describe, expect, test } from "bun:test";
import type { AnchorDeclRow, KnowledgeNode, MaterializedAnchor } from "../../src/domain/kg/types";
import { classifyDrafts, type DraftScanInput } from "../../src/domain/kg/verify/drafts";

/**
 * U 层（P3 L0 读面）：draft 处置需求三分类——
 * ① ready：锚定就绪（≥1 活锚，或仅 global 刻意锚定）且 ≤7 天（只差裁决动作，④ 路）
 * ② stale：锚定就绪且 >7 天（ready 的超龄版，同一裁决通道，面板标积压）
 * ③ anchor-debt：锚定未就绪——无声明，或声明含 path/symbol 但无一活
 *    （全死/未物化；重挂与补挂同动作，死锚行另归 dead_anchor ① 路）
 * 豁免：非 draft 节点不列；仅 global 声明不算锚债但照走 ready/stale——
 * P3 首版一刀切豁免带声明草稿致 ④ 路输入恒空（2026-09-29 triage 首跑
 * 暴露），本用例组钉死修复。
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

  test("仅 global 声明（刻意锚定）不算锚债 → 照走 ready/stale，不豁免出裁决通道", () => {
    const fresh = node("TR-1", { createdAt: new Date(NOW - 2 * DAY).toISOString() });
    const old = node("TR-2", { createdAt: new Date(NOW - 12 * DAY).toISOString() });
    const items = classifyDrafts(scan({ nodes: [fresh, old], anchorDeclarations: [decl("TR-1"), decl("TR-2")] }));
    expect(items).toHaveLength(2);
    const byId = new Map(items.map((i) => [i.node.id, i]));
    expect(byId.get("TR-1")!.kind).toBe("ready");
    expect(byId.get("TR-2")!.kind).toBe("stale");
  });

  test("带活声明的草稿 → ready（修复钉死：P3 首版一刀切豁免吞掉 ready 类，④ 路输入恒空）", () => {
    // 现场复现：E-230/E-231——symbol 声明已物化为活锚，只差内容裁决
    const items = classifyDrafts(
      scan({
        nodes: [node("TR-1", { createdAt: new Date(NOW - 2 * DAY).toISOString() })],
        anchors: [anchor("TR-1")],
        anchorDeclarations: [decl("TR-1", { scopeKind: "symbol", pattern: "src/a.ts#foo" })],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("ready");
  });

  test("带声明但无一活（path/symbol 全死或未物化）→ anchor-debt（②③ 按声明豁免不报，③ 路须接住）", () => {
    const items = classifyDrafts(
      scan({
        nodes: [node("TR-1")],
        anchors: [anchor("TR-1", { orphan: true })],
        anchorDeclarations: [decl("TR-1", { scopeKind: "symbol", pattern: "src/a.ts#foo" })],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("anchor-debt");
    expect(items[0]!.declared).toBe(true); // ②③ 不报（声明豁免）——pendingCount 须独立计入
    expect(items[0]!.summary).toContain("重挂");
  });

  test("混合声明（global + 死 symbol）→ anchor-debt（global 不豁免死 path/symbol 锚债）", () => {
    const items = classifyDrafts(
      scan({
        nodes: [node("TR-1")],
        anchors: [anchor("TR-1", { orphan: true })],
        anchorDeclarations: [decl("TR-1"), decl("TR-1", { scopeKind: "symbol", pattern: "src/a.ts#foo" })],
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("anchor-debt");
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
