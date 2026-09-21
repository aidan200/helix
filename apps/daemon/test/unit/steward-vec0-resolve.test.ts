/**
 * resolveVec0Path 单测（管家记忆 B1 批——resolve-rg 同构口径）。
 *
 * 断言面：
 * 1. bundle 级命中短路（node_modules 级不再探测）；
 * 2. node_modules 级命中（bundle 缺席/失败时）；
 * 3. 全缺 → unavailable + reasons 逐条记录（不 throw）；
 * 4. probe 抛错只视为该级不可用（整体不 throw）。
 */
import { describe, expect, test } from "bun:test";
import { resolveVec0Path } from "../../src/adapters/driven/steward-memory/resolve-vec0";

describe("resolveVec0Path", () => {
  test("① bundle 级命中短路", () => {
    const probes: string[] = [];
    const r = resolveVec0Path({
      bundlePath: "/app/bin/vec0.dylib",
      nodeModulesPath: "/nm/vec0.dylib",
      probe: (p) => {
        probes.push(p);
        return true;
      },
    });
    expect(r).toEqual({ kind: "resolved", path: "/app/bin/vec0.dylib", source: "bundle" });
    expect(probes).toEqual(["/app/bin/vec0.dylib"]); // node_modules 级未探测
  });

  test("② bundle 缺席/失败 → node_modules 级命中", () => {
    const r = resolveVec0Path({
      bundlePath: "/missing/vec0.dylib",
      nodeModulesPath: "/nm/vec0.dylib",
      probe: (p) => p.startsWith("/nm"),
    });
    expect(r).toEqual({ kind: "resolved", path: "/nm/vec0.dylib", source: "node_modules" });
  });

  test("③ 全缺 → unavailable + reasons 逐条（不 throw）", () => {
    const r = resolveVec0Path({ probe: () => false });
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") {
      expect(r.reasons.length).toBe(2);
      expect(r.reasons[0]).toContain("bundle");
      expect(r.reasons[1]).toContain("node_modules");
    }
  });

  test("④ probe 抛错只视为该级不可用（整体不 throw）", () => {
    const r = resolveVec0Path({
      bundlePath: "/x/vec0.dylib",
      nodeModulesPath: "/y/vec0.dylib",
      probe: (p) => {
        if (p.startsWith("/x")) throw new Error("fs 异常");
        return true;
      },
    });
    expect(r).toEqual({ kind: "resolved", path: "/y/vec0.dylib", source: "node_modules" });
  });
});
