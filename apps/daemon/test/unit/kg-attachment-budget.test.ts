import { describe, expect, test } from "bun:test";
import type { MatchedAnchor } from "../../src/domain/kg/attachment/scope-matcher";
import {
  applyBudget,
  ATTACHMENT_TOKEN_BUDGET,
  seenKeyOf,
} from "../../src/domain/kg/attachment/budget";
import { renderAttachment } from "../../src/domain/kg/attachment/render";

/**
 * T1.2（CL-1 F1.2，AD-4/AD-13）：去重预算纯函数——会话级跨通道去重、
 * token 硬顶（渲染字符数/4）、特异性排序（符号域>路径域）、裁剪确定性。
 * F3 修复面：sessionSeen 键型 = `project\0nodeId` 复合键（seenKeyOf 口径）——
 * 多项目同 id 节点互不静默排除。
 */

/** 测试项目根（applyBudget 第四参——单次附着只读单项目快照）。 */
const PROJ = "/ws/projA";

function symbolAnchor(nodeId: string, name: string, digest: string): MatchedAnchor {
  return { nodeId, kind: "rule", name, digest, scene: "", domain: "symbol", layer: 1 };
}

function pathAnchor(nodeId: string, name: string, digest: string): MatchedAnchor {
  return { nodeId, kind: "rule", name, digest, scene: "", domain: "path", layer: 4 };
}

describe("applyBudget：会话级去重（CL-1.A3）", () => {
  test("sessionSeen 内的节点（复合键）不再入选", () => {
    const a = symbolAnchor("E-1", "render", "渲染入口。");
    const b = symbolAnchor("E-2", "dispose", "销毁纪律。");
    const sel = applyBudget([a, b], new Set([seenKeyOf(PROJ, "E-1")]), { maxTokens: ATTACHMENT_TOKEN_BUDGET }, PROJ);
    expect(sel.anchors.map((x) => x.nodeId)).toEqual(["E-2"]);
  });

  test("候选内部按 nodeId 去重（首个保留）", () => {
    const a = symbolAnchor("E-1", "render", "渲染入口。");
    const sel = applyBudget([a, a], new Set(), { maxTokens: ATTACHMENT_TOKEN_BUDGET }, PROJ);
    expect(sel.anchors.map((x) => x.nodeId)).toEqual(["E-1"]);
  });

  test("全部已见 → 空选择", () => {
    const a = symbolAnchor("E-1", "render", "渲染入口。");
    const sel = applyBudget([a], new Set([seenKeyOf(PROJ, "E-1")]), { maxTokens: ATTACHMENT_TOKEN_BUDGET }, PROJ);
    expect(sel.anchors).toEqual([]);
  });

  test("F3 键空间归一：他项目同 id 已见不排本项目（裸 id 键空间的静默误排不再发生）", () => {
    const a = symbolAnchor("E-1", "render", "渲染入口。");
    // 项目 B 的 E-1 已到达（复合键）——项目 A 的 E-1 是另一个知识节点，必须照常入选
    const seen = new Set([seenKeyOf("/ws/projB", "E-1")]);
    const sel = applyBudget([a], seen, { maxTokens: ATTACHMENT_TOKEN_BUDGET }, PROJ);
    expect(sel.anchors.map((x) => x.nodeId)).toEqual(["E-1"]);
    // 裸 id 形式的陈旧键不再匹配（键空间分裂根除——两侧同走 seenKeyOf）
    const stale = applyBudget([a], new Set(["E-1"]), { maxTokens: ATTACHMENT_TOKEN_BUDGET }, PROJ);
    expect(stale.anchors.map((x) => x.nodeId)).toEqual(["E-1"]);
  });
});

describe("applyBudget：特异性排序（CL-1.A4）", () => {
  test("符号域 > 路径域，与输入顺序无关", () => {
    const p = pathAnchor("TR-AD-78", "文件约束", "文件级。");
    const s = symbolAnchor("E-1", "render", "符号级。");
    const sel = applyBudget([p, s], new Set(), { maxTokens: ATTACHMENT_TOKEN_BUDGET }, PROJ);
    expect(sel.anchors.map((x) => x.nodeId)).toEqual(["E-1", "TR-AD-78"]);
  });

  test("同域按候选输入顺序稳定（稳定排序）", () => {
    const s1 = symbolAnchor("E-1", "render", "符号一。");
    const s2 = symbolAnchor("E-2", "dispose", "符号二。");
    const sel = applyBudget([s2, s1], new Set(), { maxTokens: ATTACHMENT_TOKEN_BUDGET }, PROJ);
    expect(sel.anchors.map((x) => x.nodeId)).toEqual(["E-2", "E-1"]);
  });
});

describe("applyBudget：token 硬顶", () => {
  test("ATTACHMENT_TOKEN_BUDGET 常量为 800", () => {
    expect(ATTACHMENT_TOKEN_BUDGET).toBe(800);
  });

  test("超限按特异性裁剪：预算只容一个时保留最高特异性（CL-1.A4）", () => {
    const long1 = symbolAnchor("E-1", "render", "长摘要一。".repeat(600)); // ~3000 字符/条目
    const long2 = symbolAnchor("E-2", "dispose", "长摘要二。".repeat(600));
    const pathLong = pathAnchor("TR-AD-78", "文件约束", "长摘要三。".repeat(600));
    const sel = applyBudget([pathLong, long1, long2], new Set(), {
      maxTokens: ATTACHMENT_TOKEN_BUDGET,
    }, PROJ);
    expect(sel.anchors.map((x) => x.nodeId)).toEqual(["E-1"]);
    // 渲染验证：入选块 token 估算（字符/4）确实 ≤ 硬顶
    const rendered = renderAttachment(sel);
    expect(rendered.length / 4).toBeLessThanOrEqual(ATTACHMENT_TOKEN_BUDGET);
  });

  test("预算内全保留；边界恰容时确定性裁剪", () => {
    const a = symbolAnchor("E-1", "render", "短摘要一。");
    const b = pathAnchor("TR-AD-78", "文件约束", "短摘要二。");
    const sel = applyBudget([a, b], new Set(), { maxTokens: ATTACHMENT_TOKEN_BUDGET }, PROJ);
    expect(sel.anchors.map((x) => x.nodeId)).toEqual(["E-1", "TR-AD-78"]);

    // 同输入两次调用结果一致（裁剪确定性）
    const sel2 = applyBudget([a, b], new Set(), { maxTokens: ATTACHMENT_TOKEN_BUDGET }, PROJ);
    expect(sel2).toEqual(sel);
  });

  test("极端硬顶：无任何候选可容 → 空选择（宁可沉默）", () => {
    const a = symbolAnchor("E-1", "render", "渲染入口。");
    const sel = applyBudget([a], new Set(), { maxTokens: 1 }, PROJ);
    expect(sel.anchors).toEqual([]);
  });

  test("路径域不挤占符号域：预算紧张时先裁路径域", () => {
    const s1 = symbolAnchor("E-1", "render", "摘要一。".repeat(200));
    const p1 = pathAnchor("TR-AD-78", "文件约束", "摘要二。".repeat(200));
    const sel = applyBudget([p1, s1], new Set(), { maxTokens: 400 }, PROJ);
    // s1 单独可容（~280 token），p1 加入即超 400 → 路径域让位
    expect(sel.anchors.map((x) => x.nodeId)).toEqual(["E-1"]);
  });
});
