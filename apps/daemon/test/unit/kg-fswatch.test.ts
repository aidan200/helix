import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FsWatchAdapter,
  loadGitignorePatterns,
  resolveWatchEvent,
  shouldIgnorePath,
} from "../../src/adapters/driven/fs-watch/FsWatchAdapter";

/**
 * fs-watch 适配器测试（F-21）：
 * - I 层（注入事件源/exists）：ignore 过滤 + kind 归一全覆盖；
 * - 环境冒烟（真实 fs.watch，1-2 条弱保证）：事件到达 + stop 停止。
 * watch→KgSyncService 的队列衔接由 kg-sync-service/kg-sync-pipeline 覆盖。
 */

const ROOT = "/w/root";

describe("fs-watch：ignore 前置过滤（I 层）", () => {
  test("① 内置清单任一段命中即忽略；隐藏项忽略；正常路径放行", () => {
    expect(shouldIgnorePath("node_modules/pkg/index.js")).toBe(true);
    expect(shouldIgnorePath("src/node_modules/x.ts")).toBe(true);
    expect(shouldIgnorePath(".git/config")).toBe(true);
    expect(shouldIgnorePath("dist/bundle.js")).toBe(true);
    expect(shouldIgnorePath("a/.worktrees/b.ts")).toBe(true);
    expect(shouldIgnorePath(".env")).toBe(true);
    expect(shouldIgnorePath("src/.hidden/x.ts")).toBe(true);
    expect(shouldIgnorePath("src/app.ts")).toBe(false);
  });

  test("② .gitignore 简单模式（glob 相对 root；注释/否定行跳过；目录尾斜杠剥除）", () => {
    expect(shouldIgnorePath("build/out.js", ["build"])).toBe(true);
    expect(shouldIgnorePath("logs/app.log", ["*.log"])).toBe(true);
    expect(shouldIgnorePath("src/app.log.bak", ["*.log"])).toBe(false);
    expect(shouldIgnorePath("coverage/index.html", ["coverage"])).toBe(true); // 目录尾斜杠已由 loadGitignorePatterns 剥除
    expect(shouldIgnorePath("src/coverage/index.html", ["coverage"])).toBe(true); // 无斜杠模式匹配任意层段（gitignore 语义）
  });

  test("③ loadGitignorePatterns：注释/空行/否定行跳过", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "fswatch-gitignore-"));
    try {
      writeFileSync(
        path.join(tmp, ".gitignore"),
        ["# comment", "", "!keep.txt", "build/", "*.log", "  spaced  "].join("\n"),
      );
      expect(loadGitignorePatterns(tmp)).toEqual(["build", "*.log", "spaced"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("fs-watch：事件归一（I 层注入 exists）", () => {
  const existsYes = (): boolean => true;
  const existsNo = (): boolean => false;

  test("④ change → write；rename+存在 → write；rename+消失 → remove", () => {
    expect(resolveWatchEvent(ROOT, ROOT, "change", "src/a.ts", existsYes)).toEqual({
      absPath: `${ROOT}/src/a.ts`,
      kind: "write",
    });
    expect(resolveWatchEvent(ROOT, ROOT, "rename", "src/a.ts", existsYes)).toEqual({
      absPath: `${ROOT}/src/a.ts`,
      kind: "write",
    });
    expect(resolveWatchEvent(ROOT, ROOT, "rename", "src/a.ts", existsNo)).toEqual({
      absPath: `${ROOT}/src/a.ts`,
      kind: "remove",
    });
  });

  test("⑤ filename=null/空、ignore 命中、逃出 root → null", () => {
    expect(resolveWatchEvent(ROOT, ROOT, "change", null, existsYes)).toBeNull();
    expect(resolveWatchEvent(ROOT, ROOT, "change", "", existsYes)).toBeNull();
    expect(resolveWatchEvent(ROOT, ROOT, "change", "node_modules/x.js", existsYes)).toBeNull();
    expect(resolveWatchEvent(ROOT, "/other", "change", "../escape.ts", existsYes)).toBeNull();
  });

  test("⑥ Linux per-dir：filename 相对 watchDir，ignore 按绝对路径归一到 root 相对", () => {
    const sub = `${ROOT}/src/lib`;
    expect(resolveWatchEvent(ROOT, sub, "change", "util.ts", existsYes, ["src/lib/**.bak"])).toEqual({
      absPath: `${sub}/util.ts`,
      kind: "write",
    });
    expect(resolveWatchEvent(ROOT, sub, "change", "node_modules/y.js", existsYes)).toBeNull();
  });
});

describe("fs-watch：真实 watch 环境冒烟（弱保证，≤3s 超时兜底）", () => {
  const tmpRoots: string[] = [];
  afterAll(() => {
    for (const t of tmpRoots) rmSync(t, { recursive: true, force: true });
  });

  test("⑦ 递归单流（darwin/win）：子目录写文件 → write 事件到达；node_modules 不产生事件", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fswatch-smoke-"));
    tmpRoots.push(root);
    mkdirSync(path.join(root, "src"), { recursive: true });
    const events: { absPath: string; kind: string }[] = [];
    const adapter = new FsWatchAdapter({ root, onEvent: (e) => events.push(e) });
    adapter.start();
    try {
      await sleep(200); // watch 就位热身（同步紧跟 start 的写会丢——弱保证口径）
      writeFileSync(path.join(root, "src", "a.ts"), "export const x = 1;\n");
      const hit = await waitFor(() => events.some((e) => e.absPath.endsWith("src/a.ts") && e.kind === "write"), 3000);
      expect(hit).toBe(true);
      // ignore 生效（弱负断言：短窗内无 node_modules 域事件）
      mkdirSync(path.join(root, "node_modules"), { recursive: true });
      writeFileSync(path.join(root, "node_modules", "x.js"), "x");
      await sleep(250);
      expect(events.some((e) => e.absPath.includes("node_modules"))).toBe(false);
    } finally {
      adapter.stop();
    }
    // stop 后不再收事件（弱断言）
    const count = events.length;
    writeFileSync(path.join(root, "src", "a.ts"), "export const x = 2;\n");
    await sleep(250);
    expect(events.length).toBe(count);
  });

  test("⑧ Linux per-dir 分支（platform 注入 linux）：事件到达 + 子目录挂载计数", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fswatch-linux-"));
    tmpRoots.push(root);
    mkdirSync(path.join(root, "src", "lib"), { recursive: true });
    const events: { absPath: string; kind: string }[] = [];
    const adapter = new FsWatchAdapter({ root, onEvent: (e) => events.push(e), platform: "linux" });
    adapter.start();
    try {
      expect(adapter.watchedDirCount).toBe(3); // root + src + src/lib
      await sleep(200); // watch 就位热身
      writeFileSync(path.join(root, "src", "lib", "util.ts"), "export {};\n");
      const hit = await waitFor(() => events.some((e) => e.absPath.endsWith("src/lib/util.ts")), 3000);
      expect(hit).toBe(true);
      // 动态补挂：新目录事件后子目录进入挂载面
      mkdirSync(path.join(root, "src", "newdir"), { recursive: true });
      writeFileSync(path.join(root, "src", "newdir", "m.ts"), "export {};\n");
      await waitFor(() => adapter.watchedDirCount >= 4, 3000);
      expect(adapter.watchedDirCount).toBeGreaterThanOrEqual(4);
    } finally {
      adapter.stop();
    }
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

// existsSync 引用保底（避免未使用告警面——冒烟分支以真实存在性判定）
void existsSync;
