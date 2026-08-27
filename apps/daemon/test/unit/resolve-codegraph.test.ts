import { describe, expect, test } from "bun:test";
import {
  resolveCodegraphPath,
  type CodegraphResolutionInput,
} from "../../src/adapters/driven/codegraph-engine/resolve-codegraph";

/**
 * T2.1（AF-2 裁决，U 层）：codegraph 二进制三级解析单点
 * （resolve-codegraph.ts，framework-free 纯函数，照抄 resolve-rg 先例——
 * AF-3：真实顺序 ①bundle(env HELIX_CODEGRAPH_PATH)→②config(code.json
 * codegraphPath)→③PATH 分段探测，与架构文档表述相反时以代码为准）。
 * 矩阵：每级命中/缺失组合、优先级、单级 probe 失败落下一级、三级全空 →
 * unavailable 带三条 reason（EngineUnavailable/degraded 路径入口）；
 * 任何输入组合不 throw。env/fs 全部由入参注入（probe 可单测），
 * 本文件即「零 env/fs 依赖」的机械证明。
 */

/** 探测表 fake：命中集合内的路径返回 true，其余 false。 */
function probeOf(hits: readonly string[]): (path: string) => boolean {
  const set = new Set(hits);
  return (p) => set.has(p);
}

const BUNDLE = "/app/Contents/Resources/bin/codegraph";
const CONFIG = "/Users/x/tools/codegraph";

describe("resolve-codegraph 三级解析矩阵（T2.1/AF-2）", () => {
  test("① bundle 命中：source=bundle（即使 config/PATH 同时可命中，bundle 优先）", () => {
    const r = resolveCodegraphPath({
      bundlePath: BUNDLE,
      configPath: CONFIG,
      pathEnv: "/usr/bin",
      probe: probeOf([BUNDLE, CONFIG, "/usr/bin/codegraph"]),
    });
    expect(r).toEqual({ kind: "resolved", path: BUNDLE, source: "bundle" });
  });

  test("② bundle 缺失（undefined/空串）→ config 命中：source=config（PATH 有命中也不越级）", () => {
    for (const bundlePath of [undefined, ""] as const) {
      const r = resolveCodegraphPath({
        bundlePath,
        configPath: CONFIG,
        pathEnv: "/usr/bin",
        probe: probeOf([CONFIG, "/usr/bin/codegraph"]),
      });
      expect(r).toEqual({ kind: "resolved", path: CONFIG, source: "config" });
    }
  });

  test("③ bundle/config 均缺失 → PATH 探测命中：source=path，path 为拼出的绝对路径", () => {
    const r = resolveCodegraphPath({
      pathEnv: "/usr/bin:/opt/homebrew/bin",
      probe: probeOf(["/opt/homebrew/bin/codegraph"]),
    });
    expect(r).toEqual({ kind: "resolved", path: "/opt/homebrew/bin/codegraph", source: "path" });
  });

  test("单级 probe 失败落到下一级：bundle 值非空但不可执行 → config 命中", () => {
    const r = resolveCodegraphPath({
      bundlePath: BUNDLE,
      configPath: CONFIG,
      probe: probeOf([CONFIG]), // bundle probe 失败
    });
    expect(r).toEqual({ kind: "resolved", path: CONFIG, source: "config" });
  });

  test("PATH 分段：空段跳过、多段逐一探测、第一命中即返回", () => {
    const r = resolveCodegraphPath({
      pathEnv: "://a:/b::/c",
      probe: probeOf(["/b/codegraph", "/c/codegraph"]),
    });
    expect(r).toEqual({ kind: "resolved", path: "/b/codegraph", source: "path" });
  });

  test("三级全 miss → unavailable 且 reasons 恒三条（逐级记录缺失原因），不 throw", () => {
    const r = resolveCodegraphPath({
      bundlePath: "/nope/codegraph",
      configPath: "/also/nope",
      pathEnv: "/x:/y",
      probe: () => false,
    });
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") {
      expect(r.reasons).toHaveLength(3);
      expect(r.reasons[0]).toContain("bundle");
      expect(r.reasons[1]).toContain("config");
      expect(r.reasons[2]).toContain("PATH");
    }
  });

  test("全空输入（undefined 三连）→ unavailable，不 throw", () => {
    const r = resolveCodegraphPath({});
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") expect(r.reasons).toHaveLength(3);
  });

  test("probe 缺省 = 保守不命中（不臆造可用性）：resolved 输入也落 unavailable", () => {
    const r = resolveCodegraphPath({ bundlePath: BUNDLE, configPath: CONFIG, pathEnv: "/usr/bin" });
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
