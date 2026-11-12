/**
 * SQLite IOERR 判定（kg 韧性批）：连接坏态（disk I/O error 类）甄别——
 * 读面 per-project 容错与 evict 自愈的共用判定。application 层消费，
 * 不 import adapters（TR-AD-1 口径）——按错误形状鸭子判别。
 *
 * 判定面两类（任一命中即 true）：
 * - bun:sqlite SQLiteError.code 前缀 SQLITE_IOERR（含 _READ/_WRITE 等子码）；
 * - message 含 "disk I/O error"（跨层包装后 code 可能丢失——文案兜底）。
 */
export function isIoError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("SQLITE_IOERR")) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.includes("disk I/O error");
}
