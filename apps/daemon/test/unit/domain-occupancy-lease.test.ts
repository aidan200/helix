import { describe, expect, test } from "bun:test";
import { scopeCoversPath, scopesOverlap } from "../../src/domain/agent/OccupancyLease";

/**
 * OccupancyLease 纯函数回归（U4）：目录前缀包含（isUnder）的根特判与
 * 归一口径。code-review 低危修复回归锚：isUnder 此前对 r === "/" 无特判
 * ——r + "/" 即 "//" 对归一后的 path 恒假，根目录租约零覆盖；修复后根
 * 覆盖一切路径。
 */

describe("scopeCoversPath：目录前缀覆盖", () => {
  test("项目根前缀覆盖（自身与深层路径；兄弟前缀不误命中）", () => {
    expect(scopeCoversPath({ kind: "project", projectRoot: "/ws/projA" }, "/ws/projA")).toBe(true);
    expect(scopeCoversPath({ kind: "project", projectRoot: "/ws/projA" }, "/ws/projA/src/a.ts")).toBe(true);
    expect(scopeCoversPath({ kind: "project", projectRoot: "/ws/projA" }, "/ws/projAB/c.ts")).toBe(false);
  });

  test("根目录（/）覆盖一切路径（根特判：r + \"/\" 即 \"//\" 对归一后 path 恒假）", () => {
    expect(scopeCoversPath({ kind: "project", projectRoot: "/" }, "/")).toBe(true);
    expect(scopeCoversPath({ kind: "project", projectRoot: "/" }, "/ws/projA/a.ts")).toBe(true);
    expect(scopeCoversPath({ kind: "paths", patterns: ["/"] }, "/private/var/tmp/x")).toBe(true);
  });

  test("归一前置于比对（重复斜杠/尾斜杠 /private 前缀折叠）", () => {
    expect(scopeCoversPath({ kind: "project", projectRoot: "/ws//projA/" }, "/ws/projA/x.ts")).toBe(true);
    expect(scopeCoversPath({ kind: "project", projectRoot: "/var/tmp" }, "/private/var/tmp/x")).toBe(true);
  });
});

describe("scopesOverlap：范围相交", () => {
  test("根范围与任意绝对范围相交（双向）", () => {
    expect(scopesOverlap({ kind: "project", projectRoot: "/" }, { kind: "project", projectRoot: "/ws/a" })).toBe(true);
    expect(scopesOverlap({ kind: "project", projectRoot: "/ws/a" }, { kind: "project", projectRoot: "/" })).toBe(true);
  });

  test("无关项目根不相交", () => {
    expect(scopesOverlap({ kind: "project", projectRoot: "/ws/a" }, { kind: "project", projectRoot: "/ws/b" })).toBe(false);
  });
});
