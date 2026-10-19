import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FSWatcher } from "node:fs";
import type { FsWatchEvent } from "../../src/application/ports/outbound/FsWatchPort";
import { FsWatchAdapter, type FsWatchAdapterDeps } from "../../src/adapters/driven/fs-watch/FsWatchAdapter";

/**
 * 目录分层兜底（layeredWatch）watcher 生命周期确定性单测（评审 B16 条目7）：
 * seenTrees（realpath 防环去重）只增不删——目录删除只摘 watcher 不清 seenTrees，
 * 同名目录重建后 addTree 命中即 return 永不补挂，Linux 分层兜底下删除重建的
 * 子树永久脱管（破 E-79「新目录增量补挂」语义）。
 *
 * 驱动面：watchFn 注入（真 fs 事件在沙箱/CI 环境不可派发——kg-fs-watch.test.ts
 * 真 fs 用例⑧⑨⑩在同环境预存失败，删除重建剧本需确定性驱动）；stat/readdir/
 * realpath 走真 fs（文件系统操作可用，仅事件派发不可用）。
 */

/** 最小 FSWatcher 形状（adapter 只用 on("error") + close）。 */
class FakeWatcher {
  closed = false;
  readonly errorHandlers: Array<(e: unknown) => void> = [];
  on(event: string, cb: (e: unknown) => void): this {
    if (event === "error") this.errorHandlers.push(cb);
    return this;
  }
  close(): void {
    this.closed = true;
  }
}

interface WatchCall {
  readonly target: string;
  readonly watcher: FakeWatcher;
  readonly cb: (eventType: string, filename: string | null) => void;
}

function makeFakeWatch(): { calls: WatchCall[]; watchFn: FsWatchAdapterDeps["watchFn"] } {
  const calls: WatchCall[] = [];
  const watchFn = ((target: string, ...rest: unknown[]) => {
    const watcher = new FakeWatcher();
    const cb = (typeof rest[0] === "function" ? rest[0] : rest[1]) as (
      eventType: string,
      filename: string | null,
    ) => void;
    calls.push({ target, watcher, cb });
    return watcher as unknown as FSWatcher;
  }) as unknown as FsWatchAdapterDeps["watchFn"];
  return { calls, watchFn };
}

function makeAdapter(watchFn: FsWatchAdapterDeps["watchFn"]): {
  adapter: FsWatchAdapter;
  calls: WatchCall[];
  events: FsWatchEvent[];
  root: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "fs-layered-"));
  const events: FsWatchEvent[] = [];
  const adapter = new FsWatchAdapter({ isIgnoredSegment: () => false, platform: "linux", watchFn });
  return { adapter, calls: [], events, root };
}

describe("layeredWatch：删除重建补挂与防环（seenTrees 覆盖记账）", () => {
  test("同名目录删除后重建 → 重新补挂 watcher，事件恢复送达（E-79 增量语义）", () => {
    const { calls, watchFn } = makeFakeWatch();
    const { adapter, events, root } = makeAdapter(watchFn);
    try {
      mkdirSync(path.join(root, "src", "doomed"), { recursive: true });
      adapter.watch(root, (e) => events.push(e));

      const callsFor = (p: string) => calls.filter((c) => c.target === p);
      const doomed = path.join(root, "src", "doomed");
      const src = calls.find((c) => c.target === path.join(root, "src"))!;
      expect(src).toBeDefined();
      expect(callsFor(doomed)).toHaveLength(1); // 初始遍历补挂

      // 删除子树：父 watcher 派发 rename（真实平台语义——子目录删除触发父 rename）
      rmSync(doomed, { recursive: true, force: true });
      src.cb("rename", "doomed");
      expect(callsFor(doomed)[0]!.watcher.closed).toBe(true); // stale 摘除

      // 重建：seenTrees 残留时 addTree 命中即 return 永不补挂（修复判据）
      mkdirSync(doomed, { recursive: true });
      src.cb("rename", "doomed");
      expect(callsFor(doomed)).toHaveLength(2); // 重新补挂

      // 新 watcher 事件恢复送达
      callsFor(doomed)[1]!.cb("change", "b.ts");
      expect(events.some((e) => e.path === path.join(doomed, "b.ts") && e.kind === "write")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("嵌套子树删除重建：前缀级 seenTrees 同步清除（mkdir -p 成片重建全树回管）", () => {
    const { calls, watchFn } = makeFakeWatch();
    const { adapter, root } = makeAdapter(watchFn);
    try {
      mkdirSync(path.join(root, "src", "a", "b"), { recursive: true });
      adapter.watch(root, () => {});
      const callsFor = (p: string) => calls.filter((c) => c.target === p);
      const a = path.join(root, "src", "a");
      const b = path.join(root, "src", "a", "b");
      const src = calls.find((c) => c.target === path.join(root, "src"))!;
      expect(callsFor(a)).toHaveLength(1);
      expect(callsFor(b)).toHaveLength(1);

      // 整棵 src/a 删除：stale 摘除含前缀嵌套（a 与 a/b）
      rmSync(a, { recursive: true, force: true });
      src.cb("rename", "a");
      expect(callsFor(a)[0]!.watcher.closed).toBe(true);
      expect(callsFor(b)[0]!.watcher.closed).toBe(true);

      // 成片重建（mkdir -p）：rename "a" → addTree(a) 递归下钻 a/b 全部回管
      mkdirSync(b, { recursive: true });
      src.cb("rename", "a");
      expect(callsFor(a)).toHaveLength(2);
      expect(callsFor(b)).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("防环语义保持：symlink 指回已 watch 树不重复挂、不成环", () => {
    const { calls, watchFn } = makeFakeWatch();
    const { adapter, root } = makeAdapter(watchFn);
    try {
      mkdirSync(path.join(root, "src"), { recursive: true });
      symlinkSync(root, path.join(root, "src", "loop")); // 环：src/loop → root
      adapter.watch(root, () => {});

      // loop 的 realpath = root（已在防环集合）→ 不为 loop 挂 watcher
      expect(calls.filter((c) => c.target === path.join(root, "src", "loop"))).toHaveLength(0);
      // 树本身正常挂接（root + src，各恰一次）
      expect(calls.filter((c) => c.target === root)).toHaveLength(1);
      expect(calls.filter((c) => c.target === path.join(root, "src"))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("watcher error 自闭合（目录被删等）→ seenTrees 同步出册，重建后回管", () => {
    const { calls, watchFn } = makeFakeWatch();
    const { adapter, root } = makeAdapter(watchFn);
    try {
      mkdirSync(path.join(root, "gone"), { recursive: true });
      adapter.watch(root, () => {});
      const callsFor = (p: string) => calls.filter((c) => c.target === p);
      const gone = path.join(root, "gone");
      expect(callsFor(gone)).toHaveLength(1);

      // 目录删除以 error 形态到达（部分平台）：自闭合摘除
      rmSync(gone, { recursive: true, force: true });
      callsFor(gone)[0]!.watcher.errorHandlers[0]!(new Error("dir gone"));
      expect(callsFor(gone)[0]!.watcher.closed).toBe(true);

      // 重建回管（rename 路径）
      mkdirSync(gone, { recursive: true });
      const rootCall = calls.find((c) => c.target === root)!;
      rootCall.cb("rename", "gone");
      expect(callsFor(gone)).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
