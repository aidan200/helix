#!/usr/bin/env bun
/**
 * compile-daemon —— CL-2/F2.1 管线第一段：daemon → 单文件可执行（平台化，
 * TR-95：{darwin-arm64, win32-x64} 双档）。
 *
 * 产物落位（F2.3 / AD-4）：apps/shell/src-tauri/binaries/helix-daemon-<triple>[.exe]
 * ——Tauri externalBin target-triple 命名约定，T3.1 tauri.conf 接线直接消费；
 * Windows 产物名须带 .exe（helix-daemon-x86_64-pc-windows-msvc.exe）。
 * 平台分档（desktop-platform 注册表单点）：bun target / triple 命名 /
 * 架构断言形态——lipo 仅 darwin-arm64 档用，windows-x64 档走 PE x64 断言
 * （assertPeX64，lipo 的 Windows 等价物）。
 *
 * 失败语义（F2.1）：compile 非零退出 / 产物缺失 / 架构断言失败 → 本脚本
 * 非零退出（管线内步骤语义，失败即中断）。工程层脚本，不被 apps 任何层
 * import（架构 §5.2）。
 *
 * 用法：
 *   bun scripts/compile-daemon.ts                          # 缺省 = 宿主档（mac = darwin-arm64）
 *   bun scripts/compile-daemon.ts --platform windows-x64   # 交叉编译 windows 档
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { platformSpec, resolvePlatformArg, type DesktopPlatform } from "./desktop-platform";
import { assertArm64Only, assertPeX64 } from "./fetch-rg";

const root = join(import.meta.dir, "..");

/** 产物路径（Tauri externalBin target-triple 命名；平台分档 TR-95）。 */
export function compiledDaemonPath(platform: DesktopPlatform): string {
  return join(root, "apps/shell/src-tauri/binaries", platformSpec(platform).daemonBinaryName);
}

/** mac 档产物路径（darwin-arm64 缺省档常量；smoke 探针 import 兼容面）。 */
export const COMPILED_DAEMON_PATH = compiledDaemonPath("darwin-arm64");

const ENTRY = join(root, "apps/daemon/src/main.ts");

async function main(): Promise<void> {
  const platform = resolvePlatformArg(process.argv, process.env);
  const spec = platformSpec(platform);
  const outPath = compiledDaemonPath(platform);
  mkdirSync(join(outPath, ".."), { recursive: true });
  const proc = Bun.spawn({
    cmd: [
      process.execPath, // bun 自身
      "build",
      "--compile",
      `--target=${spec.bunTarget}`,
      ENTRY,
      "--outfile",
      outPath,
    ],
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`✗ compile-daemon: bun build --compile 失败（exit ${code}）`);
    process.exit(1);
  }
  if (!existsSync(outPath) || statSync(outPath).size === 0) {
    console.error(`✗ compile-daemon: 产物缺失或为空：${outPath}`);
    process.exit(1);
  }
  // 架构断言按平台分档（TR-95）：lipo 仅 mac；windows 走 PE x64 断言
  if (spec.isWindows) {
    assertPeX64(outPath);
  } else {
    await assertArm64Only(outPath);
  }
  const sha = createHash("sha256").update(readFileSync(outPath)).digest("hex").slice(0, 16);
  const mb = (statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`✓ compile-daemon: ${outPath}（${mb}MB, sha256:${sha}…, ${platform}）`);
}

// import.meta.main 守卫：compiledDaemonPath/COMPILED_DAEMON_PATH 被 smoke
// 探针 import，导入不得触发编译副作用。
if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`✗ compile-daemon: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
