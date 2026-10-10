import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  WORKSPACE_MATERIALS_DIRNAME,
  ensureWorkspaceTmp,
  resolveWorkspaceTmp,
  toolCacheEnvFor,
  workspaceChildEnv,
} from "../../src/infrastructure/workspacePaths";

/**
 * workspace 运行物料根单点（落点规范批，2026-10-10）。
 * ① 派生路径 = <root>/.helix/{tmp,tool-cache/*}（path.join 产物）；
 * ② toolCacheEnvFor 四键（纯缓存类清单）；
 * ③ workspaceChildEnv：可建根 → TMPDIR 注入 + 暂存根在场；不可建根
 *    （测试假路径）→ TMPDIR 回落继承（键缺席），缓存键仍注入。
 */
describe("workspacePaths（workspace 运行物料根单点）", () => {
  test("① 派生路径：<root>/.helix/tmp（目录名常量 .helix）", () => {
    expect(WORKSPACE_MATERIALS_DIRNAME).toBe(".helix");
    expect(resolveWorkspaceTmp("/ws/root")).toBe(path.join("/ws/root", ".helix", "tmp"));
  });

  test("② toolCacheEnvFor 四键指向 <root>/.helix/tool-cache/*（纯缓存类）", () => {
    expect(toolCacheEnvFor("/ws/root")).toEqual({
      UV_CACHE_DIR: path.join("/ws/root", ".helix", "tool-cache", "uv"),
      npm_config_cache: path.join("/ws/root", ".helix", "tool-cache", "npm"),
      PIP_CACHE_DIR: path.join("/ws/root", ".helix", "tool-cache", "pip"),
      BUN_INSTALL_CACHE_DIR: path.join("/ws/root", ".helix", "tool-cache", "bun"),
    });
  });

  test("③ workspaceChildEnv：可建根注入 TMPDIR + 暂存根在场；不可建根 TMPDIR 键缺席（缓存键仍在）", () => {
    const root = mkdtempSync(path.join(tmpdir(), "helix-wspaths-"));
    try {
      const env = workspaceChildEnv(root);
      expect(env.TMPDIR).toBe(path.join(root, ".helix", "tmp"));
      expect(existsSync(env.TMPDIR!)).toBe(true);
      expect(ensureWorkspaceTmp(root)).toBe(env.TMPDIR!); // 幂等（已存在不抛）
      // 不可建根（/static 前缀不可创建）：TMPDIR 回落继承，缓存键照注
      const degraded = workspaceChildEnv("/static/definitely-not-exist-helix-test/cwd");
      expect("TMPDIR" in degraded).toBe(false);
      expect(degraded.UV_CACHE_DIR).toBe(
        path.join("/static/definitely-not-exist-helix-test/cwd", ".helix", "tool-cache", "uv"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
