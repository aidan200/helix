import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { readSandboxRuntime } from "./sandboxSetup";

/** 嵌套沙箱探测（seatbelt-sandbox.test 同构）：自身已在沙箱内 → sandbox-exec 不可用，seatbelt 断言跳过。 */
const nestedSandbox = (() => {
  try {
    const r = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(deny default)", "--", "/bin/bash", "-c", "true"], { timeout: 5_000 });
    return r.status !== 0;
  } catch {
    return true;
  }
})();

describe("readSandboxRuntime（执行器装配）", () => {
  test("enabled=false → undefined（纯透传，行为零差）", () => {
    expect(readSandboxRuntime(false, "/tmp/h", "/tmp/w")).toBeUndefined();
  });

  test("enabled=true → runtime 携 enforcer 字段（macOS 真机走 seatbelt）", () => {
    const rt = readSandboxRuntime(true, "/tmp/h", "/tmp/w");
    expect(rt).toBeDefined();
    if (rt !== undefined) {
      expect(["seatbelt", "fallback"]).toContain(rt.enforcer);
      // macOS 本机自检通过路径（CI mac runner 同）；嵌套沙箱内跑测试时 fallback 是预期（探测跳过断言）
      if (process.platform === "darwin" && !nestedSandbox) expect(rt.enforcer).toBe("seatbelt");
      expect(rt.policy.mode).toBe("on");
      expect(rt.policy.writableRoots.length).toBeGreaterThan(0);
    }
  });

  test("extraRoots 追加进 writableRoots（不存在的路径 realpath 容错保原值）", () => {
    const rt = readSandboxRuntime(true, "/tmp/h", "/tmp/w", ["/definitely/not/exist-helix-test"]);
    expect(rt).toBeDefined();
    expect(rt?.policy.writableRoots).toContain("/definitely/not/exist-helix-test");
  });

  test("cacheEnv 四键指向 <workspaceRoot>/.helix/tool-cache/*（纯缓存类；落点规范批迁 workspace）", () => {
    const rt = readSandboxRuntime(true, "/tmp/h", "/tmp/w");
    expect(rt?.cacheEnv).toEqual({
      UV_CACHE_DIR: path.join("/tmp/w", ".helix", "tool-cache", "uv"),
      npm_config_cache: path.join("/tmp/w", ".helix", "tool-cache", "npm"),
      PIP_CACHE_DIR: path.join("/tmp/w", ".helix", "tool-cache", "pip"),
      BUN_INSTALL_CACHE_DIR: path.join("/tmp/w", ".helix", "tool-cache", "bun"),
    });
    // off 态无 runtime 即无注入（零侵入；全时注入面在 shellEnv workspaceChildEnv）
    expect(readSandboxRuntime(false, "/tmp/h", "/tmp/w")).toBeUndefined();
  });
});
