#!/usr/bin/env bun
/**
 * fetch-codegraph —— codegraph bundle-only 定位改造（CL-2 管线段）：
 * codegraph macOS arm64 自包含 bundle 获取。
 *
 * 与 fetch-rg 的本质差异：codegraph 是 node CLI，官方分发形态为自包含
 * bundle 目录树（vendored Node runtime + lib/dist + bin/codegraph launcher，
 * 见其 BUNDLING.md），不是单文件——落位是整棵目录树。
 *
 * 落位（AD-6 arm64 only / TR-AD-32）：apps/shell/src-tauri/resources/codegraph/，
 * 经 tauri.conf bundle.resources 整目录进包（包内 Resources/codegraph/）；
 * 壳 spawn sidecar 时经 env HELIX_CODEGRAPH_PATH 注入包内 launcher 路径
 * （Resources/codegraph/bin/codegraph），daemon resolve-codegraph ①bundle
 * 级消费。
 *
 * 两种获取形态：
 * - 默认：GitHub releases 固定版本下载（pin 版本号 + sha256 校验，校验失败
 *   即删档报错）→ 解压整树；
 * - `--from <dir>`：本地 bundle 目录直接拷贝（离线/加速场景），同样过守护。
 *
 * 守护面（单文件 rg 的 lipo 断言在目录树形态下的等价物）：
 * - vendored node 存在且 lipo 断言 arm64 单架构（AD-6 反向断言）；
 * - bin/codegraph launcher 存在且带执行位（chmod 保底）；
 * - lib/dist 存在（树完整性最低锚）。
 * 幂等：落位树三项守护全过则跳过。
 *
 * bundle 树不入 git（resources/codegraph 已入 .gitignore），可复现性由
 * pin 版本 + sha256 保证。工程层脚本，不被 apps 任何层 import（架构 §5.2）。
 *
 * 用法：
 *   bun scripts/fetch-codegraph.ts                # 固定版本下载
 *   bun scripts/fetch-codegraph.ts --from <dir>   # 本地 bundle 目录拷贝
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

import { assertArm64Only, sha256OfFile } from "./fetch-rg";

const root = join(import.meta.dir, "..");

/** pin 版本（可复现性锚点；升级 = 改常量 + 更新 sha256）。
 * 注意：这是 GitHub release tag；包内 CLI 自报版本为 1.5.0（上游 tag 与
 * package.json version 漂移，2026-05 实查 lib/package.json=1.5.0）——升级时
 * 以 release tag 为准，别被 CLI --version 输出误导。 */
export const CODEGRAPH_VERSION = "1.6.0";
export const CODEGRAPH_ASSET_NAME = "codegraph-darwin-arm64.tar.gz";
export const CODEGRAPH_URL = `https://github.com/colbymchenry/codegraph/releases/download/v${CODEGRAPH_VERSION}/${CODEGRAPH_ASSET_NAME}`;
/** tar.gz 包级 sha256（与官方 SHA256SUMS 旁车文件一致）。 */
export const CODEGRAPH_TARBALL_SHA256 =
  "1c73033512d55f67be04717e81532e8beaf7be6fb8531f51a179fa23064ad480";

/** 落位目录（tauri.conf bundle.resources 消费位，整目录进包）。 */
export const CODEGRAPH_DEST_DIR = join(root, "apps/shell/src-tauri/resources/codegraph");
/** 包内/仓内 launcher 相对位（HELIX_CODEGRAPH_PATH 注入值 = CODEGRAPH_LAUNCHER）。 */
export const CODEGRAPH_LAUNCHER = join(CODEGRAPH_DEST_DIR, "bin", "codegraph");

/**
 * bundle 树守护（三锚）：vendored node 存在且 arm64、launcher 存在且有
 * 执行位（缺则 chmod 保底）、lib/dist 存在。任一不过 → 抛错。
 */
export async function assertBundleTree(dir: string): Promise<void> {
  const node = join(dir, "node");
  const launcher = join(dir, "bin", "codegraph");
  const libDist = join(dir, "lib", "dist");
  if (!existsSync(node)) {
    throw new Error(`bundle 树缺 vendored node：${node}`);
  }
  await assertArm64Only(node); // AD-6 反向断言（lipo，非 Mach-O/含 x86_64 即抛）
  if (!existsSync(launcher)) {
    throw new Error(`bundle 树缺 launcher：${launcher}`);
  }
  // 执行位保底（tar 通常保留权限位；--from 本地拷贝可能丢）
  if ((statSync(launcher).mode & 0o111) === 0) chmodSync(launcher, 0o755);
  if (!existsSync(libDist)) {
    throw new Error(`bundle 树缺 lib/dist（树不完整）：${libDist}`);
  }
}

/** 幂等判据：落位树存在且三锚守护全过。 */
export async function isInstalled(destDir: string = CODEGRAPH_DEST_DIR): Promise<boolean> {
  if (!existsSync(destDir)) return false;
  try {
    await assertBundleTree(destDir);
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
): Promise<InstallResult> {
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    throw new Error(`--from 源不是已存在的 bundle 目录：${srcDir}`);
  }
  if (await isInstalled(destDir)) {
    console.log(`✓ fetch-codegraph: 已存在且守护通过，幂等跳过：${destDir}`);
    return { skipped: true, path: destDir };
  }
  mkdirSync(dirname(destDir), { recursive: true });
  const tmp = `${destDir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  cpSync(srcDir, tmp, { recursive: true });
  try {
    await assertBundleTree(tmp);
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
 * 校验 + 解压安装：sha256 不符即删档抛错；通过则解出 bundle 树走
 * installFromLocal 同一落位面（三锚守护 + 幂等）。
 */
export async function installFromTarball(
  tarball: string,
  destDir: string = CODEGRAPH_DEST_DIR,
): Promise<InstallResult> {
  const actual = sha256OfFile(tarball);
  if (actual !== CODEGRAPH_TARBALL_SHA256) {
    rmSync(tarball, { force: true });
    throw new Error(
      `sha256 校验失败（已删除 ${tarball}）：期望 ${CODEGRAPH_TARBALL_SHA256}，实际 ${actual}`,
    );
  }
  const extractDir = mkdtempSync(join(tmpdir(), "helix-codegraph-extract-"));
  try {
    const proc = Bun.spawn({
      cmd: ["tar", "-xzf", tarball, "-C", extractDir],
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    if ((await proc.exited) !== 0) {
      throw new Error(`解压失败：${tarball}：${err.trim()}`);
    }
    // 官方包结构：单一顶层目录 codegraph-<target>/（BUNDLING.md）——
    // 动态识别顶层目录，不硬编码 target 段名
    const topLevels = readdirSync(extractDir).filter((n) => !n.startsWith("."));
    if (topLevels.length !== 1) {
      throw new Error(`tarball 顶层结构异常（期望单一目录）：${topLevels.join(", ")}`);
    }
    const extracted = join(extractDir, topLevels[0]!);
    if (!statSync(extracted).isDirectory()) {
      throw new Error(`tarball 顶层不是目录：${extracted}`);
    }
    return await installFromLocal(extracted, destDir);
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

/** 默认形态：固定版本下载 → sha256 校验 → 解压落位。 */
export async function installFromRelease(destDir: string = CODEGRAPH_DEST_DIR): Promise<InstallResult> {
  if (await isInstalled(destDir)) {
    console.log(`✓ fetch-codegraph: 已存在且守护通过，幂等跳过：${destDir}`);
    return { skipped: true, path: destDir };
  }
  console.log(`fetch-codegraph: 下载 ${CODEGRAPH_URL}`);
  const res = await fetch(CODEGRAPH_URL);
  if (!res.ok) {
    throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}（${CODEGRAPH_URL}）`);
  }
  const tarball = join(mkdtempSync(join(tmpdir(), "helix-codegraph-dl-")), CODEGRAPH_ASSET_NAME);
  try {
    await Bun.write(tarball, res);
    return await installFromTarball(tarball, destDir);
  } finally {
    rmSync(dirname(tarball), { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const fromIdx = process.argv.indexOf("--from");
  if (fromIdx !== -1) {
    const src = process.argv[fromIdx + 1];
    if (!src || src.startsWith("-")) {
      console.error("✗ fetch-codegraph: --from 需要本地 bundle 目录参数");
      process.exit(1);
    }
    await installFromLocal(src);
    return;
  }
  await installFromRelease();
}

// import.meta.main 守卫：常量/函数被测试 import，导入不得触发下载副作用。
if (import.meta.main) {
  try {
    await main();
    console.log(
      `✓ fetch-codegraph: ${CODEGRAPH_DEST_DIR}（codegraph ${CODEGRAPH_VERSION}, darwin-arm64 bundle）`,
    );
  } catch (e) {
    console.error(`✗ fetch-codegraph: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
