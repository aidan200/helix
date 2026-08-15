/**
 * shared/lib 展示格式化测试：extractExitCode 双文案兼容（回退修复 TS3-b）。
 *
 * 契约来源：pi bash 真实错误文案「Command exited with code N」（E 层实证）
 * 与 mock/通用「... exit N」（F 层 mock「process exited with exit 1」）；
 * 两种都不命中时回退 "1"（非零失败的无结构化启发式）。
 */
import { describe, expect, it } from "vitest";
import { extractExitCode } from "./format";

describe("extractExitCode", () => {
  it("pi bash 真实错误文案：Command exited with code N → 提取 N", () => {
    expect(extractExitCode("Command exited with code 7")).toBe("7");
  });

  it("mock/通用文案：process exited with exit 1 → 提取 1", () => {
    expect(extractExitCode("process exited with exit 1")).toBe("1");
  });

  it("无码错误文案（bash: some error）→ 回退 1", () => {
    expect(extractExitCode("bash: some error")).toBe("1");
  });

  it("多行文本含真实文案（pre 全文场景）→ 命中行内数字", () => {
    const result = ["stdout 前 3 行…", "", "Command exited with code 7"].join("\n");
    expect(extractExitCode(result)).toBe("7");
  });
});
