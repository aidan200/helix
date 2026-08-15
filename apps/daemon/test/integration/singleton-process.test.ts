import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireSingletonLock } from "../../src/infrastructure/lifecycle";

/**
 * AG-17（I 半，进程级）：同一 `--home` 二次启动 daemon 进程 → 第二实例
 * 被单例锁拒绝（非 0 退出 + 中文报错）。锁由本测试进程先持有（等价于
 * 第一实例存活），被测进程为真实 main.ts 入口。
 */
describe("daemon 进程级二启拒绝（AG-17）", () => {
  test("同 --home 第二实例启动即退出（exitCode≠0，报已在运行）", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-daemon-2nd-"));
    try {
      const lock = acquireSingletonLock(path.join(home, "daemon.lock")); // 模拟第一实例
      const mainTs = path.join(import.meta.dir, "..", "..", "src", "main.ts");

      const proc = Bun.spawn({
        cmd: [process.execPath, mainTs, "--home", home],
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      expect(exitCode).not.toBe(0);
      expect(stdout + stderr).toContain("已在运行");
      lock.release();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});
