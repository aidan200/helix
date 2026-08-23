/**
 * startParentWatchdog 单测（H-4：sidecar 父死看门狗判据面）。
 *
 * sidecar 形态专属：壳恒直 spawn 且终身看护，父死（SIGKILL/崩溃/Ctrl+C
 * 前台组广播秒杀壳）→ sidecar 被 reparent 到 pid 1 → 判孤儿 → 优雅关停，
 * 防孤儿持单例锁砖化下次启动。判据/动作/间隔全注入（真进程零依赖）。
 */
import { describe, expect, test } from "bun:test";
import { startParentWatchdog } from "../../src/infrastructure/parent-watchdog";

/** 可控 ppid 序列源。 */
function ppidSource(initial: number) {
  let current = initial;
  return {
    get: () => current,
    set: (v: number) => {
      current = v;
    },
  };
}

describe("startParentWatchdog（H-4 父死看门狗）", () => {
  test("ppid 恒 >1（父存活）→ onOrphan 不触发", async () => {
    const src = ppidSource(1234);
    let fired = 0;
    const stop = startParentWatchdog({ ppidOf: src.get, intervalMs: 5, onOrphan: () => fired++ });
    await Bun.sleep(30); // 约 6 个 tick
    expect(fired).toBe(0);
    stop();
  });

  test("ppid 变为 1（父死 reparent）→ onOrphan 触发且仅一次（触发后自停）", async () => {
    const src = ppidSource(1234);
    let fired = 0;
    startParentWatchdog({ ppidOf: src.get, intervalMs: 5, onOrphan: () => fired++ });
    await Bun.sleep(12); // 父存活期若干 tick
    expect(fired).toBe(0);
    src.set(1); // 壳死亡，reparent 到 launchd
    await Bun.sleep(40); // 多 tick：一次性判定（不得重复触发）
    expect(fired).toBe(1);
  });

  test("stop() 后 ppid 变 1 也不触发（关停竞态收口）", async () => {
    const src = ppidSource(1234);
    let fired = 0;
    const stop = startParentWatchdog({ ppidOf: src.get, intervalMs: 5, onOrphan: () => fired++ });
    stop();
    src.set(1);
    await Bun.sleep(25);
    expect(fired).toBe(0);
  });

  test("spawn 即孤儿（ppid 起始 = 1）→ 首个 tick 触发（父已不在，孤儿语义成立）", async () => {
    const src = ppidSource(1);
    let fired = 0;
    startParentWatchdog({ ppidOf: src.get, intervalMs: 5, onOrphan: () => fired++ });
    await Bun.sleep(25);
    expect(fired).toBe(1);
  });
});
