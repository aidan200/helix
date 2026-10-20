/**
 * createDaemon 锁释放兜底单测（评审 low #30）。
 *
 * 缺陷面：acquireSingletonLock 之后若装配前段抛错（典型：config.json 非法
 * JSON → loadConfig throw），daemon.lock 遗留——下次启动被当陈锁接管，误报
 * 「上次非正常退出」（previousCrash 假信号），且遗留锁文件本身无主。
 *
 * 断言面：装配前段抛错 → ①错误原样上抛（不吞）；②daemon.lock 已删除；
 * ③再次 acquire 拿到的是「无遗留锁」（previousCrash === undefined）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "../../src/infrastructure/container";
import { acquireSingletonLock } from "../../src/infrastructure/lifecycle";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("createDaemon 装配前段失败：单例锁必须释放（评审 low #30）", () => {
  test("config.json 非法 JSON → 抛错且 daemon.lock 不遗留（下次启动无陈锁接管信号）", async () => {
    const home = mkdtempSync(join(tmpdir(), "helix-lock-release-"));
    tmpDirs.push(home);
    writeFileSync(join(home, "config.json"), "{ 这不是 JSON", "utf8");

    await expect(createDaemon({ home })).rejects.toThrow();

    // 锁文件已释放（遗留锁 → 下次启动误报「上次非正常退出」）
    expect(existsSync(join(home, "daemon.lock"))).toBe(false);
    const again = acquireSingletonLock(join(home, "daemon.lock"));
    expect(again.previousCrash).toBeUndefined();
    again.release();
  });
});
