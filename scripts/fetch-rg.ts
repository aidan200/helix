#!/usr/bin/env bun
/**
 * fetch-rg —— CL-2/F2.3 管线段：ripgrep 二进制获取（平台化，TR-95 双档：
 * darwin-arm64 / windows-x64）。
 *
 * 落位（AD-6/TR-AD-32 延伸 TR-95）：apps/shell/src-tauri/resources/bin/rg
 * （darwin 档）/ resources/bin/rg.exe（windows 档），经 tauri.conf
 * bundle.resources 进包（T3.1 接线）；壳 spawn sidecar 时经 env
 * HELIX_RG_PATH 注入，daemon resolve-rg ①bundle 级消费（T1.1）。
 *
 * 两种获取形态（安装骨架单点 install-skeleton.ts，差异经 spec 注入——
 * 本文件承载 rg 特有面：资产 pin/落位形态；平台断言单点 binary-assert.ts）：
 * - 默认：GitHub releases 固定版本下载（pin 版本号 + 分平台 sha256 校验，
 *   校验失败即报错，下载暂存目录 finally 清理）→ 解压（tar.gz / zip 统一走 bsdtar `tar -xf`，
 *   mac 与 Windows 10+ 系统 tar 均支持 zip）→ chmod +x（仅 darwin 档）；
 * - `--from <path>`：本地 rg 直接拷贝（离线/加速场景），同样过平台断言。
 *
 * 双重守护按平台分档（反向断言，单点 binary-assert.ts 经 re-export 消费）：
 * - darwin-arm64：落位后 `lipo -info` 断言 arm64 单架构——拒绝 x86_64
 *   切片 / universal / 非 Mach-O；
 * - windows-x64：PE 头断言 x64（assertPeX64：MZ 魔数 → PE\0\0 → Machine
 *   0x8664）——拒绝非 PE / x86(0x014C) / arm64(0xAA64)。
 * 幂等：已存在且平台断言通过则跳过。
 *
 * 二进制不入 git（resources/bin/ 已入 .gitignore），可复现性由 pin 版本 +
 * sha256 保证。工程层脚本，不被 apps 任何层 import（架构 §5.2）。
 *
 * 用法：
 *   bun scripts/fetch-rg.ts [--platform darwin-arm64|windows-x64]  # 固定版本下载
 *   bun scripts/fetch-rg.ts --from <path> [--platform <档>]        # 本地拷贝
 */
import { chmodSync, copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { platformSpec, type DesktopPlatform } from "./desktop-platform";
import { assertBinaryForPlatform } from "./binary-assert";
import {
  makeInstallers,
  runInstallMain,
  type InstallerSet,
  type InstallSkeletonSpec,
} from "./install-skeleton";

// 下载面/校验工具单点在 install-skeleton.ts（W4 归一），架构断言单点在
// binary-assert.ts——此处两道 re-export 保既有消费面（fetch-rg.test.ts；
// fetch-codegraph 下载面已直引 install-skeleton，断言面仍经本文件）。
export { downloadToFile, sha256OfFile, type DownloadOptions } from "./install-skeleton";
export type { InstallResult } from "./install-skeleton";
export { assertArm64Only, assertPeX64, assertBinaryForPlatform } from "./binary-assert";

const root = join(import.meta.dir, "..");

/** pin 版本（可复现性锚点；升级 = 改常量 + 更新双档 sha256）。
 * 15.1.0 双档资产齐全（2026-09 实查 release：aarch64-apple-darwin.tar.gz +
 * x86_64-pc-windows-msvc.zip 均在，sha256 与官方 .sha256 旁车一致）。 */
export const RG_VERSION = "15.1.0";

/** 分平台资产描述（pin 版本 + sha256 + 包格式）。 */
export interface RgAsset {
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly format: "tar.gz" | "zip";
}

const RG_SHA256: Record<DesktopPlatform, string> = {
  "darwin-arm64": "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
  "windows-x64": "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
};

/** 平台档 → release 资产（sha256 与官方旁车 .sha256 文件一致）。 */
export function rgAsset(platform: DesktopPlatform): RgAsset {
  const spec = platformSpec(platform);
  const name = `ripgrep-${RG_VERSION}-${spec.rgTriple}.${spec.rgArchiveFormat}`;
  return {
    name,
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${name}`,
    sha256: RG_SHA256[platform],
    format: spec.rgArchiveFormat,
  };
}

/** mac 档资产常量（darwin-arm64 缺省档兼容面；RG_TARBALL_SHA256 仅测试引用，RG_URL 现无消费方）。 */
export const RG_ASSET_NAME = rgAsset("darwin-arm64").name;
export const RG_URL = rgAsset("darwin-arm64").url;
export const RG_TARBALL_SHA256 = rgAsset("darwin-arm64").sha256;

/** 平台档 → 落位（T3.1 tauri.conf bundle.resources 消费位）。 */
export function rgDest(platform: DesktopPlatform): string {
  return join(root, "apps/shell/src-tauri/resources/bin", platformSpec(platform).rgBinaryName);
}

/** mac 档落位常量（darwin-arm64 缺省档兼容面；dev-desktop 消费）。 */
export const RG_DEST = rgDest("darwin-arm64");

/** 幂等判据：已存在且平台断言通过。 */
export async function isInstalled(
  dest: string = RG_DEST,
  platform: DesktopPlatform = "darwin-arm64",
): Promise<boolean> {
  if (!existsSync(dest)) return false;
  try {
    await assertBinaryForPlatform(dest, platform);
    return true;
  } catch {
    return false;
  }
}

/**
 * rg 安装骨架差异面（install-skeleton.ts 五段骨架的消费声明）：
 * 单文件落位（rename 原子替换）、lipo/PE 平台断言、pin 资产解析、
 * 解压后固定包内路径定位。
 */
const rgSpec: InstallSkeletonSpec = {
  label: "fetch-rg",
  tmpPrefix: "helix-rg-",
  destIsTree: false,
  assetFor: rgAsset,
  destFor: rgDest,
  isInstalledAt: isInstalled,
  assertSource: (src) => {
    if (!existsSync(src)) {
      throw new Error(`--from 源不存在：${src}`);
    }
  },
  place: async (src, tmp, platform) => {
    try {
      // copy 同入守护 try：copyFileSync 自身抛错（盘满/权限）时半成品 tmp 一并清理
      copyFileSync(src, tmp);
      if (!platformSpec(platform).isWindows) chmodSync(tmp, 0o755);
      await assertBinaryForPlatform(tmp, platform);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  },
  locateInArchive: (extractDir, platform) => {
    const spec = platformSpec(platform);
    const extracted = join(
      extractDir,
      `ripgrep-${RG_VERSION}-${spec.rgTriple}`,
      spec.rgBinaryName,
    );
    if (!existsSync(extracted)) {
      throw new Error(`包内未找到预期 ${spec.rgBinaryName}：${extracted}`);
    }
    return extracted;
  },
  fromArgHint: "本地 rg 路径",
};

const installers = makeInstallers(rgSpec);

/**
 * `--from <path>` 形态：本地拷贝 → chmod +x（仅 darwin 档）→ 平台断言。
 * 断言失败删档报错（不落位半成品）。
 */
export const installFromLocal: InstallerSet["installFromLocal"] = installers.installFromLocal;
/**
 * 校验 + 解压安装（tar.gz / zip 双格式）：sha256 不符即抛错（坏档归调用方
 * 处置，骨架不擅删）；通过则解出 rg 走 installFromLocal 同一落位面
 * （chmod + 平台断言 + 幂等）。
 */
export const installFromArchive: InstallerSet["installFromArchive"] = installers.installFromArchive;
/** 默认形态：固定版本下载 → sha256 校验 → 解压落位（downloadToFile 带超时/停滞/重试）。 */
export const installFromRelease: InstallerSet["installFromRelease"] = installers.installFromRelease;

// import.meta.main 守卫：常量/函数被测试 import，导入不得触发下载副作用。
if (import.meta.main) {
  try {
    const { dest, platform } = await runInstallMain(rgSpec, installers);
    const mb = (statSync(dest).size / 1024 / 1024).toFixed(1);
    console.log(`✓ fetch-rg: ${dest}（${mb}MB, ripgrep ${RG_VERSION}, ${platform}）`);
  } catch (e) {
    console.error(`✗ fetch-rg: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
