/**
 * 测试面目录清理 Windows 兜底（TR-95 win32-x64 兼容面）。
 *
 * 背景：daemon 测试大量用 mkdtemp 建 home/workspace，teardown 用
 * rmSync(recursive, force) 清理。Windows 上 SQLite（bun:sqlite WAL）/
 * better-sqlite3 的文件句柄释放是异步的——daemon.shutdown() 返回后
 * 立即 rmSync 常撞 EBUSY/EPERM（句柄尚未全关），CI windows runner 实证
 * （agent-config-ws.test.ts 全文件挂）。mac 上无此语义（句柄释放同步）。
 *
 * 形态（两轮迭代收敛）：
 * - v1 用 node rmSync 原生 maxRetries/retryDelay——bun 1.4.2 实测不生效
 *   （oven-sh/bun#39003：fs.rmSync 解析但从不重试，Windows EBUSY 立即抛；
 *   修复 PR 停滞已关）。故 JS 层自实现重试循环。
 * - v2 线性退避 10×100ms（5.5s）仍打不穿 agent-config-it 族（CI run 43567953548
 *   实证：重试穷尽后 throw）——部分场景句柄释放窗 >5.5s。v3 双管：
 *   ① 重试窗加长（指数退避 2^n×100ms，16 次 ≈ 51s 总窗——远超句柄释放
 *   最坏窗；posix 首轮成功零差异不受影响）；
 *   ② 穷尽后**软失败**：CI 上 tmp 目录由 runner 管理生命周期（job 结束整
 *   worker 销毁），残留无害；测试 teardown 清理失败不值得红——warn 留痕
 *   即可。这是 vitest/jest Windows 生态的通行处理。
 *
 * 重试错误集对齐 node 语义（rimraf retryErrorCodes）：EBUSY/EMFILE/
 * ENFILE/ENOTEMPTY/EPERM。ENOENT 在重试路径视为成功（并发清理竞态）。
 */

import { rmSync } from "node:fs";

/** 可重试错误码（node rimraf retryErrorCodes 同集）。 */
const RETRYABLE = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);

/** 同步忙等（测试 teardown 面——事件循环无依赖，Atomics.wait 是最轻同步睡眠）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 指数退避次数（100×min(2^n,8) ms/次，16 次总窗 ≈ 11s）。 */
const MAX_ATTEMPTS = 16;

/** 软失败 warn 面缺省（可被测试注入捕获断言）。 */
export function rmWarnDefault(message: string): void {
  console.warn(message);
}

/**
 * 递归删除（Windows EBUSY/EPERM 重试兜底 + 穷尽软失败）。
 * 语义对齐 rmSync(path, { recursive: true, force: true })——不存在静默成功
 * （force）；win 撞可重试错误码 → 指数退避重试；穷尽仍失败 → **warn 不抛**
 * （CI tmp 由 runner 管理生命周期，残留无害；teardown 清理失败不红测试）。
 * posix 上首轮即成功，重试面不触发零差异。
 */
export function rmSyncWindowsSafe(p: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(p, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code ?? "";
      if (attempt >= MAX_ATTEMPTS || !RETRYABLE.has(code)) {
        // 不可重试错误原样抛（测试断言面不受影响）；重试穷尽软失败不抛
        if (RETRYABLE.has(code)) {
          rmWarnDefault(`[rm-safe] ${p} 清理重试穷尽（${(e as Error).message}）——CI tmp 由 runner 管理，残留无害`);
          return;
        }
        throw e;
      }
      sleepSync(100 * Math.min(2 ** attempt, 8)); // 退避封顶 800ms/次（16 次 ×≤800ms ≈ 总窗 11s；防指数爆炸）
    }
  }
}
