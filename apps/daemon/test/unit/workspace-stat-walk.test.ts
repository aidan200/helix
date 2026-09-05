/**
 * workspace-stat-walk 忽略清单单测（浮窗批 v3）。
 *
 * 根因（用户反馈「数字膨胀」）：轮末 walk 兜底把 daemon 自产面全算成
 * 「外部修改」——helix.db*（每次工具调用都写库）、.kg/.codegraph（图谱/
 * 索引库）、.helix（运行时目录）、test-results/evidence（测试产物），
 * size 差粗估直接把 chip 统计推爆。本文件钉死忽略段与 db 后缀过滤。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { walkWorkspaceStats } from "../../src/adapters/driven/workspace-stat-walk";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "stat-walk-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("workspace-stat-walk 忽略清单", () => {
  test("源码文件被索引；daemon 自产目录段被忽略", async () => {
    await writeFile(path.join(root, "a.ts"), "x");
    for (const seg of ["node_modules", ".git", ".helix", ".kg", ".codegraph", "test-results", "evidence"]) {
      await mkdir(path.join(root, seg), { recursive: true });
      await writeFile(path.join(root, seg, "f"), "x");
    }
    const idx = await walkWorkspaceStats(root);
    const names = [...idx.keys()].map((p) => path.relative(root, p));
    expect(names).toContain("a.ts");
    for (const seg of ["node_modules", ".git", ".helix", ".kg", ".codegraph", "test-results", "evidence"]) {
      expect(names.some((n) => n.startsWith(seg + path.sep))).toBe(false);
    }
  });

  test("db 后缀文件被忽略（helix.db / wal / shm / sqlite）", async () => {
    await writeFile(path.join(root, "helix.db"), "x");
    await writeFile(path.join(root, "helix.db-wal"), "x");
    await writeFile(path.join(root, "helix.db-shm"), "x");
    await writeFile(path.join(root, "app.sqlite3"), "x");
    await writeFile(path.join(root, "keep.ts"), "x");
    const idx = await walkWorkspaceStats(root);
    const names = [...idx.keys()].map((p) => path.relative(root, p));
    expect(names).toEqual(["keep.ts"]);
  });
});
