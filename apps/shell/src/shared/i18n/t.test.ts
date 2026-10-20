/**
 * i18n t() 取词判定测试：缺词 = undefined（非 falsy）。
 *
 * 空串是「显式留空」的合法词条值——旧实现用 `!value` 判定，空串被当缺词回退
 * key 并打 DEV missing-key 警告；判定面按语义收口为 undefined 比较。
 */
import { describe, expect, it } from "vitest";
import { t } from "./index";
import type { Translations } from "./lang/zh-CN";

const dict = { chat: { empty: "", solid: "共 {n} 条" } } as unknown as Translations;

describe("t() 取词判定", () => {
  it("空串词条 → 返回空串（不回退 key、不误判缺词）", () => {
    expect(t(dict, "chat.empty")).toBe("");
  });

  it("缺 key → 回退 key 本身", () => {
    expect(t(dict, "chat.missing")).toBe("chat.missing");
    expect(t(dict, "chat.solid.deep")).toBe("chat.solid.deep");
  });

  it("插值照常（空串不带变量也零副作用）", () => {
    expect(t(dict, "chat.solid", { n: 3 })).toBe("共 3 条");
    expect(t(dict, "chat.empty", { n: 3 })).toBe("");
  });
});
