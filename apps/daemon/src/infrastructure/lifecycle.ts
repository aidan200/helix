import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Logger } from "./logging";

/**
 * 进程生命周期（architecture.md §3.6）：单例幂等锁（AG-17 / AD-7）+
 * 进程级崩溃钩子。
 *
 * 同一 `--home` 的 daemon 全局单例：锁文件 `<home>/daemon.lock` 记录持有
 * 进程 pid——第二实例启动时检测到锁且持有进程存活 → 拒绝启动（中文报错，
 * 退出码非 0，不产生双写者）；持有进程已死（崩溃遗留）→ 抢占接管，并在
 * 返回的锁上携带 `previousCrash`（接管签名——优雅关闭必经 release() 删除
 * 锁文件，遗留锁 + 死 pid 即「上次未优雅退出」，组合根据此记 WARN 供追溯）。
 * 幂等：同进程内重复 acquire 同样拒绝（第一把锁即自己，视为二启）。
 */
export interface SingletonLock {
  readonly lockPath: string;
  readonly pid: number;
  /** 陈锁接管事实（非正常退出签名）：被接管的 {pid, startedAt}；正常获取（无遗留锁）为 undefined。 */
  readonly previousCrash?: { readonly pid: number; readonly startedAt: string };
  /** 释放锁（优雅退出时调用；幂等）。 */
  release(): void;
}

/** 信号 0 存活探测：ESRCH=不存在（false）；EPERM=存在但无权发信号（true，
 *  存活）——对齐 parent-watchdog defaultAliveOf 口径，防「活着但无权探测」的
 *  锁持有者被误判已死而遭接管击穿单例。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // 信号 0 = 只探测存活，不实际发送
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 获取单例锁；同 home 已有存活实例（含自己）时抛错。 */
export function acquireSingletonLock(lockPath: string): SingletonLock {
  // 独占创建（O_CREAT|O_EXCL，code-review H13）：existsSync→writeFileSync
  // 检查-创建分离时并发二启双双通过检查各自写锁，AG-17 被击穿；wx 把
  // 「检查不存在+创建」收口为单次原子系统调用（对齐 auth-store withFileLock 先例）。
  let takeover: { pid: number; startedAt: string } | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
      } finally {
        closeSync(fd); // 写失败（如磁盘满）也必须关 fd，否则泄漏
      }
      let released = false;
      return {
        lockPath,
        pid: process.pid,
        ...(takeover !== undefined ? { previousCrash: takeover } : {}),
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
      let heldStartedAt: string | undefined;
      try {
        const held = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown; startedAt?: unknown };
        heldBy = Number.parseInt(String(held.pid), 10);
        heldStartedAt = typeof held.startedAt === "string" ? held.startedAt : undefined;
      } catch {
        heldBy = undefined;
      }
      if (heldBy !== undefined && Number.isFinite(heldBy) && isProcessAlive(heldBy)) {
        throw new Error(
          `daemon 已在运行（home 已被 pid=${heldBy} 的实例锁定：${lockPath}）。` +
            `同一 --home 只允许一个实例；如需另开会话请用不同 --home。`,
        );
      }
      if (heldBy !== undefined && Number.isFinite(heldBy)) {
        // 接管签名（startedAt 缺失以空串兜底——损坏行仍判接管但无时间锚）
        takeover = { pid: heldBy, startedAt: heldStartedAt ?? "" };
      }
      rmSync(lockPath, { force: true }); // 陈锁清除后下轮重试独占创建
    }
  }
  // 两轮均 EEXIST：并发接管者抢先建锁且其锁行未通过存活判定——如实报错不抢
  throw new Error(`单例锁竞争失败（并发接管冲突）：${lockPath}。请重试启动。`);
}

/** 进程级崩溃钩子幂等位（assembleDaemon 每进程只装一次——测试装配防重复累积 listener）。 */
let crashLoggingInstalled = false;

/**
 * 进程级崩溃钩子（可观测兜底）：uncaughtException / unhandledRejection
 * 先落一行 ERROR（同步追加——崩溃路径不依赖异步 flush），再非零退出。
 * 行为契约不变（fail-loud：默认语义本就是崩溃退出），只补「留痕」——
 * 崩溃无痕是 2026-09-14 事故（12:41Z daemon 无已关闭行暴毙、零线索）的
 * 直接教训。幂等：同进程重复调用为 no-op（测试多次装配）。
 */
export function installCrashLogging(logger: Pick<Logger, "error">): void {
  if (crashLoggingInstalled) return;
  crashLoggingInstalled = true;
  // 测试进程不接管（bun test 已对 unhandled rejection 有自己的失败语义；
  // 此处 exit(1) 会杀整个 runner）——进程级接管仅限生产 daemon 进程。
  if (process.env.BUN_TEST === "1") return;
  const describe = (kind: string, reason: unknown): string => {
    const detail =
      reason instanceof Error ? (reason.stack ?? reason.message) : typeof reason === "string" ? reason : JSON.stringify(reason);
    return `进程崩溃（${kind}）：${detail}`;
  };
  process.on("uncaughtException", (err: Error) => {
    logger.error(describe("uncaughtException", err));
    process.exit(1);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error(describe("unhandledRejection", reason));
    process.exit(1);
  });
}
