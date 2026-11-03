import { describe, expect, test } from "bun:test";
import { CoreToolExecutor, UNSANDBOXED_EXEC_TIMEOUT_SECONDS } from "../../src/adapters/driven/tools/CoreToolExecutor";

/**
 * P0 裸跑超时批（2026-11-03 事故回归锚）：unsandboxedExec 必带 timeout——
 * 此前无限挂（autoApprove 短路后裸跑 cargo 冷编译 20 分钟实证，abort 无感
 * 永挂）。超时路径（killProcessTree + timeout 错误码）由 pi vendor exec 面
 * 自测覆盖；本面锚定：① 常量值不回退（无限挂复活防线）② 正常路径不破坏
 * （快命令照常返回合并输出）。
 */

describe("unsandboxedExec 裸跑面超时（P0 裸跑超时批）", () => {
  test("常量锚定：600s 上限在位（防误改回无限挂）", () => {
    expect(UNSANDBOXED_EXEC_TIMEOUT_SECONDS).toBe(600);
  });

  test("正常路径回归：快命令照常返回合并输出 + exitCode", async () => {
    const executor = new CoreToolExecutor({ cwd: process.cwd() });
    const res = await executor.unsandboxedExec("echo unsandboxed-ok");
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("unsandboxed-ok");
  });
});
