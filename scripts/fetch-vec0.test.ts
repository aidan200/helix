/**
 * fetch-vec0 单测（task-91e2e2f9 B29：跨档守卫生效 + 非法平台档 fail-fast）。
 *
 * RED 面（修复前实证，CLI 级）：
 * - main 未注入 hostPlatform → host 缺省 = platform，跨档守卫成死代码：
 *   mac 上 `--platform windows-x64` 把宿主 .dylib 静默拷成 vec0.dll
 *   （Mach-O arm64 顶替 PE），混入 NSIS 包；
 * - 非法 `--platform linux-x64` 静默回落宿主档继续跑（拼写错误零信号）。
 *
 * 单测面：resolveTargetPlatform（非法值/缺值 fail-fast，desktop-platform
 * .parsePlatform 单点）+ hostDesktopPlatform（严格双档宿主判定）+ fetchVec0
 * 守卫（host ≠ platform 抛错）与幂等拷贝。落位全在临时目录，不触碰真实
 * resources/bin。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fetchVec0, hostDesktopPlatform, resolveTargetPlatform } from "./fetch-vec0";

const tmpDirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "helix-fetch-vec0-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("resolveTargetPlatform（--platform 解析，B29）", () => {
  test("合法档透传：darwin-arm64 / windows-x64", () => {
    expect(resolveTargetPlatform(["--platform", "windows-x64"], "darwin", "arm64")).toBe("windows-x64");
    expect(resolveTargetPlatform(["--platform", "darwin-arm64"], "darwin", "arm64")).toBe("darwin-arm64");
  });

  test("非法档 fail-fast（不再静默回落宿主档）：消息枚举合法值", () => {
    // 旧 parsePlatform 行为：value 不在双档内 → 落到宿主缺省分支继续跑
    expect(() => resolveTargetPlatform(["--platform", "linux-x64"], "darwin", "arm64")).toThrow(/非法平台档.*linux-x64/);
    expect(() => resolveTargetPlatform(["--platform", "darwin-arm64s"], "darwin", "arm64")).toThrow(/TR-95/);
  });

  test("--platform 缺值 fail-fast（非静默回落）", () => {
    expect(() => resolveTargetPlatform(["--platform"], "darwin", "arm64")).toThrow(/--platform 需要平台档参数/);
    expect(() => resolveTargetPlatform(["--platform", "--other"], "darwin", "arm64")).toThrow(/--platform 需要平台档参数/);
  });

  test("缺省 = 严格宿主档：注入面判定（darwin/arm64、win32/x64、其余抛）", () => {
    expect(resolveTargetPlatform([], "darwin", "arm64")).toBe("darwin-arm64");
    expect(resolveTargetPlatform([], "win32", "x64")).toBe("windows-x64");
    expect(() => resolveTargetPlatform([], "linux", "x64")).toThrow(/宿主平台不在 TR-95 双档内/);
  });
});

describe("hostDesktopPlatform（跨档守卫判定源，B29）", () => {
  test("双档宿主直判；档外宿主抛（lenient hostPlatform 会让守卫失效，见函数注释）", () => {
    expect(hostDesktopPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(hostDesktopPlatform("win32", "x64")).toBe("windows-x64");
    expect(() => hostDesktopPlatform("linux", "x64")).toThrow(/宿主平台不在 TR-95 双档内/);
    expect(() => hostDesktopPlatform("darwin", "x64")).toThrow(/宿主平台不在 TR-95 双档内/);
  });
});

describe("fetchVec0（守卫 + 幂等拷贝）", () => {
  function fixtures(): { src: string; resourcesDir: string } {
    const dir = tmp();
    const src = join(dir, "vec0-src.dylib");
    writeFileSync(src, "fake-vec0-payload");
    return { src, resourcesDir: join(dir, "resources") };
  }

  test("跨档拒绝：宿主 darwin-arm64 ≠ 目标 windows-x64（守卫在注入 hostPlatform 时生效）", () => {
    const { src, resourcesDir } = fixtures();
    expect(() =>
      fetchVec0({
        platform: "windows-x64",
        hostPlatform: "darwin-arm64",
        resourcesDir,
        resolvePath: () => src,
      }),
    ).toThrow(/跨档获取不支持.*宿主 darwin-arm64 ≠ 目标 windows-x64/);
  });

  test("源缺失响亮失败（先 bun install 引导）", () => {
    const dir = tmp();
    expect(() =>
      fetchVec0({
        platform: "darwin-arm64",
        hostPlatform: "darwin-arm64",
        resourcesDir: join(dir, "resources"),
        resolvePath: () => join(dir, "not-installed.dylib"),
      }),
    ).toThrow(/vec0 源不存在/);
  });

  test("同档落位 copied → 同体积 skipped（幂等）；档名形态 vec0.dylib/.dll", () => {
    const { src, resourcesDir } = fixtures();
    const deps = {
      platform: "darwin-arm64" as const,
      hostPlatform: "darwin-arm64" as const,
      resourcesDir,
      resolvePath: () => src,
    };
    const first = fetchVec0(deps);
    expect(first.action).toBe("copied");
    expect(first.dest.endsWith("vec0.dylib")).toBe(true);
    expect(readFileSync(first.dest, "utf8")).toBe("fake-vec0-payload");

    const again = fetchVec0(deps);
    expect(again.action).toBe("skipped");

    // 体积变化 → 重新拷（幂等键 = 体积比对）
    writeFileSync(src, "fake-vec0-payload-v2-longer");
    expect(fetchVec0(deps).action).toBe("copied");
  });

  test("windows 档落位文件名 vec0.dll（同档不拦）", () => {
    const dir = tmp();
    const src = join(dir, "vec0-src.dll");
    writeFileSync(src, "fake-vec0-dll");
    const r = fetchVec0({
      platform: "windows-x64",
      hostPlatform: "windows-x64",
      resourcesDir: join(dir, "resources"),
      resolvePath: () => src,
    });
    expect(r.dest.endsWith("vec0.dll")).toBe(true);
  });
});
