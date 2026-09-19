import { describe, expect, test } from "bun:test";
import type { DaemonFreshnessDto } from "@helix/protocol";
import {
  computeDaemonFreshness,
  createDaemonFreshnessProvider,
  FRESHNESS_SCAN_ROOTS,
  type FreshnessFs,
} from "../../src/adapters/driven/freshness/SourceFreshness";

/**
 * daemon 源码新鲜度计算（stale-indicator 批）：computeDaemonFreshness 纯函数
 * + 注入文件树读面（FakeFs——目录 → 后代相对路径 / 文件 → mtime ms）。
 * 三态契约：
 * - 扫描面内任一 .ts 文件 mtime > startedAt → stale=true；
 * - 全部不新于 startedAt → stale=false（startedAt 原样回带）；
 * - 扫描根全部不存在（打包态：源码目录缺失）→ undefined（welcome 可缺省字段）。
 */

/** 假文件树：dir → 后代相对路径集合；file → mtime ms。 */
function fakeFs(tree: Record<string, string[]>, mtimes: Record<string, number>): FreshnessFs {
  return {
    listDir: (dir) => tree[dir],
    mtimeOf: (file) => mtimes[file],
  };
}

const REPO = "/repo";
const DAEMON_SRC = `${REPO}/apps/daemon/src`;
const PROTOCOL_SRC = `${REPO}/packages/protocol/src`;

/** 开发态典型树：daemon src 两文件（含子目录）+ protocol src 一文件。 */
function devTree(): { tree: Record<string, string[]>; mtimes: Record<string, number> } {
  return {
    tree: {
      [DAEMON_SRC]: ["main.ts", "adapters/WsServerAdapter.ts"],
      [PROTOCOL_SRC]: ["index.ts"],
    },
    mtimes: {
      [`${DAEMON_SRC}/main.ts`]: 1_000,
      [`${DAEMON_SRC}/adapters/WsServerAdapter.ts`]: 2_000,
      [`${PROTOCOL_SRC}/index.ts`]: 1_500,
    },
  };
}

describe("computeDaemonFreshness（注入假文件树）", () => {
  test("扫描面：apps/daemon/src + packages/protocol/src（单源登记）", () => {
    expect([...FRESHNESS_SCAN_ROOTS]).toEqual(["apps/daemon/src", "packages/protocol/src"]);
  });

  test("① 有文件新于 startedAt → stale=true（子目录文件也扫到）", () => {
    const { tree, mtimes } = devTree();
    const r = computeDaemonFreshness({ startedAt: 1_200, repoRoot: REPO, fs: fakeFs(tree, mtimes) });
    // WsServerAdapter.ts（子目录）mtime=2000 > 1200
    expect(r).toEqual({ startedAt: 1_200, stale: true } satisfies DaemonFreshnessDto);
  });

  test("② 全部旧于 startedAt → stale=false（startedAt 原样回带）", () => {
    const { tree, mtimes } = devTree();
    const r = computeDaemonFreshness({ startedAt: 2_500, repoRoot: REPO, fs: fakeFs(tree, mtimes) });
    expect(r).toEqual({ startedAt: 2_500, stale: false } satisfies DaemonFreshnessDto);
  });

  test("边界等值不判旧：max mtime == startedAt → stale=false（严格大于才 stale）", () => {
    const { tree, mtimes } = devTree();
    const r = computeDaemonFreshness({ startedAt: 2_000, repoRoot: REPO, fs: fakeFs(tree, mtimes) });
    expect(r?.stale).toBe(false);
  });

  test("③ 扫描根全部缺失（打包态）→ undefined（welcome 可缺省字段）", () => {
    const r = computeDaemonFreshness({ startedAt: 1_000, repoRoot: REPO, fs: fakeFs({}, {}) });
    expect(r).toBeUndefined();
  });

  test("单根缺失不拖垮：daemon src 缺、protocol src 在 → 按 protocol src 判", () => {
    const { tree, mtimes } = devTree();
    delete tree[DAEMON_SRC];
    // protocol src index.ts mtime=1500：新于 1000 → stale；旧于 2000 → fresh
    expect(computeDaemonFreshness({ startedAt: 1_000, repoRoot: REPO, fs: fakeFs(tree, mtimes) })?.stale).toBe(true);
    expect(computeDaemonFreshness({ startedAt: 2_000, repoRoot: REPO, fs: fakeFs(tree, mtimes) })?.stale).toBe(false);
  });

  test("只扫 *.ts：非 .ts 文件（json/md）新于 startedAt 不判旧", () => {
    const r = computeDaemonFreshness({
      startedAt: 500,
      repoRoot: REPO,
      fs: fakeFs(
        { [DAEMON_SRC]: ["a.ts", "package.json", "notes.md", "b.ts"] },
        {
          [`${DAEMON_SRC}/a.ts`]: 600,
          [`${DAEMON_SRC}/package.json`]: 5_000, // 新但非 .ts
          [`${DAEMON_SRC}/notes.md`]: 5_000,
          [`${DAEMON_SRC}/b.ts`]: 400,
        },
      ),
    });
    expect(r?.stale).toBe(true); // a.ts=600 > 500 判旧——基准在 .ts 集
    const r2 = computeDaemonFreshness({
      startedAt: 700,
      repoRoot: REPO,
      fs: fakeFs(
        { [DAEMON_SRC]: ["a.ts", "package.json"] },
        { [`${DAEMON_SRC}/a.ts`]: 600, [`${DAEMON_SRC}/package.json`]: 5_000 },
      ),
    });
    expect(r2?.stale).toBe(false); // 唯一新文件是 .json——不判旧
  });

  test("stat 失败（mtimeOf → undefined）跳过不炸", () => {
    const r = computeDaemonFreshness({
      startedAt: 1_000,
      repoRoot: REPO,
      fs: fakeFs({ [DAEMON_SRC]: ["a.ts", "gone.ts"] }, { [`${DAEMON_SRC}/a.ts`]: 900 }),
    });
    expect(r).toEqual({ startedAt: 1_000, stale: false });
  });
});

describe("createDaemonFreshnessProvider（真 fs 装配面）", () => {
  test("repoRoot 不存在（打包形态）→ undefined；真树 + startedAt 极大 → fresh", () => {
    const provider = createDaemonFreshnessProvider({ startedAt: 1_000, repoRoot: "/nonexistent-helix-root" });
    expect(provider()).toBeUndefined();
    // 本仓源码树实存：startedAt = 极大值恒 fresh（不依赖本机 mtime 波动）
    const fresh = createDaemonFreshnessProvider({ startedAt: Number.MAX_SAFE_INTEGER });
    expect(fresh()).toEqual({ startedAt: Number.MAX_SAFE_INTEGER, stale: false });
    expect(fresh()?.startedAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("每连接现算（不缓存跨连接）：两次调用都返回现值", () => {
    const provider = createDaemonFreshnessProvider({ startedAt: Number.MAX_SAFE_INTEGER });
    const a = provider();
    const b = provider();
    expect(a).not.toBe(b); // 独立求值（连接生命周期内各算一次，无共享缓存对象）
    expect(a).toEqual(b);
  });
});
