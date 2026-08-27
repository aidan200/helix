import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  scanWorkspaceProjects,
  startKgSyncBackground,
  type KnowledgeStack,
} from "../../src/infrastructure/assembly/buildKnowledgeStack";

/**
 * 组合根挂接测试（T2.2）：scanWorkspaceProjects 排除清单（§3.5 宽松口径）
 * + startKgSyncBackground 的 watch→projectRoot 分解与 stop 生命周期。
 * syncService 用 fake（挂接语义面），watch 用真实 fs.watch（环境冒烟口径）。
 */

const tmpRoots: string[] = [];
afterAll(() => {
  for (const t of tmpRoots) rmSync(t, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** fake syncService（挂接语义面：记录 onStartup/onFsEvent 调用）。 */
function fakeStack(): { stack: KnowledgeStack; startups: string[]; fsEvents: Array<{ projectRoot: string; path: string; kind: string }> } {
  const startups: string[] = [];
  const fsEvents: Array<{ projectRoot: string; path: string; kind: string }> = [];
  const stack = {
    syncService: {
      onStartup: async (root: string) => {
        startups.push(root);
      },
      onFsEvent: (root: string, p: string, kind: string) => {
        fsEvents.push({ projectRoot: root, path: p, kind });
      },
      dispose: () => {},
    },
  } as unknown as KnowledgeStack;
  return { stack, startups, fsEvents };
}

describe("scanWorkspaceProjects（§3.5 宽松口径）", () => {
  test("① 一级目录入列；排除清单（docs/.helix/.worktrees/node_modules/隐藏）为唯一过滤；文件项不入列", () => {
    const root = mkdtempSync(path.join(tmpdir(), "kg-scan-"));
    tmpRoots.push(root);
    for (const d of ["helix", "feifei", "docs", ".helix", ".worktrees", ".hidden", "node_modules"]) {
      mkdirSync(path.join(root, d), { recursive: true });
    }
    writeFileSync(path.join(root, "README.md"), "x");
    const projects = scanWorkspaceProjects(root);
    expect(projects).toEqual([path.join(root, "feifei"), path.join(root, "helix")]); // 码点序
  });

  test("② workspace 根不可读 → 空列表（不抛）", () => {
    expect(scanWorkspaceProjects(path.join(tmpdir(), "no-such-root-xyz"))).toEqual([]);
  });
});

describe("startKgSyncBackground（daemon 启动挂接）", () => {
  test("③ 启动触发逐项目 onStartup；watch 事件按一级目录分解 projectRoot；stop 后停", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kg-bg-"));
    tmpRoots.push(root);
    mkdirSync(path.join(root, "proj-a", "src"), { recursive: true });
    const { stack, startups, fsEvents } = fakeStack();
    const bg = startKgSyncBackground(stack, root);
    try {
      expect(startups).toEqual([path.join(root, "proj-a")]); // 启动触发（异步发起同步登记）
      await sleep(200); // watch 就位热身
      writeFileSync(path.join(root, "proj-a", "src", "x.ts"), "export {};\n");
      const hit = await waitFor(() => fsEvents.some((e) => e.path.endsWith("src/x.ts")), 3000);
      expect(hit).toBe(true);
      const event = fsEvents.find((e) => e.path.endsWith("src/x.ts"))!;
      expect(event.projectRoot).toBe(path.join(root, "proj-a"));
      expect(event.kind).toBe("write");
    } finally {
      bg.stop();
    }
    const count = fsEvents.length;
    writeFileSync(path.join(root, "proj-a", "src", "x.ts"), "export const y = 1;\n");
    await sleep(250);
    expect(fsEvents.length).toBe(count); // stop 后 watch 停
  });
});

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return (async function poll(): Promise<boolean> {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
    return poll();
  })();
}
