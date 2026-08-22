#!/usr/bin/env bun
/**
 * compile-daemon —— CL-2/F2.1 管线第一段：daemon → arm64 单文件可执行。
 *
 * 产物落位（F2.3 / AD-4）：apps/shell/src-tauri/binaries/helix-daemon-aarch64-apple-darwin
 * ——Tauri externalBin target-triple 命名约定，T3.1 tauri.conf 接线直接消费。
 * 目标平台 arm64 only（AD-6）：--target=bun-darwin-arm64，不产 universal/x64。
 *
 * 失败语义（F2.1）：compile 非零退出 / 产物缺失 → 本脚本非零退出（管线内
 * 步骤语义，失败即中断）。工程层脚本，不被 apps 任何层 import（架构 §5.2）。
 *
 * 用法：bun scripts/compile-daemon.ts
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/** 产物路径（Tauri externalBin target-triple 命名；AD-6 arm64 only）。 */
export const COMPILED_DAEMON_PATH = join(
  root,
  "apps/shell/src-tauri/binaries/helix-daemon-aarch64-apple-darwin",
);

const ENTRY = join(root, "apps/daemon/src/main.ts");

async function main(): Promise<void> {
  mkdirSync(join(COMPILED_DAEMON_PATH, ".."), { recursive: true });
  const proc = Bun.spawn({
    cmd: [
      process.execPath, // bun 自身
      "build",
      "--compile",
      "--target=bun-darwin-arm64",
      ENTRY,
      "--outfile",
      COMPILED_DAEMON_PATH,
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
  if (!existsSync(COMPILED_DAEMON_PATH) || statSync(COMPILED_DAEMON_PATH).size === 0) {
    console.error(`✗ compile-daemon: 产物缺失或为空：${COMPILED_DAEMON_PATH}`);
    process.exit(1);
  }
  const sha = createHash("sha256")
    .update(readFileSync(COMPILED_DAEMON_PATH))
    .digest("hex")
    .slice(0, 16);
  const mb = (statSync(COMPILED_DAEMON_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`✓ compile-daemon: ${COMPILED_DAEMON_PATH}（${mb}MB, sha256:${sha}…, arm64）`);
}

// import.meta.main 守卫：COMPILED_DAEMON_PATH 常量被 smoke 探针 import，
// 导入不得触发编译副作用。
if (import.meta.main) {
  await main();
}
