import { describe, expect, test } from "bun:test";
import type {
  AttachmentInput,
  AttachmentSnapshot,
  KgNodeDigestRow,
} from "../../src/domain/kg/types";
import { matchAnchors } from "../../src/domain/kg/attachment/scope-matcher";

/**
 * T1.2（CL-1 F1.1，AD-7 补充/AD-13）：附着四层递降匹配纯函数。
 * L1 方法级全等 → L2 contains 类上溯 → L3 span 保守兜底 → L4 文件级兜底；
 * 高层命中即短路；全程「宁可沉默不可错附」。
 */

const PATH = "src/render/Renderer.ts";
const OTHER = "src/other/Config.ts";

function node(
  id: string,
  name: string,
  digest: string,
  scopeKind: KgNodeDigestRow["scopeKind"],
  kind: KgNodeDigestRow["kind"] = "rule",
): KgNodeDigestRow {
  return { id, kind, name, digest, scene: "", scopeKind };
}

function snap(partial: Partial<AttachmentSnapshot> = {}): AttachmentSnapshot {
  return {
    nodes: [],
    fileAnchors: [],
    symbolAnchors: [],
    contains: [],
    ...partial,
  };
}

function input(partial: Partial<AttachmentInput> = {}): AttachmentInput {
  return {
    filePath: PATH,
    oldText: "",
    newText: "",
    editLineStart: 1,
    editLineEnd: 1,
    fileLines: [],
    ...partial,
  };
}

const RENDER_ANCHOR = {
  nodeId: "E-1",
  path: PATH,
  symbol: "render",
  span: { startLine: 10, endLine: 20 },
};

describe("锚域与防御性过滤", () => {
  test("只匹配本文件锚域：他文件符号锚（callee）不产生任何命中", () => {
    const s = snap({
      nodes: [node("E-9", "parseExternalConfig", "外部配置解析。", "symbol", "entity")],
      symbolAnchors: [{ nodeId: "E-9", path: OTHER, symbol: "parseExternalConfig" }],
    });
    const out = matchAnchors(
      input({ oldText: "const cfg = parseExternalConfig(opts);", newText: "" }),
      s,
    );
    expect(out).toEqual([]);
  });

  test("全局域节点不进附着：scopeKind=global 防御性过滤（CL-1.A4 反面）", () => {
    const s = snap({
      nodes: [node("TR-G", "全局规范", "全局规范不附着。", "global")],
      symbolAnchors: [{ nodeId: "TR-G", path: PATH, symbol: "render" }],
    });
    const out = matchAnchors(input({ oldText: "this.render()", newText: "" }), s);
    expect(out).toEqual([]);
  });

  test("快照缺字段（锚指向不存在节点行）→ 该锚沉默，不猜", () => {
    const s = snap({
      symbolAnchors: [{ nodeId: "GHOST", path: PATH, symbol: "render" }],
      fileAnchors: [{ nodeId: "TR-F", path: PATH }],
      nodes: [node("TR-F", "文件约束", "文件级约束。", "path")],
    });
    const out = matchAnchors(
      input({ oldText: "this.render()", newText: "", editLineStart: 50, editLineEnd: 51 }),
      s,
    );
    // GHOST 锚被丢弃 → 递降到 L4 文件锚
    expect(out.map((a) => a.nodeId)).toEqual(["TR-F"]);
    expect(out[0]!.layer).toBe(4);
  });
});

describe("L1 方法级精确命中", () => {
  test("正例：identifier 与锚 symbol 全等命中", () => {
    const s = snap({
      nodes: [node("E-1", "render 入口", "渲染入口实体。", "symbol", "entity")],
      symbolAnchors: [RENDER_ANCHOR],
    });
    const out = matchAnchors(input({ oldText: "this.render()", newText: "this.render()" }), s);
    expect(out.map((a) => a.nodeId)).toEqual(["E-1"]);
    expect(out[0]!.layer).toBe(1);
    expect(out[0]!.domain).toBe("symbol");
  });

  test("反例：无词边界的子串/前缀不命中（myrender ≠ render）", () => {
    const s = snap({
      nodes: [node("E-1", "render 入口", "渲染入口实体。", "symbol", "entity")],
      symbolAnchors: [RENDER_ANCHOR],
    });
    // 编辑行在 span 之外 → L3 也不兜底 → 沉默
    const out = matchAnchors(
      input({ oldText: "const myrender = 1;", newText: "", editLineStart: 40, editLineEnd: 41 }),
      s,
    );
    expect(out).toEqual([]);
  });

  test("词边界切分词参与全等（renderAll 产出 render 段）", () => {
    const s = snap({
      nodes: [node("E-1", "render 入口", "渲染入口实体。", "symbol", "entity")],
      symbolAnchors: [RENDER_ANCHOR],
    });
    const out = matchAnchors(input({ oldText: "renderAll()", newText: "" }), s);
    expect(out.map((a) => a.nodeId)).toEqual(["E-1"]);
  });

  test("多命中按 snapshot.nodes 顺序稳定输出并按 nodeId 去重", () => {
    const s = snap({
      // nodes 顺序：E-1 在前，E-2 在后
      nodes: [
        node("E-1", "render 入口", "渲染入口实体。", "symbol", "entity"),
        node("E-2", "dispose 生命周期", "销毁纪律。", "symbol", "entity"),
      ],
      symbolAnchors: [
        { nodeId: "E-2", path: PATH, symbol: "dispose" },
        { nodeId: "E-1", path: PATH, symbol: "render" },
        { nodeId: "E-1", path: PATH, symbol: "render" }, // 重复锚
      ],
    });
    const out = matchAnchors(input({ oldText: "this.dispose(); this.render();", newText: "" }), s);
    expect(out.map((a) => a.nodeId)).toEqual(["E-1", "E-2"]);
  });
});

describe("L2 类级上溯（contains 边）", () => {
  const rendererNode = node("TR-AD-77", "Renderer 约束", "渲染必须走 Cyber HUD。", "symbol");

  test("正例①：identifier 命中未锚定的成员符号 → 上溯到已锚定外层类", () => {
    const s = snap({
      nodes: [rendererNode],
      symbolAnchors: [{ nodeId: "TR-AD-77", path: PATH, symbol: "Renderer", span: { startLine: 1, endLine: 100 } }],
      contains: [
        { outer: "Renderer", inner: "dispose", file: PATH },
        { outer: "Renderer", inner: "render", file: PATH },
      ],
    });
    const out = matchAnchors(
      input({ oldText: "this.dispose()", newText: "", editLineStart: 200, editLineEnd: 201 }),
      s,
    );
    expect(out.map((a) => a.nodeId)).toEqual(["TR-AD-77"]);
    expect(out[0]!.layer).toBe(2);
  });

  test("正例②：identifier 直接等于类名且有锚 → 命中（经 L1 全等承载）", () => {
    const s = snap({
      nodes: [rendererNode],
      symbolAnchors: [{ nodeId: "TR-AD-77", path: PATH, symbol: "Renderer" }],
      contains: [{ outer: "Renderer", inner: "dispose", file: PATH }],
    });
    const out = matchAnchors(input({ oldText: "new Renderer()", newText: "" }), s);
    expect(out.map((a) => a.nodeId)).toEqual(["TR-AD-77"]);
  });

  test("反例：只沿 contains 边上溯，不猜测命名空间（他文件边不遍历）", () => {
    const s = snap({
      nodes: [rendererNode],
      symbolAnchors: [{ nodeId: "TR-AD-77", path: PATH, symbol: "Renderer" }],
      contains: [{ outer: "Renderer", inner: "dispose", file: OTHER }],
    });
    const out = matchAnchors(
      input({ oldText: "this.dispose()", newText: "", editLineStart: 200, editLineEnd: 201 }),
      s,
    );
    expect(out).toEqual([]);
  });

  test("反例：外层类无锚 → 不命中，不递归再上溯", () => {
    const s = snap({
      nodes: [rendererNode],
      symbolAnchors: [], // Renderer 未锚定
      contains: [
        { outer: "Renderer", inner: "dispose", file: PATH },
        { outer: "BaseRenderer", inner: "Renderer", file: PATH },
      ],
    });
    const out = matchAnchors(input({ oldText: "this.dispose()", newText: "" }), s);
    expect(out).toEqual([]);
  });

  test("短路：L1 命中时 L2 不再评估", () => {
    const s = snap({
      nodes: [rendererNode, node("E-2", "dispose 生命周期", "销毁纪律。", "symbol", "entity")],
      symbolAnchors: [
        { nodeId: "E-2", path: PATH, symbol: "dispose" },
        { nodeId: "TR-AD-77", path: PATH, symbol: "Renderer" },
      ],
      contains: [{ outer: "Renderer", inner: "dispose", file: PATH }],
    });
    // dispose 已锚定 → L1 命中 E-2；Renderer 不因 L2 重复入选
    const out = matchAnchors(input({ oldText: "this.dispose()", newText: "" }), s);
    expect(out.map((a) => a.nodeId)).toEqual(["E-2"]);
    expect(out[0]!.layer).toBe(1);
  });
});

describe("L3 span 保守兜底（仅 L1/L2 零命中时启用）", () => {
  test("正例：编辑区完整落入恰好一个符号 span", () => {
    const s = snap({
      nodes: [node("E-1", "render 入口", "渲染入口实体。", "symbol", "entity")],
      symbolAnchors: [RENDER_ANCHOR],
    });
    const out = matchAnchors(
      input({
        oldText: "const fooBar = 2;",
        newText: "const fooBar = 3;",
        editLineStart: 12,
        editLineEnd: 15,
        fileLines: new Array(30).fill("code"),
      }),
      s,
    );
    expect(out.map((a) => a.nodeId)).toEqual(["E-1"]);
    expect(out[0]!.layer).toBe(3);
  });

  test("CL-1.A5：编辑跨多符号 → 全部跳过", () => {
    const s = snap({
      nodes: [
        node("E-1", "render 入口", "渲染入口实体。", "symbol", "entity"),
        node("E-2", "dispose 生命周期", "销毁纪律。", "symbol", "entity"),
      ],
      symbolAnchors: [
        RENDER_ANCHOR,
        { nodeId: "E-2", path: PATH, symbol: "dispose", span: { startLine: 25, endLine: 35 } },
      ],
    });
    const out = matchAnchors(
      input({
        oldText: "x",
        newText: "y",
        editLineStart: 18, // 压 render 尾部，跨到 dispose 头部
        editLineEnd: 28,
        fileLines: new Array(40).fill("code"),
      }),
      s,
    );
    expect(out).toEqual([]);
  });

  test("嵌套 span（类含方法都锚定）→ 双候选 → 全部跳过", () => {
    const s = snap({
      nodes: [
        node("TR-AD-77", "Renderer 约束", "渲染必须走 Cyber HUD。", "symbol"),
        node("E-1", "render 入口", "渲染入口实体。", "symbol", "entity"),
      ],
      symbolAnchors: [
        { nodeId: "TR-AD-77", path: PATH, symbol: "Renderer", span: { startLine: 1, endLine: 100 } },
        RENDER_ANCHOR,
      ],
      contains: [{ outer: "Renderer", inner: "render", file: PATH }],
    });
    // 编辑文本不提任何锚定符号；12-15 同时落入两个 span → 不唯一 → 沉默
    const out = matchAnchors(
      input({
        oldText: "const fooBar = 2;",
        newText: "",
        editLineStart: 12,
        editLineEnd: 15,
        fileLines: new Array(30).fill("code"),
      }),
      s,
    );
    expect(out).toEqual([]);
  });

  test("边界同时压两符号 span（重叠 span）→ 跳过", () => {
    const s = snap({
      nodes: [
        node("E-1", "render 入口", "渲染入口实体。", "symbol", "entity"),
        node("E-2", "dispose 生命周期", "销毁纪律。", "symbol", "entity"),
      ],
      symbolAnchors: [
        { nodeId: "E-1", path: PATH, symbol: "render", span: { startLine: 1, endLine: 20 } },
        { nodeId: "E-2", path: PATH, symbol: "dispose", span: { startLine: 20, endLine: 40 } },
      ],
    });
    const out = matchAnchors(
      input({
        oldText: "z",
        newText: "w",
        editLineStart: 20, // 同时落入两个 span
        editLineEnd: 20,
        fileLines: new Array(40).fill("code"),
      }),
      s,
    );
    expect(out).toEqual([]);
  });

  test("span 陈旧（越界当前文件行数）→ 回扫唯一声明行校验通过则命中", () => {
    const fileLines = [
      "import path from 'node:path';",
      "",
      "function helperThing() {",
      "  return 1;",
      "}",
      "",
      "export function renderSection(opts) {",
      "  const fooBar = 1;",
      "  return fooBar;",
      "}",
      "const tailLine = 2;",
      "const tailLine2 = 3;",
      "const tailLine3 = 4;",
      "const tailLine4 = 5;",
      "const tailLine5 = 6;",
    ];
    const s = snap({
      nodes: [node("E-5", "renderSection", "区块渲染实体。", "symbol", "entity")],
      symbolAnchors: [
        // span 越界（endLine 50 > 文件 15 行）→ 陈旧
        { nodeId: "E-5", path: PATH, symbol: "renderSection", span: { startLine: 10, endLine: 50 } },
      ],
    });
    const out = matchAnchors(
      input({
        oldText: "const fooBar = 1;",
        newText: "const fooBar = 9;",
        editLineStart: 12, // 编辑行落在陈旧 span 内
        editLineEnd: 13,
        fileLines,
      }),
      s,
    );
    // 回扫窗口（起行 10 向上 ≤10 行）内 renderSection 声明唯一（第 7 行）→ 校验通过
    expect(out.map((a) => a.nodeId)).toEqual(["E-5"]);
    expect(out[0]!.layer).toBe(3);
  });

  test("span 陈旧且回扫声明行不唯一（撞双候选）→ 跳过", () => {
    const fileLines = [
      "function renderSection() {", // 第 1 行声明
      "}",
      "",
      "function renderSection() {", // 第 4 行同名声明 → 不唯一
      "}",
      "",
      "",
      "",
      "",
      "const tailLine = 1;",
      "const tailLine2 = 2;",
      "const tailLine3 = 3;",
      "const tailLine4 = 4;",
      "const tailLine5 = 5;",
    ];
    const s = snap({
      nodes: [node("E-5", "renderSection", "区块渲染实体。", "symbol", "entity")],
      symbolAnchors: [
        { nodeId: "E-5", path: PATH, symbol: "renderSection", span: { startLine: 10, endLine: 50 } },
      ],
    });
    const out = matchAnchors(
      input({
        oldText: "const tailLine = 1;",
        newText: "const tailLine = 9;",
        editLineStart: 12,
        editLineEnd: 13,
        fileLines,
      }),
      s,
    );
    expect(out).toEqual([]);
  });

  test("span 陈旧且回扫窗口无声明行 → 跳过（宁可沉默）", () => {
    const fileLines = new Array(15).fill("const plainLine = 1;");
    const s = snap({
      nodes: [node("E-5", "renderSection", "区块渲染实体。", "symbol", "entity")],
      symbolAnchors: [
        { nodeId: "E-5", path: PATH, symbol: "renderSection", span: { startLine: 10, endLine: 50 } },
      ],
    });
    const out = matchAnchors(
      input({
        oldText: "const plainLine = 1;",
        newText: "const plainLine = 2;",
        editLineStart: 12,
        editLineEnd: 13,
        fileLines,
      }),
      s,
    );
    expect(out).toEqual([]);
  });

  test("短路：L1 已命中时 L3 不再兜底", () => {
    const s = snap({
      nodes: [node("E-1", "render 入口", "渲染入口实体。", "symbol", "entity")],
      symbolAnchors: [RENDER_ANCHOR],
    });
    // 文本提 render（L1 命中）且编辑行也在 span 内 → 只有 L1 一条，不重复
    const out = matchAnchors(
      input({
        oldText: "this.render()",
        newText: "this.render()",
        editLineStart: 12,
        editLineEnd: 15,
        fileLines: new Array(30).fill("code"),
      }),
      s,
    );
    expect(out.length).toBe(1);
    expect(out[0]!.layer).toBe(1);
  });
});

describe("L4 文件级兜底", () => {
  test("正例：1-3 层全未命中且存在路径锚 → 路径域节点", () => {
    const s = snap({
      nodes: [node("TR-AD-78", "本文件约束", "本文件须保持纯函数。", "path")],
      fileAnchors: [{ nodeId: "TR-AD-78", path: PATH }],
    });
    const out = matchAnchors(
      input({ oldText: "const fooBar = 2;", newText: "", editLineStart: 3, editLineEnd: 4 }),
      s,
    );
    expect(out.map((a) => a.nodeId)).toEqual(["TR-AD-78"]);
    expect(out[0]!.domain).toBe("path");
    expect(out[0]!.layer).toBe(4);
  });

  test("短路：L1 命中时 L4 不并入（同快照两者并存）", () => {
    const s = snap({
      nodes: [
        node("E-1", "render 入口", "渲染入口实体。", "symbol", "entity"),
        node("TR-AD-78", "本文件约束", "本文件须保持纯函数。", "path"),
      ],
      symbolAnchors: [RENDER_ANCHOR],
      fileAnchors: [{ nodeId: "TR-AD-78", path: PATH }],
    });
    const out = matchAnchors(input({ oldText: "this.render()", newText: "" }), s);
    expect(out.map((a) => a.nodeId)).toEqual(["E-1"]);
  });

  test("无任何锚 → 空输出（零附着零成本）", () => {
    const out = matchAnchors(input({ oldText: "this.render()", newText: "" }), snap());
    expect(out).toEqual([]);
  });
});

describe("负例集：错附率=0（行号漂移/双候选/callee/锚域外）", () => {
  test("行号漂移跨符号（span 不含编辑区）→ 沉默", () => {
    const s = snap({
      nodes: [node("E-1", "render 入口", "渲染入口实体。", "symbol", "entity")],
      symbolAnchors: [RENDER_ANCHOR],
    });
    // 编辑区已漂移到 span 之外且文本无锚定符号
    const out = matchAnchors(
      input({
        oldText: "const fooBar = 2;",
        newText: "",
        editLineStart: 22,
        editLineEnd: 25,
        fileLines: new Array(30).fill("code"),
      }),
      s,
    );
    expect(out).toEqual([]);
  });

  test("空快照 / 缺字段子集 → 沉默不抛错", () => {
    const s = snap({
      nodes: [node("TR-AD-78", "本文件约束", "本文件须保持纯函数。", "path")],
      fileAnchors: [{ nodeId: "TR-AD-78", path: PATH }],
    });
    // editLine 无效（start > end）→ L3 跳过 → L4 兜底仍安全
    const out = matchAnchors(
      input({ oldText: "x", newText: "y", editLineStart: 30, editLineEnd: 2, fileLines: ["a"] }),
      s,
    );
    expect(out.map((a) => a.nodeId)).toEqual(["TR-AD-78"]);
  });
});
