/**
 * thinking-resolution 纯函数测试（P-2 展示位钳制；T2.2 RED）。
 *
 * 机械判据（brief 决策消解「换模轻提示」+ prototype resolveEffective 同源）：
 * - 配置档在能力集内 → 原档；
 * - 配置档超出能力上限 → 向下钳到最高被支持档（配置值本体不改写——本函数
 *   只产展示位，spawn 解析权威在 daemon）；
 * - 能力集空洞 → 钳到次低被支持档（不越档）；
 * - 配置档低于能力下限 → 最低被支持档；
 * - 空能力集 → null（UI 落禁用/加载位）；
 * - 未知档位字符串 → 展示位落最高被支持档（SoT 在 pi-ai，UI 不校验，AD-2）。
 */
import { describe, expect, it } from "vitest";
import { resolveEffectiveLevel } from "./thinking-resolution";

const SIX = ["minimal", "low", "medium", "high", "xhigh", "max"];
const TRI = ["low", "medium", "high"];

describe("resolveEffectiveLevel（P-2 配置档 → 槽位模型能力 展示位钳制）", () => {
  it("配置档在能力集内 → 原档", () => {
    expect(resolveEffectiveLevel(SIX, "high")).toBe("high");
    expect(resolveEffectiveLevel(SIX, "medium")).toBe("medium");
    expect(resolveEffectiveLevel(TRI, "low")).toBe("low");
  });

  it("配置档超出能力上限 → 向下钳到最高被支持档（xhigh/max → high）", () => {
    expect(resolveEffectiveLevel(TRI, "xhigh")).toBe("high");
    expect(resolveEffectiveLevel(TRI, "max")).toBe("high");
  });

  it("能力集空洞 → 钳到次低被支持档（xhigh → high，max 在场不越档）", () => {
    expect(resolveEffectiveLevel(["low", "medium", "high", "max"], "xhigh")).toBe("high");
  });

  it("配置档低于能力下限 → 最低被支持档（minimal → low）", () => {
    expect(resolveEffectiveLevel(TRI, "minimal")).toBe("low");
  });

  it("ghost 兜底位：medium 在场 → medium；不在场 → 向下钳", () => {
    expect(resolveEffectiveLevel(SIX, "medium")).toBe("medium");
    expect(resolveEffectiveLevel(["minimal", "low"], "medium")).toBe("low");
  });

  it("空能力集 → null", () => {
    expect(resolveEffectiveLevel([], "medium")).toBeNull();
  });

  it("未知档位字符串 → 展示位落最高被支持档（UI 不做档位校验，AD-2）", () => {
    expect(resolveEffectiveLevel(TRI, "ultra")).toBe("high");
  });
});
