import { describe, expect, test } from "bun:test";
import { resolveRgPath, type RgResolutionInput } from "../../src/adapters/driven/tools/grep/resolve-rg";

/**
 * TP-CL3/F3.1（U）：rg 路径三级解析单点（resolve-rg.ts，framework-free 纯函数）。
 * 固定顺序：① bundle（壳 env HELIX_RG_PATH 注入值）→ ② config.json rgPath → ③ PATH 探测。
 * 矩阵：每级命中/缺失组合、优先级、单级 probe 失败落下一级、三级全空 →
 * unavailable 带三条 reason；任何输入组合不 throw（决策消解：降级信号不抛裸错）。
 * env/fs 全部由入参注入（probe 可单测），本文件即「零 env/fs 依赖」的机械证明。
 */

/** 探测表 fake：命中集合内的路径返回 true，其余 false。 */
function probeOf(hits: readonly string[]): (path: string) => boolean {
  const set = new Set(hits);
  return (p) => set.has(p);
}

const BUNDLE = "/app/Contents/Resources/bin/rg";
const CONFIG = "/Users/x/tools/rg";

describe("resolve-rg 三级解析矩阵（F3.1）", () => {
  test("① bundle 命中：source=bundle（即使 config/PATH 同时可命中，bundle 优先）", () => {
    const r = resolveRgPath({
      bundlePath: BUNDLE,
      configPath: CONFIG,
      pathEnv: "/usr/bin",
      probe: probeOf([BUNDLE, CONFIG, "/usr/bin/rg"]),
    });
    expect(r).toEqual({ kind: "resolved", path: BUNDLE, source: "bundle" });
  });

  test("② bundle 缺失（undefined/空串）→ config 命中：source=config（PATH 有命中也不越级）", () => {
    for (const bundlePath of [undefined, ""] as const) {
      const r = resolveRgPath({
        bundlePath,
        configPath: CONFIG,
        pathEnv: "/usr/bin",
        probe: probeOf([CONFIG, "/usr/bin/rg"]),
      });
      expect(r).toEqual({ kind: "resolved", path: CONFIG, source: "config" });
    }
  });

  test("③ bundle/config 均缺失 → PATH 探测命中：source=path，path 为拼出的绝对路径", () => {
    const r = resolveRgPath({
      pathEnv: "/usr/bin:/opt/homebrew/bin",
      probe: probeOf(["/opt/homebrew/bin/rg"]),
    });
    expect(r).toEqual({ kind: "resolved", path: "/opt/homebrew/bin/rg", source: "path" });
  });

  test("单级 probe 失败落到下一级：bundle 值非空但不可执行 → config 命中", () => {
    const r = resolveRgPath({
      bundlePath: BUNDLE,
      configPath: CONFIG,
      probe: probeOf([CONFIG]), // bundle probe 失败
    });
    expect(r).toEqual({ kind: "resolved", path: CONFIG, source: "config" });
  });

  test("单级 probe 失败落到下一级：config 不可执行 → PATH 命中", () => {
    const r = resolveRgPath({
      bundlePath: BUNDLE,
      configPath: CONFIG,
      pathEnv: "/usr/bin",
      probe: probeOf(["/usr/bin/rg"]), // bundle/config probe 均失败
    });
    expect(r).toEqual({ kind: "resolved", path: "/usr/bin/rg", source: "path" });
  });

  test("三级全空 → unavailable：三条 reason 逐条记录各级缺失原因，不 throw", () => {
    const r = resolveRgPath({ bundlePath: "", configPath: undefined, pathEnv: undefined });
    expect(r.kind).toBe("unavailable");
    if (r.kind !== "unavailable") return;
    expect(r.reasons.length).toBe(3);
    expect(r.reasons[0]).toContain("bundle");
    expect(r.reasons[1]).toContain("config");
    expect(r.reasons[2]).toContain("PATH");
  });

  test("三级均有值但 probe 全失败 → unavailable：reasons 反映「probe 失败」而非「未配置」", () => {
    const r = resolveRgPath({
      bundlePath: BUNDLE,
      configPath: CONFIG,
      pathEnv: "/usr/bin",
      probe: () => false,
    });
    expect(r.kind).toBe("unavailable");
    if (r.kind !== "unavailable") return;
    expect(r.reasons.length).toBe(3);
    expect(r.reasons[0]).toContain(BUNDLE);
    expect(r.reasons[1]).toContain(CONFIG);
  });

  test("PATH 分段扫描：空段跳过、逐段拼 <dir>/rg 探测，全不中记一条 reason", () => {
    const probed: string[] = [];
    const r = resolveRgPath({
      pathEnv: "/a::/b",
      probe: (p) => {
        probed.push(p);
        return false;
      },
    });
    expect(probed).toEqual(["/a/rg", "/b/rg"]); // 空段不产生候选
    expect(r.kind).toBe("unavailable");
  });

  test("鲁棒性：probe 自身抛错视为该候选不可用，整体不 throw", () => {
    const r = resolveRgPath({
      bundlePath: BUNDLE,
      configPath: CONFIG,
      pathEnv: "/usr/bin",
      probe: () => {
        throw new Error("boom");
      },
    });
    expect(r.kind).toBe("unavailable");
    if (r.kind !== "unavailable") return;
    expect(r.reasons.length).toBe(3);
  });

  test("默认 probe（未注入）= 无法验证可用性：任何候选均不命中 → unavailable", () => {
    const input: RgResolutionInput = { bundlePath: BUNDLE, configPath: CONFIG, pathEnv: "/usr/bin" };
    const r = resolveRgPath(input);
    expect(r.kind).toBe("unavailable");
  });
});
