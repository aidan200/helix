import { describe, expect, test } from "bun:test";
import type { MatchedAnchor } from "../../src/domain/kg/attachment/scope-matcher";
import type { AttachmentSelection } from "../../src/domain/kg/attachment/budget";
import {
  ATTACHMENT_PROTOCOL_LINE,
  renderAttachment,
} from "../../src/domain/kg/attachment/render";

/**
 * T1.2（CL-1 F1.2，AD-14）：📎 附着块渲染——digest+指针+协议行；
 * 空选择返回空串。
 */

function sel(anchors: MatchedAnchor[]): AttachmentSelection {
  return { anchors };
}

const A1: MatchedAnchor = {
  nodeId: "TR-AD-77",
  kind: "rule",
  name: "Renderer 约束",
  digest: "渲染必须走 Cyber HUD 体系，禁止另起风格。",
  scene: "",
  domain: "symbol",
  layer: 2,
};

const A2: MatchedAnchor = {
  nodeId: "E-1",
  kind: "entity",
  name: "render 入口",
  digest: "渲染入口实体，承接一次渲染调用的全部副作用。",
  scene: "",
  domain: "symbol",
  layer: 1,
};

describe("renderAttachment：块结构", () => {
  test("空选择渲染空串", () => {
    expect(renderAttachment(sel([]))).toBe("");
  });

  test("单节点：📎 前缀 + 粗体 name + kind 徽章 + digest + kg get 指针 + 协议行", () => {
    const out = renderAttachment(sel([A1]));
    expect(out.startsWith("📎")).toBe(true);
    expect(out).toContain("**Renderer 约束**");
    expect(out).toContain("[rule]");
    expect(out).toContain("渲染必须走 Cyber HUD 体系，禁止另起风格。");
    expect(out).toContain("kg get TR-AD-77");
    // 协议行收尾（AD-14 supersede 第一道防线）
    expect(out.trimEnd().endsWith(ATTACHMENT_PROTOCOL_LINE)).toBe(true);
  });

  test("多节点：逐节点条目 + 协议行共用一行且只出现一次", () => {
    const out = renderAttachment(sel([A1, A2]));
    expect(out).toContain("**Renderer 约束**");
    expect(out).toContain("**render 入口**");
    expect(out).toContain("kg get TR-AD-77");
    expect(out).toContain("kg get E-1");
    const count = out.split(ATTACHMENT_PROTOCOL_LINE).length - 1;
    expect(count).toBe(1);
    expect(out.trimEnd().endsWith(ATTACHMENT_PROTOCOL_LINE)).toBe(true);
  });

  test("协议行文案逐字符合 brief 契约", () => {
    expect(ATTACHMENT_PROTOCOL_LINE).toBe("若本次改动推翻此节点，随改动提交 supersede（kg-update）");
  });

  test("digest 多行（≤2 行）完整保留", () => {
    const twoLine: MatchedAnchor = {
      ...A1,
      digest: "第一行摘要。\n第二行摘要。",
    };
    const out = renderAttachment(sel([twoLine]));
    expect(out).toContain("第一行摘要。");
    expect(out).toContain("第二行摘要。");
  });
});
