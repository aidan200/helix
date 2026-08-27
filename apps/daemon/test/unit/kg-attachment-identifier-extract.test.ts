import { describe, expect, test } from "bun:test";
import {
  extractIdentifiers,
  RESERVED_WORDS,
} from "../../src/domain/kg/attachment/identifier-extract";

/**
 * T1.2（CL-1 F1.1）：标识符提取纯函数——分词 / 保留字过滤 / camelCase·snake_case
 * 双产出 / 边界（空串、纯符号）。
 * 决策消解：标识符 = `[A-Za-z_$][A-Za-z0-9_$]*` 且长度≥3 且不在保留字表。
 */

describe("extractIdentifiers：基础分词", () => {
  test("常规代码分词并过滤长度<3 的词", () => {
    const ids = extractIdentifiers("const renderer = createFoo();", "");
    expect(ids.has("renderer")).toBe(true);
    expect(ids.has("createFoo")).toBe(true);
    expect(ids.has("const")).toBe(false); // 保留字
    // "ab" 长度 2 不出现
    const ids2 = extractIdentifiers("let ab = 1;", "");
    expect(ids2.size).toBe(0);
  });

  test("oldText 与 newText 取并集", () => {
    const ids = extractIdentifiers("applyBudgetOne", "renderQueue");
    expect(ids.has("applyBudgetOne")).toBe(true);
    expect(ids.has("renderQueue")).toBe(true);
  });

  test("数字开头的词不匹配（正则首字符约束）", () => {
    const ids = extractIdentifiers("123abc foo1", "");
    expect(ids.has("123abc")).toBe(false);
    expect(ids.has("foo1")).toBe(true);
  });

  test("边界：空串 / 纯符号 / 纯保留字 → 空集合", () => {
    expect(extractIdentifiers("", "").size).toBe(0);
    expect(extractIdentifiers("((())) {} +++", "").size).toBe(0);
    expect(extractIdentifiers("return this", "").size).toBe(0);
  });
});

describe("extractIdentifiers：保留字表", () => {
  test("JS/TS 关键字被过滤", () => {
    const ids = extractIdentifiers(
      "function return class const export import interface typeof instanceof",
      "",
    );
    expect(ids.size).toBe(0);
  });

  test("字面量与上下文噪声词被过滤（true/false/null/undefined/this 等）", () => {
    const ids = extractIdentifiers(
      "true false null undefined this super async await",
      "",
    );
    expect(ids.size).toBe(0);
  });

  test("常见全局名被过滤（console/window 等，表内定义）", () => {
    const ids = extractIdentifiers("console window process document", "");
    expect(ids.size).toBe(0);
    // 表内代表性成员直接断言（表在实现中定义并测试）
    for (const w of ["console", "window", "return", "this", "undefined"]) {
      expect(RESERVED_WORDS.has(w)).toBe(true);
    }
  });
});

describe("extractIdentifiers：camelCase / snake_case 双产出", () => {
  test("camelCase：原词与切分词均入集合（brief 示例）", () => {
    const ids = extractIdentifiers("withFileMutationQueue", "");
    expect(ids.has("withFileMutationQueue")).toBe(true);
    // 切分词 File / Mutation / Queue 均入集合（with 为保留字）
    expect(ids.has("File")).toBe(true);
    expect(ids.has("Mutation")).toBe(true);
    expect(ids.has("Queue")).toBe(true);
    expect(ids.has("with")).toBe(false);
  });

  test("snake_case：原词与下划线分段词均入集合", () => {
    const ids = extractIdentifiers("apply_budget_now", "");
    expect(ids.has("apply_budget_now")).toBe(true);
    expect(ids.has("apply")).toBe(true);
    expect(ids.has("budget")).toBe(true);
    expect(ids.has("now")).toBe(true);
  });

  test("连续大写驼峰按词边界切分（HTTPServer → HTTP/Server）", () => {
    const ids = extractIdentifiers("HTTPServer", "");
    expect(ids.has("HTTPServer")).toBe(true);
    expect(ids.has("HTTP")).toBe(true);
    expect(ids.has("Server")).toBe(true);
  });

  test("无词边界的拼接词不产生子串（myrender 不产生 render）", () => {
    const ids = extractIdentifiers("myrender", "");
    expect(ids.has("myrender")).toBe(true);
    expect(ids.has("render")).toBe(false);
  });

  test("切分词同样受长度≥3 与保留字过滤", () => {
    // "All" 长度=3 保留；"const" 为保留字分段被滤
    const ids = extractIdentifiers("renderAll", "");
    expect(ids.has("render")).toBe(true);
    expect(ids.has("All")).toBe(true);
    const ids2 = extractIdentifiers("const_value", "");
    expect(ids2.has("const_value")).toBe(true);
    expect(ids2.has("const")).toBe(false);
    expect(ids2.has("value")).toBe(true);
  });
});
