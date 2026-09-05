#!/usr/bin/env bun
/**
 * fetch-codegraph —— codegraph bundle-only 定位改造（CL-2 管线段，平台化
 * TR-95 双档：darwin-arm64 / windows-x64）。
 *
 * 与 fetch-rg 的本质差异：codegraph 是 node CLI，官方分发形态为自包含
 * bundle 目录树（vendored Node runtime + lib/dist + bin/codegraph launcher，
 * 见其 BUNDLING.md），不是单文件——落位是整棵目录树。windows 档为 zip：
 * 单一顶层 codegraph-win32-x64/，launcher = bin/codegraph.cmd（经
 * `node.exe lib/dist/bin/codegraph.js` 拉起），vendored node = 根 node.exe
 * （2026-09 实查 v1.6.0 资产解包）。
 *
 * 落位（TR-AD-32 延伸 TR-95）：apps/shell/src-tauri/resources/codegraph/，
 * 经 tauri.conf bundle.resources 整目录进包；壳 spawn sidecar 时经 env
 * HELIX_CODEGRAPH_PATH 注入包内 launcher 路径（Resources/codegraph/bin/
 * codegraph[.cmd]），daemon resolve-codegraph ①bundle 级消费。
 *
 * 两种获取形态：
 * - 默认：GitHub releases 固定版本下载（pin 版本号 + 分平台 sha256 校验，
 *   校验失败即删档报错）→ 解压整树（tar.gz / zip 统一走 bsdtar `tar -xf`）；
 * - `--from <dir>`：本地 bundle 目录直接拷贝（离线/加速场景），同样过守护。
 *
 * 守护面（单文件 rg 的架构断言在目录树形态下的等价物，按平台分档）：
 * - vendored node 存在且架构断言通过（darwin 档 lipo arm64；windows 档
 *   PE x64 —— assertPeX64）；
 * - launcher 存在（darwin 档 bin/codegraph 且带执行位 chmod 保底；
 *   windows 档 bin/codegraph.cmd，执行位语义不适用）；
 * - lib/dist 存在（树完整性最低锚）。
 * 幂等：落位树三项守护全过则跳过。
 *
 * bundle 树不入 git（resources/codegraph 已入 .gitignore），可复现性由
 * pin 版本 + sha256 保证。工程层脚本，不被 apps 任何层 import（架构 §5.2）。
 *
 * 用法：
 *   bun scripts/fetch-codegraph.ts [--platform darwin-arm64|windows-x64]  # 固定版本下载
 *   bun scripts/fetch-codegraph.ts --from <dir> [--platform <档>]         # 本地 bundle 目录拷贝
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { platformSpec, resolvePlatformArg, type DesktopPlatform } from "./desktop-platform";
import { assertBinaryForPlatform, downloadToFile, sha256OfFile } from "./fetch-rg";

const root = join(import.meta.dir, "..");

/** pin 版本（可复现性锚点；升级 = 改常量 + 更新双档 sha256）。
 * 注意：这是 GitHub release tag；包内 CLI 自报版本为 1.5.0（上游 tag 与
 * package.json version 漂移，2026-05 实查 lib/package.json=1.5.0）——升级时
 * 以 release tag 为准，别被 CLI --version 输出误导。 */
export const CODEGRAPH_VERSION = "1.6.0";

/** 分平台资产描述（pin 版本 + sha256 + 包格式）。 */
export interface CodegraphAsset {
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly format: "tar.gz" | "zip";
}

const CODEGRAPH_SHA256: Record<DesktopPlatform, string> = {
  "darwin-arm64": "1c73033512d55f67be04717e81532e8beaf7be6fb8531f51a179fa23064ad480",
  "windows-x64": "cd76c3c3391f2d40abef12b142151950b6d77abc2d8429e648f89eaa90f5b68a",
};

/** 平台档 → release 资产（sha256 与官方 SHA256SUMS 旁车一致）。 */
export function codegraphAsset(platform: DesktopPlatform): CodegraphAsset {
  const spec = platformSpec(platform);
  return {
    name: spec.codegraphAssetName,
    url: `https://github.com/colbymchenry/codegraph/releases/download/v${CODEGRAPH_VERSION}/${spec.codegraphAssetName}`,
    sha256: CODEGRAPH_SHA256[platform],
    format: spec.codegraphArchiveFormat,
  };
}

/** mac 档资产常量（darwin-arm64 缺省档兼容面；既有测试消费）。 */
export const CODEGRAPH_ASSET_NAME = codegraphAsset("darwin-arm64").name;
export const CODEGRAPH_URL = codegraphAsset("darwin-arm64").url;
export const CODEGRAPH_TARBALL_SHA256 = codegraphAsset("darwin-arm64").sha256;

/** 落位目录（tauri.conf bundle.resources 消费位，整目录进包；双档同位——
 * 构建机按自身平台档获取，内容随档不同）。 */
export const CODEGRAPH_DEST_DIR = join(root, "apps/shell/src-tauri/resources/codegraph");

/** 平台档 → 包内/仓内 launcher 路径（HELIX_CODEGRAPH_PATH 注入值）。 */
export function codegraphLauncher(platform: DesktopPlatform): string {
  return join(CODEGRAPH_DEST_DIR, ...platformSpec(platform).codegraphLauncherRel.split("/"));
}

/** mac 档 launcher 常量（darwin-arm64 缺省档兼容面；dev-desktop 消费）。 */
export const CODEGRAPH_LAUNCHER = codegraphLauncher("darwin-arm64");

/**
 * bundle 树守护（三锚，平台分档）：vendored node 存在且架构断言通过、
 * launcher 存在（darwin 档需执行位，缺则 chmod 保底）、lib/dist 存在。
 * 任一不过 → 抛错。
 */
export async function assertBundleTree(
  dir: string,
  platform: DesktopPlatform = "darwin-arm64",
): Promise<void> {
  const spec = platformSpec(platform);
  const node = join(dir, ...spec.codegraphNodeRel.split("/"));
  const launcher = join(dir, ...spec.codegraphLauncherRel.split("/"));
  const libDist = join(dir, "lib", "dist");
  if (!existsSync(node)) {
    throw new Error(`bundle 树缺 vendored node：${node}`);
  }
  // 架构反向断言（darwin 档 lipo arm64 / windows 档 PE x64）
  await assertBinaryForPlatform(node, platform);
  if (!existsSync(launcher)) {
    throw new Error(`bundle 树缺 launcher：${launcher}`);
  }
  // 执行位保底仅 darwin 档（tar 通常保留权限位；--from 本地拷贝可能丢；
  // windows 档 .cmd 无执行位语义）
  if (!spec.isWindows && (statSync(launcher).mode & 0o111) === 0) chmodSync(launcher, 0o755);
  if (!existsSync(libDist)) {
    throw new Error(`bundle 树缺 lib/dist（树不完整）：${libDist}`);
  }
}

/** 幂等判据：落位树存在且三锚守护全过。 */
export async function isInstalled(
  destDir: string = CODEGRAPH_DEST_DIR,
  platform: DesktopPlatform = "darwin-arm64",
): Promise<boolean> {
  if (!existsSync(destDir)) return false;
  try {
    await assertBundleTree(destDir, platform);
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
 * `--from <dir>` 形态：本地 bundle 目录整树拷贝 → 三锚守护。
 * 守护失败删档报错（不落位半成品）。
 */
export async function installFromLocal(
  srcDir: string,
  destDir: string = CODEGRAPH_DEST_DIR,
  platform: DesktopPlatform = "darwin-arm64",
): Promise<InstallResult> {
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    throw new Error(`--from 源不是已存在的 bundle 目录：${srcDir}`);
  }
  if (await isInstalled(destDir, platform)) {
    console.log(`✓ fetch-codegraph: 已存在且守护通过，幂等跳过：${destDir}`);
    return { skipped: true, path: destDir };
  }
  mkdirSync(dirname(destDir), { recursive: true });
  const tmp = `${destDir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  cpSync(srcDir, tmp, { recursive: true });
  try {
    await assertBundleTree(tmp, platform);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  rmSync(destDir, { recursive: true, force: true });
  renameSync(tmp, destDir);
  console.log(`✓ fetch-codegraph: --from 拷贝完成：${srcDir} → ${destDir}`);
  return { skipped: false, path: destDir };
}

/**
 * 校验 + 解压安装（tar.gz / zip 双格式）：sha256 不符即删档抛错；通过则
 * 解出 bundle 树走 installFromLocal 同一落位面（三锚守护 + 幂等）。
 */
export async function installFromArchive(
  archive: string,
  destDir: string = CODEGRAPH_DEST_DIR,
  platform: DesktopPlatform = "darwin-arm64",
): Promise<InstallResult> {
  const asset = codegraphAsset(platform);
  const actual = sha256OfFile(archive);
  if (actual !== asset.sha256) {
    rmSync(archive, { force: true });
    throw new Error(
      `sha256 校验失败（已删除 ${archive}）：期望 ${asset.sha256}，实际 ${actual}`,
    );
  }
  const extractDir = mkdtempSync(join(tmpdir(), "helix-codegraph-extract-"));
  try {
    // tar.gz / zip 统一走 bsdtar `tar -xf`（mac 与 Windows 10+ 系统 tar
    // 均支持 zip 自嗅探）
    const proc = Bun.spawn({
      cmd: ["tar", "-xf", archive, "-C", extractDir],
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) {
      throw new Error(`解压失败：${archive}：${err.trim()}`);
    }
    // 官方包结构：单一顶层目录 codegraph-<target>/（BUNDLING.md）——
    // 动态识别顶层目录，不硬编码 target 段名（双档通用）
    const topLevels = readdirSync(extractDir).filter((n) => !n.startsWith("."));
    if (topLevels.length !== 1) {
      throw new Error(`包顶层结构异常（期望单一目录）：${topLevels.join(", ")}`);
    }
    const extracted = join(extractDir, topLevels[0]!);
    if (!statSync(extracted).isDirectory()) {
      throw new Error(`包顶层不是目录：${extracted}`);
    }
    return await installFromLocal(extracted, destDir, platform);
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

/** 默认形态：固定版本下载（downloadToFile 带超时/停滞/重试）→ sha256 校验 → 解压落位。 */
export async function installFromRelease(
  destDir: string = CODEGRAPH_DEST_DIR,
  platform: DesktopPlatform = "darwin-arm64",
): Promise<InstallResult> {
  if (await isInstalled(destDir, platform)) {
    console.log(`✓ fetch-codegraph: 已存在且守护通过，幂等跳过：${destDir}`);
    return { skipped: true, path: destDir };
  }
  const asset = codegraphAsset(platform);
  const archive = join(mkdtempSync(join(tmpdir(), "helix-codegraph-dl-")), asset.name);
  try {
    await downloadToFile(asset.url, archive, { label: "fetch-codegraph" });
    return await installFromArchive(archive, destDir, platform);
  } finally {
    rmSync(dirname(archive), { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const platform = resolvePlatformArg(process.argv, process.env);
  const fromIdx = process.argv.indexOf("--from");
  if (fromIdx !== -1) {
    const src = process.argv[fromIdx + 1];
    if (!src || src.startsWith("-")) {
      console.error("✗ fetch-codegraph: --from 需要本地 bundle 目录参数");
      process.exit(1);
    }
    await installFromLocal(src, CODEGRAPH_DEST_DIR, platform);
    return;
  }
  await installFromRelease(CODEGRAPH_DEST_DIR, platform);
}

// import.meta.main 守卫：常量/函数被测试 import，导入不得触发下载副作用。
if (import.meta.main) {
  try {
    await main();
    const platform = resolvePlatformArg(process.argv, process.env);
    console.log(
      `✓ fetch-codegraph: ${CODEGRAPH_DEST_DIR}（codegraph ${CODEGRAPH_VERSION}, ${platform} bundle）`,
    );
  } catch (e) {
    console.error(`✗ fetch-codegraph: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
