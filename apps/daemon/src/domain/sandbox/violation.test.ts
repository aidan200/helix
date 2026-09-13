import { describe, expect, test } from "bun:test";

import { classifyBashOutput } from "./violation";

describe("classifyBashOutput", () => {
  test("沙箱拒绝关键词 → violation（Operation not permitted）", () => {
    const v = classifyBashOutput(1, "sh: /etc/hosts: Operation not permitted");
    expect(v.isViolation).toBe(true);
    if (v.isViolation) {
      expect(v.reason).toBe("operation_not_permitted");
      expect(v.message).toContain("helix 沙箱");
      expect(v.message).toContain("write/edit");
    }
  });

  test("permission denied / read-only file system / sandbox_apply 均识别", () => {
    expect(classifyBashOutput(1, "mkdir: x: Permission denied").isViolation).toBe(true);
    expect(classifyBashOutput(1, "touch: y: Read-only file system").isViolation).toBe(true);
    expect(classifyBashOutput(1, "sandbox-exec: sandbox_apply: Operation not permitted").isViolation).toBe(true);
  });

  test("快拒退出码（2/126/127）不是沙箱拒绝——shell 语义错误优先", () => {
    // 126 = 命令不可执行（permission denied 文案但非沙箱拒绝面）
    expect(classifyBashOutput(126, "bash: ./x.sh: Permission denied").isViolation).toBe(false);
    expect(classifyBashOutput(127, "bash: foo: command not found").isViolation).toBe(false);
  });

  test("普通失败（编译错误/测试红）不误报", () => {
    expect(classifyBashOutput(1, "error TS2345: Argument of type...").isViolation).toBe(false);
    expect(classifyBashOutput(0, "").isViolation).toBe(false);
  });
});
