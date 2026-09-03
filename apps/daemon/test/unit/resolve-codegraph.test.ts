import { describe, expect, test } from "bun:test";
import {
  resolveCodegraphPath,
} from "../../src/adapters/driven/codegraph-engine/resolve-codegraph";

/**
 * codegraph 二进制二级解析单点测试（T2.1/AF-2 裁决，U 层；
 * bundle-only 化后与 resolve-rg 同模板）——
 * 真实顺序 ①bundle(env HELIX_CODEGRAPH_PATH)→②config(config.json
 * codegraphPath)，无 PATH 级（版本不可控，与 pin+sha256 确定性相悖）。
 * 矩阵：每级命中/缺失组合、优先级、单级 probe 失败落下一级、二级全空 →
 * unavailable 带两条 reason（EngineUnavailable/degraded 路径入口）；
 * 任何输入组合不 throw。env/fs 全部由入参注入（probe 可单测），
 * 本文件即「零 env/fs 依赖」的机械证明。
 */

/** 探测表 fake：命中集合内的路径返回 true，其余 false。 */
function probeOf(hits: readonly string[]): (path: string) => boolean {
  const set = new Set(hits);
  return (p) => set.has(p);
}

const BUNDLE = "/app/Contents/Resources/codegraph/bin/codegraph";
const CONFIG = "/Users/x/tools/codegraph";

describe("resolve-codegraph 二级解析矩阵（T2.1/AF-2，bundle-only）", () => {
  test("① bundle 命中：source=bundle（即使 config 同时可命中，bundle 优先）", () => {
    const r = resolveCodegraphPath({
      bundlePath: BUNDLE,
      configPath: CONFIG,
      probe: probeOf([BUNDLE, CONFIG]),
    });
    expect(r).toEqual({ kind: "resolved", path: BUNDLE, source: "bundle" });
  });

  test("② bundle 缺失（undefined/空串）→ config 命中：source=config", () => {
    for (const bundlePath of [undefined, ""] as const) {
      const r = resolveCodegraphPath({
        bundlePath,
        configPath: CONFIG,
        probe: probeOf([CONFIG]),
      });
      expect(r).toEqual({ kind: "resolved", path: CONFIG, source: "config" });
    }
  });

  test("单级 probe 失败落到下一级：bundle 值非空但不可执行 → config 命中", () => {
    const r = resolveCodegraphPath({
      bundlePath: BUNDLE,
      configPath: CONFIG,
      probe: probeOf([CONFIG]), // bundle probe 失败
    });
    expect(r).toEqual({ kind: "resolved", path: CONFIG, source: "config" });
  });

  test("二级全 miss → unavailable 且 reasons 恒两条（逐级记录缺失原因），不 throw", () => {
    const r = resolveCodegraphPath({
      bundlePath: "/nope/codegraph",
      configPath: "/also/nope",
      probe: () => false,
    });
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") {
      expect(r.reasons).toHaveLength(2);
      expect(r.reasons[0]).toContain("bundle");
      expect(r.reasons[1]).toContain("config");
    }
  });

  test("全空输入（undefined 两连）→ unavailable，不 throw", () => {
    const r = resolveCodegraphPath({});
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") expect(r.reasons).toHaveLength(2);
  });

  test("probe 缺省 = 保守不命中（不臆造可用性）：resolved 输入也落 unavailable", () => {
    const r = resolveCodegraphPath({ bundlePath: BUNDLE, configPath: CONFIG });
    expect(r.kind).toBe("unavailable");
  });

  test("probe 抛错只视为该候选不可用（整体不 throw 语义）：config 仍可命中", () => {
    const r = resolveCodegraphPath({
      bundlePath: BUNDLE,
      configPath: CONFIG,
      probe: (p) => {
        if (p === BUNDLE) throw new Error("EACCES");
        return p === CONFIG;
      },
    });
    expect(r).toEqual({ kind: "resolved", path: CONFIG, source: "config" });
  });
});
