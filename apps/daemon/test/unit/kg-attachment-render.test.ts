import { describe, expect, test } from "bun:test";
import type { MatchedAnchor } from "../../src/domain/kg/attachment/scope-matcher";
import type { AttachmentSelection } from "../../src/domain/kg/attachment/budget";
import {
  ATTACHMENT_PROTOCOL_LINE,
  ATTACHMENT_PROTOCOL_LINE_WORKER,
  renderAttachment,
} from "../../src/domain/kg/attachment/render";
import { renderTaskSlice } from "../../src/domain/kg/attachment/task-slice";

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

describe("W-R6 协议行角色分叉：main 版 kg-update 直落 / worker 版 closure findings 申报", () => {
  test("worker 版常量文案（SubAgent 无 kg-update——supersede 声明改走 closure findings）", () => {
    expect(ATTACHMENT_PROTOCOL_LINE_WORKER).toBe(
      "若本次改动推翻此节点，将 supersede 声明写入 closure findings",
    );
    // 两版互斥：worker 版不含 kg-update 引导（收权后 worker 面注册不到该工具）
    expect(ATTACHMENT_PROTOCOL_LINE_WORKER).not.toContain("kg-update");
    // main 版维持 kg-update 措辞（主会话持即时落账面）
    expect(ATTACHMENT_PROTOCOL_LINE).toContain("kg-update");
  });

  test("renderAttachment（edit 附着通道 = 主会话）：恒 main 版协议行", () => {
    const out = renderAttachment(sel([A1]));
    expect(out).toContain(ATTACHMENT_PROTOCOL_LINE);
    expect(out).not.toContain(ATTACHMENT_PROTOCOL_LINE_WORKER);
  });

  test("renderTaskSlice（任务切片通道双受众）：options.protocolLine 分叉，缺省 main 版", () => {
    const rows = [
      {
        project: "/ws/demo",
        row: {
          id: "TR-1",
          kind: "rule" as const,
          name: "写通道唯一",
          digest: "kg 写入必须走 KgWriteService。",
          scene: "",
          status: "active" as const,
          domain: null,
        },
      },
    ];
    const mainOut = renderTaskSlice(rows, { multiProject: false });
    expect(mainOut.trimEnd().endsWith(ATTACHMENT_PROTOCOL_LINE)).toBe(true);

    const workerOut = renderTaskSlice(rows, {
      multiProject: false,
      protocolLine: ATTACHMENT_PROTOCOL_LINE_WORKER,
    });
    expect(workerOut.trimEnd().endsWith(ATTACHMENT_PROTOCOL_LINE_WORKER)).toBe(true);
    expect(workerOut).not.toContain(ATTACHMENT_PROTOCOL_LINE);
  });
});
