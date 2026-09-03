import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * 进程生命周期（architecture.md §3.6）：单例幂等锁（AG-17 / AD-7）。
 *
 * 同一 `--home` 的 daemon 全局单例：锁文件 `<home>/daemon.lock` 记录持有
 * 进程 pid——第二实例启动时检测到锁且持有进程存活 → 拒绝启动（中文报错，
 * 退出码非 0，不产生双写者）；持有进程已死（崩溃遗留）→ 抢占接管。
 * 幂等：同进程内重复 acquire 同样拒绝（第一把锁即自己，视为二启）。
 */
export interface SingletonLock {
  readonly lockPath: string;
  readonly pid: number;
  /** 释放锁（优雅退出时调用；幂等）。 */
  release(): void;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // 信号 0 = 只探测存活，不实际发送
    return true;
  } catch {
    return false;
  }
}

/** 获取单例锁；同 home 已有存活实例（含自己）时抛错。 */
export function acquireSingletonLock(lockPath: string): SingletonLock {
  // 独占创建（O_CREAT|O_EXCL，code-review H13）：existsSync→writeFileSync
  // 检查-创建分离时并发二启双双通过检查各自写锁，AG-17 被击穿；wx 把
  // 「检查不存在+创建」收口为单次原子系统调用（对齐 auth-store withFileLock 先例）。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
      closeSync(fd);
      let released = false;
      return {
        lockPath,
        pid: process.pid,
        release(): void {
          if (released) return;
          released = true;
          try {
            rmSync(lockPath, { force: true });
          } catch {
            // 释放失败不影响退出
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // 锁已存在：持有进程存活 → 拒绝；已死（含损坏锁文件视同无主）→ 接管
      let heldBy: number | undefined;
      try {
        heldBy = Number.parseInt(JSON.parse(readFileSync(lockPath, "utf8")).pid, 10);
      } catch {
        heldBy = undefined;
      }
      if (heldBy !== undefined && Number.isFinite(heldBy) && isProcessAlive(heldBy)) {
        throw new Error(
          `daemon 已在运行（home 已被 pid=${heldBy} 的实例锁定：${lockPath}）。` +
            `同一 --home 只允许一个实例；如需另开会话请用不同 --home。`,
        );
      }
      rmSync(lockPath, { force: true }); // 陈锁清除后下轮重试独占创建
    }
  }
  // 两轮均 EEXIST：并发接管者抢先建锁且其锁行未通过存活判定——如实报错不抢
  throw new Error(`单例锁竞争失败（并发接管冲突）：${lockPath}。请重试启动。`);
}
