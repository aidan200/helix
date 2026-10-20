/**
 * binary-assert 测试（评审 F5 #6：arm64 断言失败文案的权威引用）。
 *
 * 条目面是「错误文案引哪条权威」：旧文案引 AD-6（arm64-only）为权威，而
 * TR-95 已明记「取代 AD-6 arm64-only 的适用范围」（darwin-arm64 + win32-x64
 * 双档）。文案随行为分支产出，故把文案构造抽成纯函数 arm64AssertionFailure
 * 单点并在此断言——真分支驱动需要本机存在含 x86_64 切片的 Mach-O，且
 * Bun.spawn 的 PATH 在进程启动期缓存（测试内改 process.env.PATH 注入假 lipo
 * 不生效），故不对 lipo 子进程做端到端桩替。
 */
import { describe, expect, test } from "bun:test";
import { arm64AssertionFailure } from "./binary-assert";

describe("arm64AssertionFailure（arm64 反断言失败文案）", () => {
  test("文案引 TR-95（现行双档裁决）", () => {
    const err = arm64AssertionFailure("/tmp/fake-binary", "Architectures in the fat file: x are: x86_64 arm64\n");
    expect(err.message).toContain("TR-95");
  });

  test("不得回潮 AD-6（arm64-only 适用范围已被 TR-95 取代）", () => {
    const err = arm64AssertionFailure("/tmp/fake-binary", "x86_64 arm64");
    expect(err.message).not.toContain("AD-6");
  });

  test("携带路径与 lipo 实输出（排障面不退化）", () => {
    const err = arm64AssertionFailure("/tmp/fake-binary", "  architectures: x86_64  \n");
    expect(err.message).toContain("/tmp/fake-binary");
    expect(err.message).toContain("architectures: x86_64");
  });
});
