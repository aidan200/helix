/**
 * desktop-platform —— 桌面端目标平台注册表（TR-95 裁决落地单点）。
 *
 * P0 裁决（kg TR-95）：目标平台集 = { darwin-arm64, win32-x64 }——mac 只出
 * arm64（不 universal/x64），Windows 只出 x64（不 arm64）；首发不签名。
 * 本模块是管线脚本（compile-daemon / fetch-rg / fetch-codegraph /
 * build-desktop / smoke 验证）共享的平台参数化单点：平台档 → bun target /
 * externalBin triple 命名 / 资产命名分档 / 守护断言形态，全部集中此处，
 * 禁散落于各脚本 if-else。
 *
 * 平台入参解析（三脚本同口径）：`--platform <档>` argv 优先 → env
 * HELIX_DESKTOP_PLATFORM → 宿主推断（win32 → windows-x64，其余 →
 * darwin-arm64——mac 缺省行为与硬编码时代逐字节一致，零回归）。
 *
 * 纯函数面，零 IO，全分支可单测。工程层脚本，不被 apps 任何层 import
 * （架构 §5.2）。
 */

/** 目标平台档（TR-95 集合；CLI/env 入参值同形）。 */
export type DesktopPlatform = "darwin-arm64" | "windows-x64";

export const DESKTOP_PLATFORMS: readonly DesktopPlatform[] = ["darwin-arm64", "windows-x64"];

/** 平台档规格：双档全字段对照表（平台差异的唯一权威面）。 */
export interface PlatformSpec {
  readonly platform: DesktopPlatform;
  /** bun build --compile --target 值。 */
  readonly bunTarget: string;
  /** Rust/Tauri target triple（externalBin 命名 + tauri build --target 共用）。 */
  readonly triple: string;
  /** compile 产物文件名（Tauri externalBin target-triple 约定；windows 带 .exe）。 */
  readonly daemonBinaryName: string;
  /** ripgrep release 资产 triple 段。 */
  readonly rgTriple: string;
  /** ripgrep 资产包格式（解压分派用）。 */
  readonly rgArchiveFormat: "tar.gz" | "zip";
  /** rg 落位文件名（windows 档 rg.exe）。 */
  readonly rgBinaryName: string;
  /** codegraph release 资产名。 */
  readonly codegraphAssetName: string;
  /** codegraph 资产包格式（解压分派用）。 */
  readonly codegraphArchiveFormat: "tar.gz" | "zip";
  /** codegraph bundle 内 vendored node 相对路径（守护断言锚①）。 */
  readonly codegraphNodeRel: string;
  /** codegraph bundle 内 launcher 相对路径（守护断言锚②；windows 为 .cmd）。 */
  readonly codegraphLauncherRel: string;
  /** windows 档判定（守护断言/命名分岔语义化别名）。 */
  readonly isWindows: boolean;
}

const SPECS: Record<DesktopPlatform, PlatformSpec> = {
  "darwin-arm64": {
    platform: "darwin-arm64",
    bunTarget: "bun-darwin-arm64",
    triple: "aarch64-apple-darwin",
    daemonBinaryName: "helix-daemon-aarch64-apple-darwin",
    rgTriple: "aarch64-apple-darwin",
    rgArchiveFormat: "tar.gz",
    rgBinaryName: "rg",
    codegraphAssetName: "codegraph-darwin-arm64.tar.gz",
    codegraphArchiveFormat: "tar.gz",
    codegraphNodeRel: "node",
    codegraphLauncherRel: "bin/codegraph",
    isWindows: false,
  },
  "windows-x64": {
    platform: "windows-x64",
    bunTarget: "bun-windows-x64",
    triple: "x86_64-pc-windows-msvc",
    // Tauri externalBin 约定：Windows 产物名必须带 .exe 后缀。
    daemonBinaryName: "helix-daemon-x86_64-pc-windows-msvc.exe",
    rgTriple: "x86_64-pc-windows-msvc",
    rgArchiveFormat: "zip",
    rgBinaryName: "rg.exe",
    codegraphAssetName: "codegraph-win32-x64.zip",
    codegraphArchiveFormat: "zip",
    codegraphNodeRel: "node.exe",
    codegraphLauncherRel: "bin/codegraph.cmd",
    isWindows: true,
  },
};

/** 平台档 → 规格（全字段对照单点）。 */
export function platformSpec(platform: DesktopPlatform): PlatformSpec {
  return SPECS[platform];
}

/** 字符串 → 平台档（非法值抛错，枚举合法值于消息中）。 */
export function parsePlatform(value: string): DesktopPlatform {
  if (value === "darwin-arm64" || value === "windows-x64") return value;
  throw new Error(
    `非法平台档：${JSON.stringify(value)}（合法值：${DESKTOP_PLATFORMS.join(" / ")}，TR-95）`,
  );
}

/** 宿主推断缺省档：win32 → windows-x64，其余 → darwin-arm64（mac 零回归）。 */
export function hostPlatform(nodePlatform: string = process.platform): DesktopPlatform {
  return nodePlatform === "win32" ? "windows-x64" : "darwin-arm64";
}

/**
 * 平台入参解析（管线脚本统一口径）：argv `--platform <档>` 优先 → env
 * HELIX_DESKTOP_PLATFORM → 宿主推断。argv/env 注入，纯函数可单测。
 */
export function resolvePlatformArg(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  nodePlatform: string = process.platform,
): DesktopPlatform {
  const idx = argv.indexOf("--platform");
  if (idx !== -1) {
    const value = argv[idx + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new Error(`--platform 需要平台档参数（合法值：${DESKTOP_PLATFORMS.join(" / ")}）`);
    }
    return parsePlatform(value);
  }
  const fromEnv = env.HELIX_DESKTOP_PLATFORM;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return parsePlatform(fromEnv.trim());
  return hostPlatform(nodePlatform);
}
