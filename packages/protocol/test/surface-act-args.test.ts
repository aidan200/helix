/**
 * validateSurfaceActArgs 覆盖范围（F3a/B5）：未登记组合改显式拒绝。
 *
 * 原实现只覆盖「已登记形状」组合，未覆盖组合（shell×click、cli×任意动词）
 * 静默返回 undefined = 放行——调用方若跳过前置 isSurfaceVerb/Registry 校验即
 * 静默落空。现 default 分支返回显式校验错误（携该表面可用动词清单，模型可
 * 自纠），已登记组合行为不变。
 */
import { describe, expect, test } from "vitest";
import { validateSurfaceActArgs } from "../src/index";

describe("validateSurfaceActArgs：已登记组合（回归面，行为不变）", () => {
  test("shell × navigate 需 sessionId；合法 → undefined", () => {
    expect(validateSurfaceActArgs("shell", "navigate", { sessionId: "s-1" })).toBeUndefined();
    expect(validateSurfaceActArgs("shell", "navigate", { url: "https://x" })).toContain("args.sessionId");
  });

  test("browser 五动词形状各自校验通过", () => {
    expect(validateSurfaceActArgs("browser", "navigate", { url: "https://x" })).toBeUndefined();
    expect(validateSurfaceActArgs("browser", "click", { selector: "#a" })).toBeUndefined();
    expect(validateSurfaceActArgs("browser", "focus", { selector: "#a" })).toBeUndefined();
    expect(validateSurfaceActArgs("browser", "type", { selector: "#a", text: "x" })).toBeUndefined();
    expect(validateSurfaceActArgs("browser", "scroll", { y: 10 })).toBeUndefined();
    expect(validateSurfaceActArgs("browser", "click", {})).toContain("args.selector");
  });
});

describe("validateSurfaceActArgs：未登记组合（本批收紧面）", () => {
  test("shell × click（词表内动词但 shell 未注册）→ 显式拒绝并列出可用动词", () => {
    const err = validateSurfaceActArgs("shell", "click", { selector: "#a" });
    expect(err).toBeDefined();
    expect(err).toContain("click");
    expect(err).toContain("shell");
    expect(err).toContain("navigate"); // 可用动词清单（自纠指引）
  });

  test("cli × 任意动词 → 显式拒绝（cli 零注册动词，M3 补面前一律拒）", () => {
    const err = validateSurfaceActArgs("cli", "click", { selector: "#a" });
    expect(err).toBeDefined();
    expect(err).toContain("cli");
    expect(err).toContain("无");
  });
});
