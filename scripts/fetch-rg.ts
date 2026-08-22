#!/usr/bin/env bun
/**
 * fetch-rg —— CL-2/F2.3 管线段：ripgrep macOS arm64 二进制获取。
 *
 * 落位（AD-6 arm64 only / TR-AD-32）：apps/shell/src-tauri/resources/bin/rg，
 * 经 tauri.conf bundle.resources 进包（T3.1 接线）；壳 spawn sidecar 时经 env
 * HELIX_RG_PATH 注入，daemon resolve-rg ①bundle 级消费（T1.1）。
 *
 * 两种获取形态：
 * - 默认：GitHub releases 固定版本下载（pin 版本号 + sha256 校验，校验失败
 *   即删档报错）→ 解压 → chmod +x；
 * - `--from <path>`：本地 rg 直接拷贝（离线/加速场景），同样过 arm64 断言。
 *
 * 双重守护（AD-6 反向断言）：落位后 `lipo -info` 断言 arm64 单架构——拒绝
 * x86_64 切片 / universal / 非 Mach-O。幂等：已存在且 arm64 校验通过则跳过。
 *
 * 二进制不入 git（resources/bin/rg 已入 .gitignore），可复现性由 pin 版本 +
 * sha256 保证。工程层脚本，不被 apps 任何层 import（架构 §5.2）。
 *
 * 用法：
 *   bun scripts/fetch-rg.ts                # 固定版本下载
 *   bun scripts/fetch-rg.ts --from <path>  # 本地拷贝
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");

/** pin 版本（可复现性锚点；升级 = 改常量 + 更新 sha256）。 */
export const RG_VERSION = "15.1.0";
export const RG_ASSET_NAME = `ripgrep-${RG_VERSION}-aarch64-apple-darwin.tar.gz`;
export const RG_URL = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${RG_ASSET_NAME}`;
/** tar.gz 包级 sha256（与官方 .sha256 旁车文件一致）。 */
export const RG_TARBALL_SHA256 =
  "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715";

/** 落位（T3.1 tauri.conf bundle.resources 消费位）。 */
export const RG_DEST = join(root, "apps/shell/src-tauri/resources/bin/rg");

export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * lipo -info 断言 arm64 单架构（AD-6 反向断言）。
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

/** 幂等判据：已存在且 arm64 校验通过。 */
export async function isInstalled(dest: string = RG_DEST): Promise<boolean> {
  if (!existsSync(dest)) return false;
  try {
    await assertArm64Only(dest);
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
 * `--from <path>` 形态：本地拷贝 → chmod +x → lipo 断言。
 * 断言失败删档报错（不落位半成品）。
 */
export async function installFromLocal(
  src: string,
  dest: string = RG_DEST,
): Promise<InstallResult> {
  if (!existsSync(src)) {
    throw new Error(`--from 源不存在：${src}`);
  }
  if (await isInstalled(dest)) {
    console.log(`✓ fetch-rg: 已存在且 arm64 校验通过，幂等跳过：${dest}`);
    return { skipped: true, path: dest };
  }
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  copyFileSync(src, tmp);
  try {
    chmodSync(tmp, 0o755);
    await assertArm64Only(tmp);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  renameSync(tmp, dest);
  console.log(`✓ fetch-rg: --from 拷贝完成：${src} → ${dest}`);
  return { skipped: false, path: dest };
}

/**
 * 校验 + 解压安装：sha256 不符即删档抛错；通过则解出 rg 走 installFromLocal
 * 同一落位面（chmod + lipo 断言 + 幂等）。
 */
export async function installFromTarball(
  tarball: string,
  dest: string = RG_DEST,
): Promise<InstallResult> {
  const actual = sha256OfFile(tarball);
  if (actual !== RG_TARBALL_SHA256) {
    rmSync(tarball, { force: true });
    throw new Error(
      `sha256 校验失败（已删除 ${tarball}）：期望 ${RG_TARBALL_SHA256}，实际 ${actual}`,
    );
  }
  const extractDir = mkdtempSync(join(tmpdir(), "helix-rg-extract-"));
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
    const extracted = join(
      extractDir,
      `ripgrep-${RG_VERSION}-aarch64-apple-darwin`,
      "rg",
    );
    if (!existsSync(extracted)) {
      throw new Error(`tarball 内未找到预期 rg：${extracted}`);
    }
    return await installFromLocal(extracted, dest);
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

/** 默认形态：固定版本下载 → sha256 校验 → 解压落位。 */
export async function installFromRelease(dest: string = RG_DEST): Promise<InstallResult> {
  if (await isInstalled(dest)) {
    console.log(`✓ fetch-rg: 已存在且 arm64 校验通过，幂等跳过：${dest}`);
    return { skipped: true, path: dest };
  }
  console.log(`fetch-rg: 下载 ${RG_URL}`);
  const res = await fetch(RG_URL);
  if (!res.ok) {
    throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}（${RG_URL}）`);
  }
  const tarball = join(mkdtempSync(join(tmpdir(), "helix-rg-dl-")), RG_ASSET_NAME);
  try {
    await Bun.write(tarball, res);
    return await installFromTarball(tarball, dest);
  } finally {
    rmSync(dirname(tarball), { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const fromIdx = process.argv.indexOf("--from");
  if (fromIdx !== -1) {
    const src = process.argv[fromIdx + 1];
    if (!src || src.startsWith("-")) {
      console.error("✗ fetch-rg: --from 需要本地 rg 路径参数");
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
    const { statSync } = await import("node:fs");
    const mb = (statSync(RG_DEST).size / 1024 / 1024).toFixed(1);
    console.log(`✓ fetch-rg: ${RG_DEST}（${mb}MB, ripgrep ${RG_VERSION}, arm64）`);
  } catch (e) {
    console.error(`✗ fetch-rg: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
