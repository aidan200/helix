/**
 * 测试面目录清理 Windows 兜底（TR-95 win32-x64 兼容面）。
 *
 * 背景：daemon 测试大量用 mkdtemp 建 home/workspace，teardown 用
 * rmSync(recursive, force) 清理。Windows 上 SQLite（bun:sqlite WAL）/
 * better-sqlite3 的文件句柄释放是异步的——daemon.shutdown() 返回后
 * 立即 rmSync 常撞 EBUSY/EPERM（句柄尚未全关），CI windows runner 实证
 * （agent-config-ws.test.ts 全文件挂）。mac 上无此语义（句柄释放同步）。
 *
 * 形态：node rmSync 原生 maxRetries + retryDelay（node 20.12+/bun 支持，
 * Windows EBUSY/EPERM 官方解）——posix 上零行为差异（首轮即成功，重试
 * 面不触发）。集中本模块单点，测试清理面逐步迁入。
 */

import { rmSync } from "node:fs";

/**
 * 递归删除（Windows EBUSY/EPERM 重试兜底）。
 * 语义对齐 rmSync(path, { recursive: true, force: true })——不存在静默成功
 * （force），仅追加 maxRetries/retryDelay 两参（Windows 句柄释放竞态的
 * 官方重试通道；posix 零行为差异）。
 */
export function rmSyncWindowsSafe(p: string): void {
  rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
