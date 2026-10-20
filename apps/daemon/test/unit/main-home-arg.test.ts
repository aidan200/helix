/**
 * main.ts --home 参数校验单测（评审 low #29）。
 *
 * 缺陷面：`--home` 缺值时静默回落 ~/.helix（与 --port 的 fail-fast 不一致），
 * 且 `--home --port 8080` 会把 "--port" 当 home 路径（建出怪目录、用户以为
 * 换了 home 实际没换）。修复后：缺值/值像另一个 flag → 中文报错 + 退出码 1。
 *
 * 断言面（子进程真启，进程内 process.exit 无法拦截）：exit code 1 + stderr
 * 含「--home 参数非法」，且不落任何目录。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = join(import.meta.dir, "../../src/main.ts");

async function runMain(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  return { code, stderr };
}

describe("main.ts --home 参数校验（评审 low #29）", () => {
  test("--home 缺值 → 退出码 1 + 中文报错", async () => {
    const r = await runMain(["--home"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--home 参数非法");
  });

  test("--home 值像另一个 flag（--home --port 8080）→ 退出码 1，不把 --port 当目录", async () => {
    const r = await runMain(["--home", "--port", "8080"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--home 参数非法");
  });

  test("--home 合法值不进本闸（后续装配阶段自行失败也不出该报错）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "helix-main-home-"));
    try {
      const r = await runMain(["--home", dir, "--port", "not-a-port"]);
      // 走到 --port 校验（证明 --home 未被误判），且 home 下未建怪目录
      expect(r.stderr).toContain("--port 参数非法");
      expect(r.stderr).not.toContain("--home 参数非法");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
