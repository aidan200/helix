import { describe, expect, it } from "bun:test";
import {
  MAX_RESIDENT_RULES,
  renderResidentRules,
  RESIDENT_RULES_HEADER,
  type ResidentRuleRow,
} from "../../src/domain/kg/attachment/resident-rules";

function row(overrides: Partial<ResidentRuleRow["row"]> = {}, project = "/w/helix"): ResidentRuleRow {
  return {
    project,
    row: {
      id: "TR-57",
      kind: "rule",
      name: "声明式锚与物化锚分离",
      scene: "适用于：改动锚声明或物化管道前",
      ...overrides,
    },
  };
}

describe("renderResidentRules（常驻规则索引渲染）", () => {
  it("空集返回 null（段整体省略，零注入痕迹）", () => {
    expect(renderResidentRules([], { multiProject: false })).toBeNull();
  });

  it("全部条目 scene 为空时同样返回 null（无触达价值不产出段）", () => {
    expect(renderResidentRules([row({ scene: "" }), row({ scene: "  " })], { multiProject: false })).toBeNull();
  });

  it("标题 + 两句引导语 + 条目形态（name/kind/id + 适用 + 指针，无 digest/正文）", () => {
    const out = renderResidentRules([row()], { multiProject: false })!;
    const lines = out.split("\n");
    expect(lines[0]).toBe(RESIDENT_RULES_HEADER + "：");
    expect(lines[1]).toContain("仅列名称与适用场景");
    expect(lines[2]).toContain("kg");
    expect(out).toContain("- **声明式锚与物化锚分离** [rule] TR-57");
    expect(out).toContain("  适用：适用于：改动锚声明或物化管道前");
    expect(out).toContain("  ↳ kg get TR-57");
  });

  it("单项目指针行不带项目尾注；多项目带 project 名", () => {
    const single = renderResidentRules([row()], { multiProject: false })!;
    expect(single).toContain("  ↳ kg get TR-57");
    expect(single).not.toContain("project:");
    const multi = renderResidentRules([row()], { multiProject: true })!;
    expect(multi).toContain("↳ kg get TR-57（project: helix）");
  });

  it("scene 多行折单行；超长截断加省略号", () => {
    const multiline = renderResidentRules([row({ scene: "适用于：A\nB" })], { multiProject: false })!;
    expect(multiline).toContain("  适用：适用于：A B");

    const long = "适".repeat(200);
    const truncated = renderResidentRules([row({ scene: long })], { multiProject: false })!;
    expect(truncated).toContain("适".repeat(120) + "…");
    expect(truncated).not.toContain("适".repeat(121));
  });

  it("条数超过上限截断（确定性取前 MAX 条）", () => {
    const rows = Array.from({ length: MAX_RESIDENT_RULES + 5 }, (_, i) =>
      row({ id: `TR-${i}`, scene: `适用于：规则${i}` }),
    );
    const out = renderResidentRules(rows, { multiProject: false })!;
    expect(out.match(/↳ kg get TR-/g)?.length).toBe(MAX_RESIDENT_RULES);
    expect(out).toContain(`kg get TR-0`);
    expect(out).toContain(`kg get TR-${MAX_RESIDENT_RULES - 1}`);
    expect(out).not.toContain(`kg get TR-${MAX_RESIDENT_RULES}`);
  });

  it("scene 空条目跳过后其余条目仍渲染（不因单条空段丢失）", () => {
    const out = renderResidentRules([row({ id: "TR-A", scene: "" }), row({ id: "TR-B" })], {
      multiProject: false,
    })!;
    expect(out).not.toContain("TR-A");
    expect(out).toContain("TR-B");
  });
});
