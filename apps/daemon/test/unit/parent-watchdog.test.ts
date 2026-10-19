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

  // win32 兼容面（TR-95）：win32 无 ppid→1 reparent 语义，ppid 滞留死父 pid，
  // 孤儿判据靠 aliveOf 存活探测；注入 aliveOf 即启用探测（posix 缺省不启用）。
  test("win32 语义：ppid 滞留但 aliveOf 判父已死 → onOrphan 触发且仅一次", async () => {
    const src = ppidSource(1234); // win32：父死后 ppid 滞留不变
    let alive = true;
    let fired = 0;
    startParentWatchdog({
      ppidOf: src.get,
      aliveOf: () => alive,
      intervalMs: 5,
      onOrphan: () => fired++,
    });
    await Bun.sleep(15); // 父存活期若干 tick
    expect(fired).toBe(0);
    alive = false; // 壳死亡（win32：ppid 不重挂）
    await Bun.sleep(40);
    expect(fired).toBe(1);
  });

  test("win32 语义：aliveOf 恒存活 + ppid >1 → onOrphan 不触发", async () => {
    const src = ppidSource(1234);
    let fired = 0;
    const stop = startParentWatchdog({
      ppidOf: src.get,
      aliveOf: () => true,
      intervalMs: 5,
      onOrphan: () => fired++,
    });
    await Bun.sleep(30);
    expect(fired).toBe(0);
    stop();
  });
});

describe("startParentWatchdog（TR-218：定时器回调异常兑底——不上抛击穿宿主）", () => {
  test("探测面抛错 → warn 降级不击穿，下周期重试续航（判据恢复后正常判孤儿）", async () => {
    const src = ppidSource(1234);
    const warns: string[] = [];
    let fired = 0;
    let probeFailures = 1; // 首个 tick 抛错，之后恢复
    const stop = startParentWatchdog({
      ppidOf: () => {
        if (probeFailures > 0) {
          probeFailures -= 1;
          throw new Error("ppid 探测失效");
        }
        return src.get();
      },
      intervalMs: 5,
      warn: (m) => warns.push(m),
      onOrphan: () => {
        fired++;
      },
    });
    await Bun.sleep(30); // 抛错 tick 已过（兑底不击穿 = 测试进程存活即证）
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("ppid 探测失效");
    src.set(1); // 探测恢复后父死 reparent
    await Bun.sleep(40);
    expect(fired).toBe(1); // 下周期重试正常判孤儿
    stop();
  });

  test("onOrphan 抛错 → 不上抛击穿宿主（触发已消费，warn 留痕）", async () => {
    const src = ppidSource(1);
    const warns: string[] = [];
    const stop = startParentWatchdog({
      ppidOf: src.get,
      intervalMs: 5,
      warn: (m) => warns.push(m),
      onOrphan: () => {
        throw new Error("关停动作失效");
      },
    });
    await Bun.sleep(30);
    expect(warns.some((w) => w.includes("关停动作失效"))).toBe(true);
    stop();
  });
});
