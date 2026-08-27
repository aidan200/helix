import { describe, expect, test } from "bun:test";
import { formatNodeId, parseNodeId, parseExistingMax } from "../../src/domain/kg/node-id";

/**
 * U 层：domain/kg/node-id 纯函数（AD-16 发号 + T5.2 保号迁移 max+1 服务）。
 * 零 IO、零 import 外层（TR-TEST-1）。
 */

describe("domain/kg/node-id（AD-16：前缀按 kind、序号程序生成）", () => {
  test("formatNodeId：rule→TR-n、entity→E-n", () => {
    expect(formatNodeId("rule", 1)).toBe("TR-1");
    expect(formatNodeId("rule", 47)).toBe("TR-47");
    expect(formatNodeId("entity", 3)).toBe("E-3");
  });

  test("parseNodeId：新号空间严格形态（复合前缀/大小写/非数字一律 null）", () => {
    expect(parseNodeId("TR-47")).toEqual({ kind: "rule", seq: 47 });
    expect(parseNodeId("E-3")).toEqual({ kind: "entity", seq: 3 });
    // v1 复合前缀（TR-AD-N / TR-TEST-N）不在 v2 新号空间——日常路径不接受
    expect(parseNodeId("TR-AD-47")).toBeNull();
    expect(parseNodeId("TR-TEST-2")).toBeNull();
    expect(parseNodeId("tr-47")).toBeNull();
    expect(parseNodeId("TR-047")).toEqual({ kind: "rule", seq: 47 }); // 数字归一，形态仍合法
    expect(parseNodeId("TR-")).toBeNull();
    expect(parseNodeId("")).toBeNull();
    expect(parseNodeId("SPEC-2")).toBeNull();
  });

  test("parseExistingMax：复合前缀数字提取（TR-AD-N/TR-TEST-N/中文尾缀），按 kind 取 max", () => {
    // T5.2 保号迁移场景：存量 69 节点含 TR-AD-47/TR-TEST-2/E-客户 等复合/非数字 id
    expect(parseExistingMax(["TR-AD-47", "TR-TEST-2", "TR-5", "E-3", "E-客户"])).toEqual({
      rule: 47,
      entity: 3,
    });
    expect(parseExistingMax(["TR-AD-47", "TR-AD-12"])).toEqual({ rule: 47, entity: 0 });
  });

  test("parseExistingMax：空集 / 无可提取数字 → 零起点", () => {
    expect(parseExistingMax([])).toEqual({ rule: 0, entity: 0 });
    expect(parseExistingMax(["E-客户", "SPEC-2", "iter-xxx"])).toEqual({ rule: 0, entity: 0 });
  });
});
