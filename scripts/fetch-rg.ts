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
 * 两种获取形态：
 * - 默认：GitHub releases 固定版本下载（pin 版本号 + 分平台 sha256 校验，
 *   校验失败即删档报错）→ 解压（tar.gz / zip 统一走 bsdtar `tar -xf`，
 *   mac 与 Windows 10+ 系统 tar 均支持 zip）→ chmod +x（仅 darwin 档）；
 * - `--from <path>`：本地 rg 直接拷贝（离线/加速场景），同样过平台断言。
 *
 * 双重守护按平台分档（反向断言）：
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
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { platformSpec, resolvePlatformArg, type DesktopPlatform } from "./desktop-platform";

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

/** mac 档资产常量（darwin-arm64 缺省档兼容面；既有测试/dev-desktop 消费）。 */
export const RG_ASSET_NAME = rgAsset("darwin-arm64").name;
export const RG_URL = rgAsset("darwin-arm64").url;
export const RG_TARBALL_SHA256 = rgAsset("darwin-arm64").sha256;

/** 平台档 → 落位（T3.1 tauri.conf bundle.resources 消费位）。 */
export function rgDest(platform: DesktopPlatform): string {
  return join(root, "apps/shell/src-tauri/resources/bin", platformSpec(platform).rgBinaryName);
}

/** mac 档落位常量（darwin-arm64 缺省档兼容面；dev-desktop 消费）。 */
export const RG_DEST = rgDest("darwin-arm64");

export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * lipo -info 断言 arm64 单架构（darwin 档反向断言）。
 * 非 Mach-O（lipo 非零退出）/ 含 x86_64 切片 / 缺 arm64 → 抛错。
 */
export async function assertArm64Only(path: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["lipo", "-info", path],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`lipo -info 失败（非 Mach-O 二进制？）：${path}：${err.trim() || out.trim()}`);
  }
  const info = out.trim().toLowerCase();
  if (!info.includes("arm64") || info.includes("x86_64")) {
    throw new Error(`arm64 单架构断言失败（AD-6）：${path} → ${out.trim()}`);
  }
}

/**
 * PE x64 断言（windows-x64 档反向断言，lipo 的 Windows 等价物）：
 * MZ 魔数 → e_lfanew(0x3C) → "PE\0\0" 签名 → Machine 字段必须 0x8664（x64）。
 * 非 PE / 截断头 / 非 x64（x86=0x014C、arm64=0xAA64）→ 抛错。同步只读头 6 字节级。
 */
export function assertPeX64(path: string): void {
  const fd = openSync(path, "r");
  try {
    const dos = Buffer.alloc(0x40);
    if (readSync(fd, dos, 0, 0x40, 0) < 0x40 || dos.toString("latin1", 0, 2) !== "MZ") {
      throw new Error(`PE 断言失败（非 PE 二进制，缺 MZ 魔数）：${path}`);
    }
    const peOffset = dos.readUInt32LE(0x3c);
    const pe = Buffer.alloc(6);
    if (
      readSync(fd, pe, 0, 6, peOffset) < 6 ||
      pe.toString("latin1", 0, 4) !== "PE\0\0"
    ) {
      throw new Error(`PE 断言失败（缺 PE\\0\\0 签名）：${path}`);
    }
    const machine = pe.readUInt16LE(4);
    if (machine !== 0x8664) {
      throw new Error(
        `PE x64 断言失败（TR-95 win32-x64 only）：${path} → Machine=0x${machine.toString(16)}（期望 0x8664）`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

/** 平台分档二进制断言单点（lipo 仅 mac；windows 走 PE x64）。 */
export async function assertBinaryForPlatform(
  path: string,
  platform: DesktopPlatform,
): Promise<void> {
  if (platformSpec(platform).isWindows) {
    assertPeX64(path);
  } else {
    await assertArm64Only(path);
  }
}

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

export interface InstallResult {
  /** true = 幂等跳过（已存在且校验通过）。 */
  skipped: boolean;
  path: string;
}

/**
 * `--from <path>` 形态：本地拷贝 → chmod +x（仅 darwin 档）→ 平台断言。
 * 断言失败删档报错（不落位半成品）。
 */
export async function installFromLocal(
  src: string,
  dest: string = RG_DEST,
  platform: DesktopPlatform = "darwin-arm64",
): Promise<InstallResult> {
  if (!existsSync(src)) {
    throw new Error(`--from 源不存在：${src}`);
  }
  if (await isInstalled(dest, platform)) {
    console.log(`✓ fetch-rg: 已存在且 ${platform} 校验通过，幂等跳过：${dest}`);
    return { skipped: true, path: dest };
  }
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  copyFileSync(src, tmp);
  try {
    if (!platformSpec(platform).isWindows) chmodSync(tmp, 0o755);
    await assertBinaryForPlatform(tmp, platform);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  renameSync(tmp, dest);
  console.log(`✓ fetch-rg: --from 拷贝完成：${src} → ${dest}`);
  return { skipped: false, path: dest };
}

/** 解压单点：tar.gz / zip 统一走 bsdtar `tar -xf`（mac 与 Windows 10+ 系统 tar 均支持 zip 自嗅探）。 */
async function extractArchive(archive: string, destDir: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["tar", "-xf", archive, "-C", destDir],
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`解压失败：${archive}：${err.trim()}`);
  }
}

/**
 * 校验 + 解压安装（tar.gz / zip 双格式）：sha256 不符即删档抛错；通过则
 * 解出 rg 走 installFromLocal 同一落位面（chmod + 平台断言 + 幂等）。
 */
export async function installFromArchive(
  archive: string,
  dest: string = RG_DEST,
  platform: DesktopPlatform = "darwin-arm64",
): Promise<InstallResult> {
  const asset = rgAsset(platform);
  const actual = sha256OfFile(archive);
  if (actual !== asset.sha256) {
    rmSync(archive, { force: true });
    throw new Error(
      `sha256 校验失败（已删除 ${archive}）：期望 ${asset.sha256}，实际 ${actual}`,
    );
  }
  const extractDir = mkdtempSync(join(tmpdir(), "helix-rg-extract-"));
  try {
    await extractArchive(archive, extractDir);
    const extracted = join(
      extractDir,
      `ripgrep-${RG_VERSION}-${platformSpec(platform).rgTriple}`,
      platformSpec(platform).rgBinaryName,
    );
    if (!existsSync(extracted)) {
      throw new Error(`包内未找到预期 ${platformSpec(platform).rgBinaryName}：${extracted}`);
    }
    return await installFromLocal(extracted, dest, platform);
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

/** 默认形态：固定版本下载 → sha256 校验 → 解压落位。 */
export async function installFromRelease(
  dest: string = RG_DEST,
  platform: DesktopPlatform = "darwin-arm64",
): Promise<InstallResult> {
  if (await isInstalled(dest, platform)) {
    console.log(`✓ fetch-rg: 已存在且 ${platform} 校验通过，幂等跳过：${dest}`);
    return { skipped: true, path: dest };
  }
  const asset = rgAsset(platform);
  console.log(`fetch-rg: 下载 ${asset.url}`);
  const res = await fetch(asset.url);
  if (!res.ok) {
    throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}（${asset.url}）`);
  }
  const archive = join(mkdtempSync(join(tmpdir(), "helix-rg-dl-")), asset.name);
  try {
    await Bun.write(archive, res);
    return await installFromArchive(archive, dest, platform);
  } finally {
    rmSync(dirname(archive), { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const platform = resolvePlatformArg(process.argv, process.env);
  const dest = rgDest(platform);
  const fromIdx = process.argv.indexOf("--from");
  if (fromIdx !== -1) {
    const src = process.argv[fromIdx + 1];
    if (!src || src.startsWith("-")) {
      console.error("✗ fetch-rg: --from 需要本地 rg 路径参数");
      process.exit(1);
    }
    await installFromLocal(src, dest, platform);
    return;
  }
  await installFromRelease(dest, platform);
}

// import.meta.main 守卫：常量/函数被测试 import，导入不得触发下载副作用。
if (import.meta.main) {
  try {
    await main();
    const platform = resolvePlatformArg(process.argv, process.env);
    const dest = rgDest(platform);
    const { statSync } = await import("node:fs");
    const mb = (statSync(dest).size / 1024 / 1024).toFixed(1);
    console.log(`✓ fetch-rg: ${dest}（${mb}MB, ripgrep ${RG_VERSION}, ${platform}）`);
  } catch (e) {
    console.error(`✗ fetch-rg: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
