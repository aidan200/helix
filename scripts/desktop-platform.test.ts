/**
 * desktop-platform 注册表单测（TR-95：{darwin-arm64, win32-x64} 双档单点）。
 *
 * - platformSpec 双档全字段对照（bun target / triple / externalBin 命名 /
 *   资产命名分档 / launcher 与 vendored node 相对位）；
 * - parsePlatform 合法/非法值；hostPlatform 宿主推断；
 * - resolvePlatformArg 优先级：--platform argv > HELIX_DESKTOP_PLATFORM env
 *   > 宿主推断（mac 缺省 = darwin-arm64 零回归）。
 */
import { describe, expect, test } from "bun:test";
import {
  DESKTOP_PLATFORMS,
  hostPlatform,
  parsePlatform,
  platformSpec,
  resolvePlatformArg,
} from "./desktop-platform";

describe("platformSpec（双档全字段对照，TR-95）", () => {
  test("darwin-arm64 档：bun-darwin-arm64 / aarch64-apple-darwin / 无 .exe", () => {
    const s = platformSpec("darwin-arm64");
    expect(s.bunTarget).toBe("bun-darwin-arm64");
    expect(s.triple).toBe("aarch64-apple-darwin");
    expect(s.daemonBinaryName).toBe("helix-daemon-aarch64-apple-darwin");
    expect(s.rgTriple).toBe("aarch64-apple-darwin");
    expect(s.rgArchiveFormat).toBe("tar.gz");
    expect(s.rgBinaryName).toBe("rg");
    expect(s.codegraphAssetName).toBe("codegraph-darwin-arm64.tar.gz");
    expect(s.codegraphArchiveFormat).toBe("tar.gz");
    expect(s.codegraphNodeRel).toBe("node");
    expect(s.codegraphLauncherRel).toBe("bin/codegraph");
    expect(s.isWindows).toBe(false);
  });

  test("windows-x64 档：bun-windows-x64 / x86_64-pc-windows-msvc / .exe + .cmd", () => {
    const s = platformSpec("windows-x64");
    expect(s.bunTarget).toBe("bun-windows-x64");
    expect(s.triple).toBe("x86_64-pc-windows-msvc");
    // Tauri externalBin 约定：Windows 产物名必须带 .exe
    expect(s.daemonBinaryName).toBe("helix-daemon-x86_64-pc-windows-msvc.exe");
    expect(s.rgTriple).toBe("x86_64-pc-windows-msvc");
    expect(s.rgArchiveFormat).toBe("zip");
    expect(s.rgBinaryName).toBe("rg.exe");
    expect(s.codegraphAssetName).toBe("codegraph-win32-x64.zip");
    expect(s.codegraphArchiveFormat).toBe("zip");
    expect(s.codegraphNodeRel).toBe("node.exe");
    expect(s.codegraphLauncherRel).toBe("bin/codegraph.cmd");
    expect(s.isWindows).toBe(true);
  });

  test("平台集恰为 TR-95 裁决两档", () => {
    expect(DESKTOP_PLATFORMS).toEqual(["darwin-arm64", "windows-x64"]);
  });
});

describe("parsePlatform", () => {
  test("合法值直通", () => {
    expect(parsePlatform("darwin-arm64")).toBe("darwin-arm64");
    expect(parsePlatform("windows-x64")).toBe("windows-x64");
  });

  test("非法值抛错（消息枚举合法值）", () => {
    expect(() => parsePlatform("linux-x64")).toThrow(/darwin-arm64.*windows-x64/);
    expect(() => parsePlatform("")).toThrow(/非法平台档/);
  });
});

describe("hostPlatform（宿主推断缺省）", () => {
  test("win32 → windows-x64；darwin/linux → darwin-arm64（mac 零回归）", () => {
    expect(hostPlatform("win32")).toBe("windows-x64");
    expect(hostPlatform("darwin")).toBe("darwin-arm64");
    expect(hostPlatform("linux")).toBe("darwin-arm64");
  });
});

describe("resolvePlatformArg（优先级：argv > env > 宿主）", () => {
  test("--platform argv 最优先", () => {
    expect(resolvePlatformArg(["bun", "x.ts", "--platform", "windows-x64"], {}, "darwin")).toBe(
      "windows-x64",
    );
  });

  test("--platform 缺值/值以 - 开头 → 抛错", () => {
    expect(() => resolvePlatformArg(["--platform"], {}, "darwin")).toThrow(/--platform/);
    expect(() => resolvePlatformArg(["--platform", "--from"], {}, "darwin")).toThrow(/--platform/);
  });

  test("env HELIX_DESKTOP_PLATFORM 次优（trim；空串视为未设）", () => {
    expect(resolvePlatformArg([], { HELIX_DESKTOP_PLATFORM: " windows-x64 " }, "darwin")).toBe(
      "windows-x64",
    );
    expect(resolvePlatformArg([], { HELIX_DESKTOP_PLATFORM: "  " }, "darwin")).toBe("darwin-arm64");
  });

  test("env 非法值抛错（fail-fast 不静默回退）", () => {
    expect(() => resolvePlatformArg([], { HELIX_DESKTOP_PLATFORM: "linux-x64" }, "darwin")).toThrow(
      /非法平台档/,
    );
  });

  test("双缺 → 宿主推断（win32 宿主 → windows-x64；mac 宿主 → darwin-arm64）", () => {
    expect(resolvePlatformArg([], {}, "win32")).toBe("windows-x64");
    expect(resolvePlatformArg([], {}, "darwin")).toBe("darwin-arm64");
  });

  test("argv 覆盖 env", () => {
    expect(
      resolvePlatformArg(["--platform", "darwin-arm64"], { HELIX_DESKTOP_PLATFORM: "windows-x64" }, "win32"),
    ).toBe("darwin-arm64");
  });
});
