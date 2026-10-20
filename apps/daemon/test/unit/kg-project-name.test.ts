/**
 * projectNameOf 单源单测（评审 low #15/#25）。
 *
 * 缺陷面：四处同名 helper 行为分叉——resident-rules / ClosureRecorder 版不
 * 归一分隔符也不滤空段（尾斜杠输入回退整串路径、win32 反斜杠取不到尾段）；
 * task-slice 版归一分隔符但不滤空段；job-activity 版滤空段但不归一分隔符。
 * 收敛到 domain/kg/project-name.ts 后，尾斜杠/反斜杠两形态都必须取到目录名。
 */
import { describe, expect, test } from "bun:test";
import { projectNameOf } from "../../src/domain/kg/project-name";

describe("projectNameOf（单源）：尾段即项目名", () => {
  test("常规 POSIX 路径取尾段", () => {
    expect(projectNameOf("/Users/x/workspace/helix")).toBe("helix");
    expect(projectNameOf("helix")).toBe("helix");
  });

  test("尾斜杠输入不回退整串（原 resident-rules/ClosureRecorder 版分叉面）", () => {
    expect(projectNameOf("/Users/x/workspace/helix/")).toBe("helix");
  });

  test("win32 反斜杠路径取尾段（原三版均不分叉为整串）", () => {
    expect(projectNameOf("C:\\workspace\\helix")).toBe("helix");
    expect(projectNameOf("C:\\workspace\\helix\\")).toBe("helix");
  });

  test("取不到尾段才回退整串", () => {
    expect(projectNameOf("/")).toBe("/");
    expect(projectNameOf("")).toBe("");
  });
});
