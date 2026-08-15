import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * 日志（architecture.md §3.6）：写 `<home>/logs/daemon.log`。
 *
 * 最小实现：行式追加（进程内单写，无滚动——M3 壳接入后再评估轮转）。
 * 时间戳取自系统时钟（日志不是领域数据，不经 ClockPort）。
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createFileLogger(logsDir: string, fileName = "daemon.log"): Logger {
  mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, fileName);
  const log = (level: string, message: string): void => {
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    try {
      appendFileSync(file, line, "utf8");
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
