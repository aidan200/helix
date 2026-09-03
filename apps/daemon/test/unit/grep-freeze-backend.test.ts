import { describe, expect, test } from "bun:test";
import { freezeGrepBackend } from "../../src/adapters/driven/tools/grep/freeze-backend";
import { resolveRgPath } from "../../src/adapters/driven/tools/grep/resolve-rg";

/**
 * TP-CL-3/F3.2（U，T1.3）：启动定格矩阵（AF-1 权威口径）——resolution ×
 * probeOutcome → 内存定格结果的纯函数投影。本文件只 import 纯函数符号
 * （零 spawn 零 fs），framework-free 口径。
 *
 * 定格语义（rg 唯一化后）：进程生命周期内不重新解析、不升级；探针仅
 * `rg --version` + 2s 超时 + 退出码 0；rg 为唯一后端，unavailable ≠
 * 装配失败——原因清单入启动 warn 日志并透传门面作响亮失败文案。
 */

describe("freezeGrepBackend：启动定格矩阵（AF-1）", () => {
  test("① resolve 二级全空 → 定格 unavailable（reasons 透传，供启动 warn 日志与失败文案）", () => {
    const resolution = resolveRgPath({}); // 二级全缺
    expect(resolution.kind).toBe("unavailable");
    const frozen = freezeGrepBackend(resolution);
    expect(frozen.kind).toBe("unavailable");
    if (frozen.kind === "unavailable") {
      expect(frozen.reasons.length).toBe(2); // resolve-rg 契约：reasons 恒两条
      expect(frozen.reasons.join("；")).toContain("HELIX_RG_PATH");
    }
  });

  test("② resolved 但探针失败 → 定格 unavailable + 探针失败原因（含 rg 路径）", () => {
    const resolution = resolveRgPath({ bundlePath: "/fake/rg", probe: () => true });
    expect(resolution.kind).toBe("resolved");
    const frozen = freezeGrepBackend(resolution, { ok: false, reason: "rg --version 退出码 1：boom" });
    expect(frozen.kind).toBe("unavailable");
    if (frozen.kind === "unavailable") {
      const joined = frozen.reasons.join("；");
      expect(joined).toContain("探针");
      expect(joined).toContain("退出码 1");
      expect(joined).toContain("/fake/rg");
    }
  });

  test("③ resolved + 探针通过 → 定格 rg（携带路径与来源级）", () => {
    const resolution = resolveRgPath({ bundlePath: "/bundle/rg", probe: () => true });
    const frozen = freezeGrepBackend(resolution, { ok: true, reason: "" });
    expect(frozen).toEqual({ kind: "rg", rgPath: "/bundle/rg", source: "bundle" });
  });

  test("防御：resolved 但探针结果缺失 → 保守定格 unavailable（不臆造可用性，同 resolve-rg 缺省 probe 语义）", () => {
    const resolution = resolveRgPath({ bundlePath: "/fake/rg", probe: () => true });
    expect(resolution.kind).toBe("resolved");
    const frozen = freezeGrepBackend(resolution);
    expect(frozen.kind).toBe("unavailable");
    if (frozen.kind === "unavailable") {
      expect(frozen.reasons.join("；")).toContain("探针");
    }
  });
});
