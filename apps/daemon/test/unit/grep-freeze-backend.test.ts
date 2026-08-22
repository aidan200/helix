import { describe, expect, test } from "bun:test";
import { freezeGrepBackend } from "../../src/adapters/driven/tools/grep/freeze-backend";
import { resolveRgPath } from "../../src/adapters/driven/tools/grep/resolve-rg";

/**
 * TP-CL-3/F3.2（U，T1.3）：启动定格矩阵（AF-1 权威口径）——resolution ×
 * probeOutcome → 内存定格结果的纯函数投影。本文件只 import 纯函数符号
 * （零 spawn 零 fs），与 grep-tool.test.ts / grep-rg-backend.test.ts（U 半）
 * 同 framework-free 口径。
 *
 * 定格语义三要素（AF-1 v2）：进程生命周期内不重新解析、不升级；探针仅
 * `rg --version` + 2s 超时 + 退出码 0；失败原因全部入启动 info 日志。
 */

describe("freezeGrepBackend：启动定格矩阵（AF-1）", () => {
  test("① resolve 三级全空 → 定格 ts（reasons 透传，供启动 info 日志）", () => {
    const resolution = resolveRgPath({}); // 三级全缺
    expect(resolution.kind).toBe("unavailable");
    const frozen = freezeGrepBackend(resolution);
    expect(frozen.kind).toBe("ts");
    if (frozen.kind === "ts") {
      expect(frozen.reasons.length).toBe(3); // resolve-rg 契约：reasons 恒三条
      expect(frozen.reasons.join("；")).toContain("HELIX_RG_PATH");
    }
  });

  test("② resolved 但探针失败 → 定格 ts + 探针失败原因（含 rg 路径）", () => {
    const resolution = resolveRgPath({ bundlePath: "/fake/rg", probe: () => true });
    expect(resolution.kind).toBe("resolved");
    const frozen = freezeGrepBackend(resolution, { ok: false, reason: "rg --version 退出码 1：boom" });
    expect(frozen.kind).toBe("ts");
    if (frozen.kind === "ts") {
      const joined = frozen.reasons.join("；");
      expect(joined).toContain("探针");
      expect(joined).toContain("退出码 1");
      expect(joined).toContain("/fake/rg");
    }
  });

  test("③ resolved + 探针通过 → 定格 rg（携带路径与来源级）", () => {
    const resolution = resolveRgPath({ pathEnv: "/usr/bin:/bin", probe: (p) => p === "/bin/rg" });
    const frozen = freezeGrepBackend(resolution, { ok: true, reason: "" });
    expect(frozen).toEqual({ kind: "rg", rgPath: "/bin/rg", source: "path" });
  });

  test("防御：resolved 但探针结果缺失 → 保守定格 ts（不臆造可用性，同 resolve-rg 缺省 probe 语义）", () => {
    const resolution = resolveRgPath({ bundlePath: "/fake/rg", probe: () => true });
    expect(resolution.kind).toBe("resolved");
    const frozen = freezeGrepBackend(resolution);
    expect(frozen.kind).toBe("ts");
    if (frozen.kind === "ts") {
      expect(frozen.reasons.join("；")).toContain("探针");
    }
  });
});
