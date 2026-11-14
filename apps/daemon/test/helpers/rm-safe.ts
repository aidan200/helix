/**
 * 测试面目录清理 Windows 兜底（TR-95 win32-x64 兼容面）。
 *
 * 背景：daemon 测试大量用 mkdtemp 建 home/workspace，teardown 用
 * rmSync(recursive, force) 清理。Windows 上 SQLite（bun:sqlite WAL）/
 * better-sqlite3 的文件句柄释放是异步的——daemon.shutdown() 返回后
 * 立即 rmSync 常撞 EBUSY/EPERM（句柄尚未全关），CI windows runner 实证
 * （agent-config-ws.test.ts 全文件挂）。mac 上无此语义（句柄释放同步）。
 *
 * 形态变更（第一版教训）：第一版用 node rmSync 原生 maxRetries/retryDelay
 * ——bun 1.4.2 实测不生效（oven-sh/bun#39003：fs.rmSync 解析但从不重试，
 * Windows EBUSY 立即抛；修复 PR 停滞被关）。故本模块 JS 层自实现线性退避
 * 重试循环，不依赖运行时该参数。bun 修复 maxRetries 后可回归原生形态。
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

/**
 * 递归删除（Windows EBUSY/EPERM 重试兜底）。
 * 语义对齐 rmSync(path, { recursive: true, force: true })——不存在静默成功
 * （force），追加线性退避重试（maxRetries 次，第 n 次等 n×retryDelay ms——
 * 与 node 官方重试时序一致；posix 上首轮即成功，重试面不触发零差异）。
 */
export function rmSyncWindowsSafe(p: string): void {
  const maxRetries = 10;
  const retryDelay = 100;
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(p, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code ?? "";
      if (attempt >= maxRetries || !RETRYABLE.has(code)) throw e;
      sleepSync((attempt + 1) * retryDelay);
    }
  }
}
