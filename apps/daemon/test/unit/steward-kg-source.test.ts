/**
 * 管家 kg 只读检索面适配器单测（批A）：createStewardKgSource——
 * createKgTool 语义复用的薄壳增量三件：
 * 1. projectRoot 显式 → search 行过滤 / get 走 locate 按项目取（多项目同 id
 *    不串项目）；
 * 2. 缺省多项目 → 逐项目分块 + 「【项目 <名>】」头（空命中项目整块省略）；
 * 3. 栈未装配 → 抛中文引导错（管家执行体兜底转文本——本层不吞）。
 */
import { describe, expect, test } from "bun:test";
import type { KgQueryService } from "../../src/application/services/kg/KgQueryService";
import { createStewardKgSource } from "../../src/adapters/driven/tools/kg/StewardKgTool";

type QueryFace = Pick<KgQueryService, "search" | "get" | "locate">;

function row(id: string, name: string) {
  return { id, kind: "rule", name, digest: `${name} 摘要`, scene: "适用：测试", status: "active", domain: null };
}

function detailOf(id: string, name: string) {
  return {
    node: { id, kind: "rule", name, digest: `${name} 摘要`, scene: "适用：测试", body: `${name} 正文`, domain: null, layer: null, status: "active" },
    anchorDeclarations: [],
    materializedAnchors: [],
    edges: [],
    supersedeChain: [],
    changeLog: [],
  };
}

function fakeQuery(): QueryFace & { searches: string[] } {
  const hits = [
    { project: "/w/alpha", row: row("TR-1", "Alpha 规则") },
    { project: "/w/beta", row: row("TR-1", "Beta 同号节点") },
    { project: "/w/beta", row: row("E-2", "Beta 实体") },
  ] as unknown as ReturnType<QueryFace["search"]>;
  const details = new Map<string, { project: string; detail: ReturnType<typeof detailOf> }[]>([
    [
      "TR-1",
      [
        { project: "/w/alpha", detail: detailOf("TR-1", "Alpha 规则") },
        { project: "/w/beta", detail: detailOf("TR-1", "Beta 同号节点") },
      ],
    ],
    ["E-2", [{ project: "/w/beta", detail: detailOf("E-2", "Beta 实体") }]],
  ]);
  const searches: string[] = [];
  return {
    searches,
    search: (q: string) => {
      searches.push(q);
      return hits.filter((h) => (h as unknown as { row: { name: string; digest: string } }).row.name.includes(q) || (h as unknown as { row: { name: string; digest: string } }).row.digest.includes(q));
    },
    get: (nodeId: string) => (details.get(nodeId)?.[0] ?? null) as never,
    locate: (nodeId: string) => (details.get(nodeId) ?? []) as never,
  };
}

describe("createStewardKgSource（createKgTool 语义复用薄壳）", () => {
  test("显式 projectRoot：search 行过滤 + get 按项目取（同 id 不串项目）", async () => {
    const query = fakeQuery();
    const source = createStewardKgSource({ queryOf: () => query, kgProjects: () => ["/w/alpha", "/w/beta"] });
    const alpha = await source.search("规则", "/w/alpha");
    expect(alpha).toContain("Alpha 规则");
    expect(alpha).not.toContain("Beta");
    expect(alpha).toContain("kg get TR-1"); // digest+指针形态（createKgTool 同源渲染）
    const beta = await source.get("TR-1", "/w/beta");
    expect(beta).toContain("Beta 同号节点");
    expect(beta).not.toContain("Alpha 规则");
  });

  test("缺省多项目：逐项目分块带项目头，空命中项目省略", async () => {
    const query = fakeQuery();
    const source = createStewardKgSource({ queryOf: () => query, kgProjects: () => ["/w/alpha", "/w/beta", "/w/gamma"] });
    const text = await source.search("实体");
    expect(text).toContain("【项目 beta】");
    expect(text).not.toContain("【项目 alpha】"); // 空命中整块省略
    expect(text).not.toContain("【项目 gamma】");
    expect(text).toContain("Beta 实体");
  });

  test("缺省单项目：原样渲染（零项目头——与 createKgTool 逐字一致）", async () => {
    const query = fakeQuery();
    const source = createStewardKgSource({ queryOf: () => query, kgProjects: () => ["/w/alpha"] });
    const text = await source.search("规则");
    expect(text).not.toContain("【项目");
    expect(text).toContain("命中");
    expect(text).toContain("Alpha 规则");
  });

  test("栈未装配：抛中文引导错（执行体兜底转文本）", async () => {
    const source = createStewardKgSource({ queryOf: () => undefined, kgProjects: () => [] });
    await expect(source.search("规则")).rejects.toThrow("workspace");
    await expect(source.get("TR-1")).rejects.toThrow("workspace");
  });
});
