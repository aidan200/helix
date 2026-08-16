/**
 * shared/lib 展示格式化测试：extractExitCode 双文案兼容（回退修复 TS3-b）
 * + fmtTokens 档位格式化（F3.3 统计徽标；test-design §1.1 unit-⑧）。
 *
 * 契约来源：pi bash 真实错误文案「Command exited with code N」（E 层实证）
 * 与 mock/通用「... exit N」（F 层 mock「process exited with exit 1」）；
 * 两种都不命中时回退 "1"（非零失败的无结构化启发式）。
 */
import { describe, expect, it } from "vitest";
import { extractExitCode, fmtTokens } from "./format";

describe("fmtTokens 档位格式化（F3.3 徽标；T4.2 消费）", () => {
  it("≥1M：一位小数 M（1_200_000 → 1.2M；1_000_000 边界 → 1.0M）", () => {
    expect(fmtTokens(1_200_000)).toBe("1.2M");
    expect(fmtTokens(1_000_000)).toBe("1.0M");
    expect(fmtTokens(1_216_000)).toBe("1.2M");
  });

  it("1k..1M：k 档四舍五入（32_000 → 32k；460_000 → 460k；1_500 → 2k）", () => {
    expect(fmtTokens(32_000)).toBe("32k");
    expect(fmtTokens(460_000)).toBe("460k");
    expect(fmtTokens(1_500)).toBe("2k");
    expect(fmtTokens(1_000)).toBe("1k");
  });

  it("<1k：原值（999 → 999；0 → 0）", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(0)).toBe("0");
  });
});

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
