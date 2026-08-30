import { describe, expect, test } from "bun:test";
import type { MatchedAnchor } from "../../src/domain/kg/attachment/scope-matcher";
import { matchAnchors } from "../../src/domain/kg/attachment/scope-matcher";
import { attachmentBlockChars, renderAttachment } from "../../src/domain/kg/attachment/render";
import { renderTaskSlice, selectTaskSlice, taskSliceChars, type TaskSliceRow } from "../../src/domain/kg/attachment/task-slice";
import type { AttachmentSnapshot, NodeDigestRow } from "../../src/domain/kg/types";

/**
 * U 层（纯函数）：索引面渲染 scene（R23 第 2 条——切片/📎 附着/search/
 * 锚反查全部渲染 scene；条目形态 name | scene | digest | kg get 指针）。
 *
 * 覆盖：
 * ① 附着块条目：scene 非空 → 渲染「适用：」段；空 scene（存量未回填）
 *    → 兑底省略 scene 段（不产生丑输出）；
 * ② 任务切片条目：同形态；多项目指针尾注不变；
 * ③ token 预算纪律：scene 计入预算（估算与渲染同源——scene 变长则块
 *    字符数变长，超硬顶贪心让位）；
 * ④ matchAnchors 命中行透传 scene（快照 → MatchedAnchor）。
 */

function anchor(scene: string, over: Partial<MatchedAnchor> = {}): MatchedAnchor {
  return {
    nodeId: "TR-1",
    kind: "rule",
    name: "写通道纪律",
    digest: "写语句只能落在白名单文件。",
    scene,
    domain: "path",
    layer: 4,
    ...over,
  };
}

function digestRow(scene: string, over: Partial<NodeDigestRow> = {}): NodeDigestRow {
  return {
    id: "TR-1",
    kind: "rule",
    name: "写通道纪律",
    digest: "写语句只能落在白名单文件。",
    scene,
    status: "confirmed",
    domain: "tech",
    ...over,
  };
}

describe("① 📎 附着块渲染 scene", () => {
  test("scene 非空 → 条目含「适用：」段（name | scene | digest | 指针形态）", () => {
    const out = renderAttachment({ anchors: [anchor("改动 kg 写路径前")] });
    expect(out).toContain("**写通道纪律** [rule] — 写语句只能落在白名单文件。");
    expect(out).toContain("适用：改动 kg 写路径前");
    expect(out).toContain("kg get TR-1");
  });

  test("空 scene → 兑底省略 scene 段（条目其余段不变，不留空行/占位）", () => {
    const out = renderAttachment({ anchors: [anchor("")] });
    expect(out).not.toContain("适用：");
    expect(out).toContain("**写通道纪律** [rule] — 写语句只能落在白名单文件。");
    expect(out).toContain("kg get TR-1");
  });
});

describe("② 任务切片渲染 scene", () => {
  const row = (scene: string): TaskSliceRow => ({ project: "/ws/helix", row: digestRow(scene) });

  test("scene 非空 → 条目含「适用：」段；空 scene → 省略；多项目指针尾注不变", () => {
    const out = renderTaskSlice([row("改 kg 前"), row("")], { multiProject: true });
    expect(out.match(/适用：/g)).toHaveLength(1);
    expect(out).toContain("适用：改 kg 前");
    expect(out).toContain("kg get TR-1（project: helix）");
  });
});

describe("③ token 预算：scene 计入（估算与渲染同源）", () => {
  test("scene 变长 → 块字符数同步变长（预算贪心让位面）", () => {
    const short = attachmentBlockChars([anchor("")]);
    const long = attachmentBlockChars([anchor("改动任何 kg 写通道相关文件之前都必须先读完本规则全文")]);
    expect(long).toBeGreaterThan(short);
    const sliceShort = taskSliceChars([{ project: "/p", row: digestRow("") }], { multiProject: false });
    const sliceLong = taskSliceChars([{ project: "/p", row: digestRow("很长很长的适用场景描述") }], { multiProject: false });
    expect(sliceLong).toBeGreaterThan(sliceShort);
  });

  test("scene 撑爆预算 → 超限条目让位（selectTaskSlice 硬顶纪律不变）", () => {
    const huge: TaskSliceRow = { project: "/p", row: digestRow("场".repeat(4000)) };
    const small: TaskSliceRow = { project: "/p", row: digestRow("", { id: "TR-2", name: "小节点" }) };
    const picked = selectTaskSlice([huge, small], new Set(), { multiProject: false });
    expect(picked.map((p) => p.row.id)).toEqual(["TR-2"]); // huge 让位，small 装入
  });
});

describe("④ matchAnchors 透传 scene（快照 → 命中行）", () => {
  test("L4 文件级命中的 MatchedAnchor 携带快照节点 scene", () => {
    const snapshot: AttachmentSnapshot = {
      nodes: [{ id: "TR-1", kind: "rule", name: "写通道纪律", digest: "d", scene: "改 kg 前", scopeKind: "path" }],
      fileAnchors: [{ nodeId: "TR-1", path: "src/a.ts" }],
      symbolAnchors: [],
      contains: [],
    };
    const matched = matchAnchors(
      { filePath: "src/a.ts", oldText: "x", newText: "y", editLineStart: 1, editLineEnd: 1, fileLines: ["y"] },
      snapshot,
    );
    expect(matched).toHaveLength(1);
    expect(matched[0]!.scene).toBe("改 kg 前");
  });
});
