import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireSingletonLock } from "../../src/infrastructure/lifecycle";

/**
 * AG-17（I 半，进程内）：同一 home 的单例幂等锁——
 * ① 首次 acquire 成功；② 未释放前二次 acquire 拒绝（含同进程幂等）；
 * ③ release 后可重新 acquire；④ 崩溃遗留锁（持有进程已死）可抢占。
 */
describe("单例幂等锁（AG-17）", () => {
  test("acquire → 二启拒绝 → release → 可重获", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-lock-"));
    const lockPath = path.join(dir, "daemon.lock");
    try {
      const first = acquireSingletonLock(lockPath);
      expect(first.pid).toBe(process.pid);

      expect(() => acquireSingletonLock(lockPath)).toThrow(/已在运行/); // 二启拒绝（同进程=幂等）

      first.release();
      const second = acquireSingletonLock(lockPath); // 释放后可重获
      expect(second.pid).toBe(process.pid);
      second.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("持有进程已死的遗留锁可抢占（崩溃恢复）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "helix-lock-"));
    const lockPath = path.join(dir, "daemon.lock");
    try {
      // 伪造一个「pid 不存在」的遗留锁
      const { writeFileSync } = require("node:fs");
      writeFileSync(lockPath, JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }));
      const lock = acquireSingletonLock(lockPath); // 不抛：抢占接管
      expect(lock.pid).toBe(process.pid);
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
