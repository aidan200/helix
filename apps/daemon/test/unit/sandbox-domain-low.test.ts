/**
 * 沙箱域低危批单测（评审 low #71/#72/#73/#74）。
 *
 * - #71 parseSandboxConfig extraRoots 绝对路径闸：相对 root 此前只在 adapter
 *   侧过滤，域面漏放（拼进 sbpl subpath 段以沙箱进程 cwd 为基准解析，可写面漂移）。
 * - #72 路径折叠单源：domain/path-fold 收口三份实现（SandboxPolicy /
 *   bashExtract / ruleFallback），「..」语义唯一。
 * - #73 resolveEnforcer 平台参数不再引用 NodeJS.Platform（TR-13 domain
 *   framework-free）。
 * - #74 拒绝文案不再把可写面说成「只 workspace 与 ~/.helix」。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { foldPathSegments, resolveWithinPath } from "../../src/domain/path-fold";
import { parseSandboxConfig } from "../../src/domain/sandbox/SandboxPolicy";
import { resolveEnforcer } from "../../src/domain/sandbox/ruleFallback";
import { violationMessage } from "../../src/domain/sandbox/violation";

const WS = "/ws";
const HOME = "/home/u/.helix";

describe("parseSandboxConfig extraRoots 绝对路径闸（评审 low #71）", () => {
  test("相对/空白/UNC 与盘符形态：只放绝对路径（POSIX // win32 盘符 / UNC）", () => {
    const policy = parseSandboxConfig(
      { enabled: true, extraRoots: ["rel/dir", "./also-rel", "/abs/posix", "C:\\tmp\\win", "\\\\server\\share", "  "] },
      WS,
      HOME,
    );
    expect(policy.writableRoots).toContain("/abs/posix");
    expect(policy.writableRoots).toContain("C:\\tmp\\win");
    expect(policy.writableRoots).toContain("\\\\server\\share");
    expect(policy.writableRoots).not.toContain("rel/dir");
    expect(policy.writableRoots).not.toContain("./also-rel");
  });
});

describe("路径折叠单源（评审 low #72）", () => {
  test("绝对路径不下穿根；相对路径保留前导 ..；. 段归一", () => {
    expect(foldPathSegments("/a/b/../c")).toBe("/a/c");
    expect(foldPathSegments("/../x")).toBe("/x");
    expect(foldPathSegments("../../x")).toBe("../../x");
    expect(foldPathSegments("./a//b/")).toBe("a/b");
    expect(foldPathSegments("")).toBe(".");
  });

  test("resolveWithinPath：rel 绝对覆盖 base，相对拼 base 后折叠", () => {
    expect(resolveWithinPath("/ws/proj", "src/a.ts")).toBe("/ws/proj/src/a.ts");
    expect(resolveWithinPath("/ws/proj", "../b.ts")).toBe("/ws/b.ts");
    expect(resolveWithinPath("/ws/proj", "/abs/c.ts")).toBe("/abs/c.ts");
  });
});

describe("resolveEnforcer 平台参数（评审 low #73：不引用 NodeJS.Platform）", () => {
  test("三平台分支判定不变", () => {
    expect(resolveEnforcer("darwin", true, false)).toBe("seatbelt");
    expect(resolveEnforcer("darwin", false, false)).toBe("fallback");
    expect(resolveEnforcer("win32", false, true)).toBe("helper");
    expect(resolveEnforcer("linux", true, true)).toBe("fallback");
  });
});

describe("沙箱拒绝文案口径（评审 low #74）", () => {
  test("文案覆盖 extraRoots/TMPDIR 且不把拒绝因由说成只有写入", () => {
    const text = violationMessage("denied");
    expect(text).toContain("额外可写根");
    expect(text).toContain("系统临时目录");
    expect(text).not.toContain("写入目标不在可写根（workspace 与 ~/.helix）");
  });

  test("domain 层源码不再出现 NodeJS.* 命名空间引用", () => {
    const dir = join(import.meta.dir, "../../src/domain/sandbox");
    for (const file of ["ruleFallback.ts", "SandboxPolicy.ts", "violation.ts"]) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      const src = readFileSync(path, "utf8");
      expect(src.includes("NodeJS.")).toBe(false);
    }
  });
});
