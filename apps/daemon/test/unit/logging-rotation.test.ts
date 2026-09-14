import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileLogger } from "../../src/infrastructure/logging";

/**
 * 日志按天拆分（daemon-<YYYY-MM-DD>.log）：同日追加同文件；跨天首笔
 * 懒切新文件（UTC 口径，与行时间戳一致）；旧文件不清理不迁移。
 * fixture 落 tmp 目录，不触碰真实 ~/.helix。
 */
const tmpRoots: string[] = [];

function makeLogsDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-logs-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("createFileLogger 按天拆分", () => {
  test("同日追加同一日文件", () => {
    const dir = makeLogsDir();
    const logger = createFileLogger(dir, "daemon.log", () => new Date("2026-09-14T10:00:00.000Z"));
    logger.info("a");
    logger.warn("b");
    const file = path.join(dir, "daemon-2026-09-14.log");
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[INFO] a");
    expect(lines[1]).toContain("[WARN] b");
  });

  test("跨天首笔写入懒切新文件（UTC 口径）", () => {
    const dir = makeLogsDir();
    let now = new Date("2026-09-14T23:59:59.500Z");
    const logger = createFileLogger(dir, "daemon.log", () => now);
    logger.info("day1");
    now = new Date("2026-09-15T00:00:00.100Z"); // 跨 UTC 日界
    logger.error("day2");
    const day1 = readFileSync(path.join(dir, "daemon-2026-09-14.log"), "utf8");
    const day2 = readFileSync(path.join(dir, "daemon-2026-09-15.log"), "utf8");
    expect(day1).toContain("day1");
    expect(day1).not.toContain("day2");
    expect(day2).toContain("[ERROR] day2");
    expect(day2).not.toContain("day1");
  });

  test("无扩展名自定文件名原样拼日段（测试面）", () => {
    const dir = makeLogsDir();
    const logger = createFileLogger(dir, "probe", () => new Date("2026-09-14T01:00:00.000Z"));
    logger.info("x");
    expect(existsSync(path.join(dir, "probe-2026-09-14"))).toBe(true);
  });
});
