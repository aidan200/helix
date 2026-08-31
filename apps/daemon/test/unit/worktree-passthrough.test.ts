import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveMainRepoPath } from "../../src/domain/kg/project-discovery";
import { kgReadProjects } from "../../src/adapters/driven/workspace-scan";

/**
 * D8 W-R2/W-R3：worktree 读穿透路径归一单测。
 *
 * - resolveMainRepoPath（domain 纯函数，零 IO）：路径含 /.worktrees/ 段 →
 *   主仓等价路径（<段前>/<主仓名>，深层路径保留 worktree 内相对尾段）；
 *   不含 → 原样返回（逐字节不变）。W-R1 落点口径：
 *   <workspaceRoot>/.worktrees/{project}-{slug}。
 * - kgReadProjects（driven 读面项目域）：基座在 .worktrees 下 → 主仓有库即
 *   [主仓]（读面绝不新建库文件），无库空集；普通 workspace → 既有口径。
 */

describe("resolveMainRepoPath：worktree 路径 → 主仓归一（纯函数）", () => {
  test("非 worktree 路径 → 原样返回（普通项目根/工作区根/带尾斜杠均逐字节不变）", () => {
    expect(resolveMainRepoPath("/ws/helix")).toBe("/ws/helix");
    expect(resolveMainRepoPath("/ws")).toBe("/ws");
    expect(resolveMainRepoPath("/ws/")).toBe("/ws/");
    expect(resolveMainRepoPath("/ws/foo.worktrees/helix-x")).toBe("/ws/foo.worktrees/helix-x"); // 非独立段（无前导 /）不触发
    expect(resolveMainRepoPath("relative/path")).toBe("relative/path");
    expect(resolveMainRepoPath("")).toBe("");
  });

  test("worktree 根 → 主仓 projectRoot（W-R1 命名 {project}-{slug}，首个 - 前为 project）", () => {
    expect(resolveMainRepoPath("/ws/.worktrees/helix-foo")).toBe("/ws/helix");
    // slug 自身含连字符：首个 - 前为 project（实际 worktree 名形如 helix-d8-read-passthrough）
    expect(resolveMainRepoPath("/ws/.worktrees/helix-d8-read-passthrough")).toBe("/ws/helix");
  });

  test("worktree 深层路径 → 主仓等价路径（保留 worktree 内相对尾段——附着/文件语义）", () => {
    expect(resolveMainRepoPath("/ws/.worktrees/helix-foo/apps/daemon/src/x.ts")).toBe(
      "/ws/helix/apps/daemon/src/x.ts",
    );
  });

  test("尾斜杠：worktree 根/深层路径尾斜杠归一去尾（/ws/helix 形态）", () => {
    expect(resolveMainRepoPath("/ws/.worktrees/helix-foo/")).toBe("/ws/helix");
    expect(resolveMainRepoPath("/ws/.worktrees/helix-foo/apps/")).toBe("/ws/helix/apps");
  });

  test("命名不合 W-R1 契约 → 原样返回（无 - / - 打头 / .worktrees 直结尾）", () => {
    expect(resolveMainRepoPath("/ws/.worktrees/backup")).toBe("/ws/.worktrees/backup"); // 无 project/slug 分隔
    expect(resolveMainRepoPath("/ws/.worktrees/-foo")).toBe("/ws/.worktrees/-foo"); // 主仓名空
    expect(resolveMainRepoPath("/ws/.worktrees/")).toBe("/ws/.worktrees/"); // 无 worktree 目录名
    expect(resolveMainRepoPath("/ws/.worktrees")).toBe("/ws/.worktrees"); // 无尾段
  });

  test("嵌套 .worktrees：首个 /.worktrees/ 段生效（外层 worktree 管辖）", () => {
    expect(resolveMainRepoPath("/ws/.worktrees/helix-foo/.worktrees/other-x/y.ts")).toBe(
      "/ws/helix/.worktrees/other-x/y.ts",
    );
  });

  test("workspace 根为 /（.worktrees 紧贴根）→ /{project} 形态", () => {
    expect(resolveMainRepoPath("/.worktrees/helix-foo")).toBe("/helix");
  });
});

describe("kgReadProjects：kg 读面项目域（W-R3 读穿透 + 既有口径不变）", () => {
  test("普通 workspace：既有口径不变（有 .helix-kg 的项目入列，absent 不入）", () => {
    const root = mkdtempSync(path.join(tmpdir(), "worktree-kg-read-a-"));
    try {
      mkdirSync(path.join(root, "proj-a", ".helix-kg"), { recursive: true });
      writeFileSync(path.join(root, "proj-a", ".helix-kg", "kg.db"), "stub");
      mkdirSync(path.join(root, "proj-b"), { recursive: true });
      expect(kgReadProjects(root)).toEqual([path.join(root, "proj-a")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("worktree 基座 → 读穿透主仓：主仓有 kg.db → [主仓]", () => {
    const root = mkdtempSync(path.join(tmpdir(), "worktree-kg-read-b-"));
    try {
      mkdirSync(path.join(root, "helix", ".helix-kg"), { recursive: true });
      writeFileSync(path.join(root, "helix", ".helix-kg", "kg.db"), "stub");
      mkdirSync(path.join(root, ".worktrees", "helix-d8-x"), { recursive: true });
      expect(kgReadProjects(path.join(root, ".worktrees", "helix-d8-x"))).toEqual([path.join(root, "helix")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("worktree 基座 + 主仓无 kg.db → 空集（读面绝不新建库文件——零建库副作用）", () => {
    const root = mkdtempSync(path.join(tmpdir(), "worktree-kg-read-c-"));
    try {
      mkdirSync(path.join(root, "helix"), { recursive: true });
      mkdirSync(path.join(root, ".worktrees", "helix-d8-x"), { recursive: true });
      const base = path.join(root, ".worktrees", "helix-d8-x");
      expect(kgReadProjects(base)).toEqual([]);
      // 零建库副作用：主仓与 worktree 内均未凭空产生 kg.db
      expect(existsSync(path.join(root, "helix", ".helix-kg", "kg.db"))).toBe(false);
      expect(existsSync(path.join(base, ".helix-kg", "kg.db"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("worktree 基座 + 主仓目录不存在 → 空集", () => {
    const root = mkdtempSync(path.join(tmpdir(), "worktree-kg-read-d-"));
    try {
      mkdirSync(path.join(root, ".worktrees", "ghost-x"), { recursive: true });
      expect(kgReadProjects(path.join(root, ".worktrees", "ghost-x"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
