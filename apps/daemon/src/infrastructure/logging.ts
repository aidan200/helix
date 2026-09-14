import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * 日志（architecture.md §3.6）：写 `<home>/logs/daemon-<YYYY-MM-DD>.log`
 * （按天拆分——UTC 日期，与行时间戳 toISOString 同口径；跨天首笔写入即
 * 懒切文件，旧文件保留不清理）。
 *
 * 行式追加（进程内单写；日志不是领域数据，不经 ClockPort——now 注入面
 * 仅为测试切日判定）。
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** 日期文件名段（UTC）：跨天判定与文件名共用单点。 */
function dayKeyOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function createFileLogger(
  logsDir: string,
  fileName = "daemon.log",
  now: () => Date = () => new Date(),
): Logger {
  mkdirSync(logsDir, { recursive: true });
  // 按 fileName 拆 base/ext（"daemon.log" → "daemon" / ".log"），日文件 =
  // `<base>-<YYYY-MM-DD><ext>`；无扩展名（测试自定名）原样拼接。
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  let currentDay = dayKeyOf(now());
  const fileOf = (day: string): string => path.join(logsDir, `${base}-${day}${ext}`);
  const log = (level: string, message: string): void => {
    const at = now();
    const day = dayKeyOf(at);
    if (day !== currentDay) currentDay = day; // 跨天懒切（追加模型无需迁移）
    const line = `[${at.toISOString()}] [${level}] ${message}\n`;
    try {
      appendFileSync(fileOf(currentDay), line, "utf8");
    } catch {
      // 日志失败不阻断 daemon（日志不是关键路径）
    }
  };
  return {
    info: (m) => log("INFO", m),
    warn: (m) => log("WARN", m),
    error: (m) => log("ERROR", m),
  };
}
