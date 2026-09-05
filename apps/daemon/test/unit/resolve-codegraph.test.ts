import { describe, expect, test } from "bun:test";
import {
  resolveCodegraphPath,
} from "../../src/adapters/driven/codegraph-engine/resolve-codegraph";

/**
 * codegraph 二进制单级解析单点测试（T2.1/AF-2 裁决，U 层；
 * bundle-only 化后与 resolve-rg 同模板）——
 * 真实顺序仅 bundle（env HELIX_CODEGRAPH_PATH），无 config 级
 * （2026-09-05 砍：与 env 键语义重叠）、无 PATH 级（版本不可控，
 * 与 pin+sha256 确定性相悖）。
 * 矩阵：命中/缺失（undefined/空串）/probe 失败 → unavailable 带一条
 * reason（EngineUnavailable/degraded 路径入口）；任何输入组合不 throw。
 * env/fs 全部由入参注入（probe 可单测），本文件即「零 env/fs 依赖」的
 * 机械证明。
 */

/** 探测表 fake：命中集合内的路径返回 true，其余 false。 */
function probeOf(hits: readonly string[]): (path: string) => boolean {
  const set = new Set(hits);
  return (p) => set.has(p);
}

const BUNDLE = "/app/Contents/Resources/codegraph/bin/codegraph";

describe("resolve-codegraph 单级解析矩阵（T2.1/AF-2，bundle-only）", () => {
  test("bundle 命中：resolved 返回路径", () => {
    const r = resolveCodegraphPath({
      bundlePath: BUNDLE,
      probe: probeOf([BUNDLE]),
    });
    expect(r).toEqual({ kind: "resolved", path: BUNDLE });
  });

  test("bundle 缺失（undefined/空串）→ unavailable，reason 一条，不 throw", () => {
    for (const bundlePath of [undefined, ""] as const) {
      const r = resolveCodegraphPath({ bundlePath, probe: () => true });
      expect(r.kind).toBe("unavailable");
      if (r.kind === "unavailable") {
        expect(r.reasons).toHaveLength(1);
        expect(r.reasons[0]).toContain("HELIX_CODEGRAPH_PATH");
      }
    }
  });

  test("bundle 值非空但不可执行（probe false）→ unavailable 带路径 reason", () => {
    const r = resolveCodegraphPath({
      bundlePath: "/nope/codegraph",
      probe: () => false,
    });
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") {
      expect(r.reasons).toHaveLength(1);
      expect(r.reasons[0]).toContain("/nope/codegraph");
    }
  });

  test("全空输入 → unavailable，不 throw", () => {
    const r = resolveCodegraphPath({});
    expect(r.kind).toBe("unavailable");
  });

  test("probe 缺省 = 保守不命中（不臆造可用性）：resolved 输入也落 unavailable", () => {
    const r = resolveCodegraphPath({ bundlePath: BUNDLE });
    expect(r.kind).toBe("unavailable");
  });

  test("probe 抛错只视为候选不可用（整体不 throw 语义）", () => {
    const r = resolveCodegraphPath({
      bundlePath: BUNDLE,
      probe: () => {
        throw new Error("EACCES");
      },
    });
    expect(r.kind).toBe("unavailable");
  });
});
