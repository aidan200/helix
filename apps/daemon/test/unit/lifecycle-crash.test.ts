import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireSingletonLock, installCrashLogging } from "../../src/infrastructure/lifecycle";
import { createFileLogger } from "../../src/infrastructure/logging";

/**
 * 陈锁接管签名（previousCrash）+ 进程级崩溃钩子留痕：
 * - 遗留锁（死 pid）接管 → previousCrash 携带 {pid, startedAt}；
 *   正常获取（无遗留锁）→ undefined；存活持锁者照旧拒绝。
 * - installCrashLogging：unhandledRejection → ERROR 落盘 + 退出码 1
 *   （子进程实测——process.exit 不能在测试进程内触发）。
 */
const tmpRoots: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

/** 不会存活的 pid（macOS pid 上限远低于 4e6；linux 默认上限同量级安全）。 */
const DEAD_PID = 4_000_000;

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("陈锁接管签名（previousCrash）", () => {
  test("死 pid 遗留锁接管 → previousCrash 携带 {pid, startedAt}", () => {
    const lockPath = path.join(makeDir("helix-lock-"), "daemon.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, startedAt: "2026-09-14T12:38:22.475Z" }), "utf8");
    const lock = acquireSingletonLock(lockPath);
    expect(lock.previousCrash).toEqual({ pid: DEAD_PID, startedAt: "2026-09-14T12:38:22.475Z" });
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("正常获取（无遗留锁）→ previousCrash undefined", () => {
    const lockPath = path.join(makeDir("helix-lock-"), "daemon.lock");
    const lock = acquireSingletonLock(lockPath);
    expect(lock.previousCrash).toBeUndefined();
    lock.release();
  });
});

describe("installCrashLogging 崩溃留痕", () => {
  test("unhandledRejection → ERROR 落盘 + 退出码 1（子进程实测）", async () => {
    const dir = makeDir("helix-crash-");
    // 路径锚定本测试文件（import.meta.dir）而非进程 cwd——CI 从仓根跑
    // `bun test apps/daemon`，path.resolve 相对 cwd 会解析到仓根下不存在的 src/。
    const childSrc = `
import { installCrashLogging } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/infrastructure/lifecycle"))};
import { createFileLogger } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/infrastructure/logging"))};
installCrashLogging(createFileLogger(${JSON.stringify(dir)}));
Promise.reject(new Error("boom-probe"));
`;
    const scriptPath = path.join(dir, "crash-probe.ts");
    writeFileSync(scriptPath, childSrc, "utf8");
    const proc = Bun.spawnSync(["bun", scriptPath], {
      cwd: import.meta.dir,
      env: { ...process.env, BUN_TEST: "" }, // 洗掉测试标记：验证生产接管路径
    });
    expect(proc.exitCode).toBe(1);
    const day = new Date().toISOString().slice(0, 10);
    const log = readFileSync(path.join(dir, `daemon-${day}.log`), "utf8");
    expect(log).toContain("[ERROR] 进程崩溃（unhandledRejection）");
    expect(log).toContain("boom-probe");
  }, 15_000);
});

describe("陈锁接管竞态（评审 F1：盲删新锁窗口）", () => {
  test("判死后窗口内被并发接管者重建的活锁不得被删——拒绝而非接管（AG-17 双写者防线）", () => {
    const lockPath = path.join(makeDir("helix-lock-race-"), "daemon.lock");
    const stale = JSON.stringify({ pid: DEAD_PID, startedAt: "2026-09-14T12:38:22.475Z" });
    writeFileSync(lockPath, stale, "utf8");
    let winnerLock: string | undefined;
    expect(() =>
      acquireSingletonLock(lockPath, {
        // 模拟并发接管者：本进程「读陈锁→判死」与「清除重建」之间，它已
        // 抢先重建了新锁（活持有者 = 本测试进程）
        afterStaleJudge: () => {
          winnerLock = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
          writeFileSync(lockPath, winnerLock, "utf8");
        },
      }),
    ).toThrow("已在运行");
    // 并发接管者的新锁完好无损（未被后来者盲删顶替）
    expect(readFileSync(lockPath, "utf8")).toBe(winnerLock!);
  });
});
