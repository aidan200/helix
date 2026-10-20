import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspaceFs } from "../../src/adapters/driven/workspace-fs";

/**
 * WorkspaceFsAdapter.isFsRoot（低危批：判据按**被检路径**取根）。
 *
 * 旧实现 fsRoot() 返回 path.parse(process.cwd()).root——Windows 多盘符下
 * （daemon 在 C:、候选工作区 D:\）两者根不同，危险根守卫会漏判放行盘根。
 * 新判据：只有「路径本身就是它所在卷的根」才算文件系统根。
 */
describe("createWorkspaceFs().isFsRoot", () => {
  const fs = createWorkspaceFs();

  test("① 当前卷根 → true；普通目录 → false（POSIX 面）", () => {
    const root = path.parse(process.cwd()).root;
    if (process.platform === "win32") return; // POSIX 断言面
    expect(fs.isFsRoot("/")).toBe(true);
    const dir = mkdtempSync(path.join(tmpdir(), "helix-fsroot-"));
    try {
      expect(fs.isFsRoot(dir)).toBe(false);
      expect(fs.isFsRoot(path.join(dir, "sub"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(root).toBe("/");
  });

  test("② 判据对被检路径的卷成立（不依赖 daemon cwd）——跨卷语义按平台事实", () => {
    // win32：'D:\' 自身是根；POSIX：'D:\' 是相对名 → 解析到 cwd 下 ≠ 根
    const winRoot = "D:\\";
    const expectRoot = process.platform === "win32";
    expect(fs.isFsRoot(winRoot)).toBe(expectRoot);
  });

  test("③ 结尾斜杠/相对形态归一后同判（path.resolve 归一）", () => {
    const root = path.parse(process.cwd()).root;
    expect(fs.isFsRoot(`${root}.`)).toBe(true); // 根 + "." 归一仍为根
  });
});
