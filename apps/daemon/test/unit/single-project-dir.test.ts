/**
 * 会话写足迹单项目归约单点单测（评审 F1：split("/").pop() 硬编码 POSIX
 * 分隔符——win32 绝对路径整串被当目录名（TR-95 windows-x64 兼容面），且尾
 * 斜杠路径 pop() 得空串不回落 undefined，memory_search scope/progress
 * scope 项目名错误）。
 */
import { describe, expect, test } from "bun:test";
import { singleProjectDirOf } from "../../src/infrastructure/assembly/singleProjectDir";

describe("singleProjectDirOf（单项目归约单点）", () => {
  test("POSIX 绝对路径 → workspace 一级目录名", () => {
    expect(singleProjectDirOf(["/w/helix"])).toBe("helix");
  });

  test("尾斜杠路径 → 目录名（不再得空串）", () => {
    expect(singleProjectDirOf(["/w/helix/"])).toBe("helix");
  });

  test("win32 盘符路径 → 目录名（不再整串透传，TR-95 兼容面）", () => {
    expect(singleProjectDirOf(["C:\\proj\\helix"])).toBe("helix");
  });

  test("零足迹/多足迹 → undefined（消费方回落 global）", () => {
    expect(singleProjectDirOf([])).toBeUndefined();
    expect(singleProjectDirOf(["/w/a", "/w/b"])).toBeUndefined();
  });
});
