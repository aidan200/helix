/**
 * 测试面目录清理 Windows 兜底（TR-95 win32-x64 兼容面）。
 *
 * 背景：daemon 测试大量用 mkdtemp 建 home/workspace，teardown 用
 * rmSync(recursive, force) 清理。Windows 上 SQLite（bun:sqlite WAL）/
 * better-sqlite3 的文件句柄释放是异步的——daemon.shutdown() 返回后
 * 立即 rmSync 常撞 EBUSY/EPERM（句柄尚未全关），CI windows runner 实证
 * （agent-config-ws.test.ts 全文件挂）。mac 上无此语义（句柄释放同步）。
 *
 * 形态（五轮迭代收敛，教训链完整留痕）：
 * - v1 node rmSync 原生 maxRetries/retryDelay——bun 1.4.2 实测不生效
 *   （oven-sh/bun#39003：fs.rmSync 解析但从不重试，Windows EBUSY 立即抛；
 *   修复 PR 停滞已关）。故 JS 层自实现重试循环。
 * - v2 线性 10×100ms 重试穷尽后 throw 仍红（部分场景句柄释放窗 >5.5s）。
 * - v3 十六次指数退避 ~11s/次——把 windows job 拖过 30min timeout 被杀
 *   （CI run 43573114560）。
 * - v4 线性 10 次短窗（5.5s/次）+ 穷尽软失败——重试窗仍过长：满盘 fixture
 *   触发时【量×窗】又把 4232 测试拖过 timeout（CI run 43580403633）。
 * - v5 终形态：**短窗 3 次×100ms（≤600ms/次）+ 穷尽软失败**——打穿慢释放型
 *   （多数场景首次重试即成）；打不穿的软失败 warn 不抛（CI tmp 目录由
 *   runner 管理生命周期，job 结束 worker 销毁，残留无害；vitest/jest
 *   Windows 生态通行处理）；不可重试错误仍原样抛（断言面不受影响）。
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

/** 重试参数（短窗 3 次×100ms = 总窗 ≤600ms；重试窗长短直接乘进总时长：
 * windows runner 上满盘 fixture 触发重试时，v3 指数退避（~11s/次）与
 * v4 线性 10 次（~5.5s/次）都把 4232 测试拖过 30min job timeout（CI run
 * 43573114560 / 43580403633 两轮实证）——量×窗超时。短窗 + 穷尽软失败
 * 是终形态：打穿慢释放型（多数场景首次重试即成），打不穿的残留由
 * runner 生命周期回收）。 */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 100;

/** 软失败 warn 面缺省（可被测试注入捕获断言）。 */
export function rmWarnDefault(message: string): void {
  console.warn(message);
}

/**
 * 递归删除（Windows EBUSY/EPERM 重试兜底 + 穷尽软失败）。
 * 语义对齐 rmSync(path, { recursive: true, force: true })——不存在静默成功
 * （force）；win 撞可重试错误码 → 线性退避重试；穷尽仍失败 → **warn 不抛**
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
      sleepSync((attempt + 1) * RETRY_DELAY_MS); // 线性退避（100ms 步进）
    }
  }
}
