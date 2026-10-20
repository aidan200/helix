import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRootOfPath, scanWorkspaceProjects } from "../../src/adapters/driven/workspace-scan";

/**
 * workspace 项目扫描（低危批）：symlink → 目录的项目必须入扫描面。
 *
 * 旧实现只认 Dirent.isDirectory()（对 symlink 恒 false），而归属判定
 * projectRootOfPath 是词法判定（symlink 路径照常归属）——两口径不对称：
 * 事件可归属到某项目，但项目在扫描/读面里永远不可见。
 */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe("scanWorkspaceProjects（symlink 项目）", () => {
  test("① symlink 指向目录 → 入扫描面（与 projectRootOfPath 归属口径一致）", () => {
    const ws = tmp("helix-ws-scan-");
    const real = tmp("helix-ws-real-");
    writeFileSync(join(real, "a.ts"), "export {};\n");
    mkdirSync(join(ws, "plain"), { recursive: true });
    symlinkSync(real, join(ws, "linked"), "dir");
    const projects = scanWorkspaceProjects(ws);
    expect(projects).toEqual([join(ws, "linked"), join(ws, "plain")].sort());
    // 归属面同路径 → 项目可见（两口径对齐）
    expect(projectRootOfPath(ws, join(ws, "linked", "a.ts"))).toBe(join(ws, "linked"));
  });

  test("② 断链 symlink / 指向文件的 symlink 不入扫描（不抛错）", () => {
    const ws = tmp("helix-ws-scan2-");
    const file = join(tmp("helix-ws-file-"), "f.txt");
    writeFileSync(file, "x");
    symlinkSync(join(ws, "no-such-target"), join(ws, "broken"), "dir");
    symlinkSync(file, join(ws, "file-link"), "file");
    expect(scanWorkspaceProjects(ws)).toEqual([]);
  });

  test("③ 隐藏/排除段仍被过滤（symlink 不绕过排除清单）", () => {
    const ws = tmp("helix-ws-scan3-");
    const real = tmp("helix-ws-real3-");
    mkdirSync(join(ws, "node_modules-source"), { recursive: true });
    symlinkSync(real, join(ws, ".hidden"), "dir");
    symlinkSync(real, join(ws, "node_modules"), "dir");
    expect(scanWorkspaceProjects(ws)).toEqual([join(ws, "node_modules-source")]);
  });
});
