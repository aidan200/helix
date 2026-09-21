#!/usr/bin/env bun
/**
 * fetch-vec0 —— 管家记忆 B1 管线段：sqlite-vec 扩展（vec0）落位（TR-95
 * 双档：darwin-arm64 / windows-x64）。
 *
 * 落位（fetch-rg 同构）：apps/shell/src-tauri/resources/bin/vec0.dylib
 * （darwin 档）/ resources/bin/vec0.dll（windows 档），经 tauri 平台档
 * bundle.resources 进包；壳 spawn sidecar 时经 env HELIX_VEC_PATH 注入，
 * daemon resolve-vec0 ①bundle 级消费（②级 = dev 形态 node_modules）。
 *
 * 与 fetch-rg 的获取形态差异：vec0 不做 GitHub releases 下载面——它是
 * daemon 运行时依赖 sqlite-vec 的平台 optional 包产物（node_modules 内
 * 已按宿主平台就位），确定性由 bun.lock pin 保证（与 daemon 运行时加载
 * 的版本同源——下载面反而会引入「包内 vec0 ≠ 运行时 vec0」双轨风险）。
 * 跨档获取不支持（--platform 必须与宿主一致——sqlite-vec 只装宿主平台
 * optional 包；windows 档在 windows 构建机上跑本脚本）。
 *
 * 幂等：目标已存在且体积与源一致则跳过。二进制不入 git
 * （resources/bin/vec0.* 已入 .gitignore）。
 *
 * 用法：bun scripts/fetch-vec0.ts [--platform darwin-arm64|windows-x64]
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { platformSpec, type DesktopPlatform } from "./desktop-platform";

export interface FetchVec0Result {
  readonly dest: string;
  readonly action: "copied" | "skipped";
}

/** 落位执行体（依赖注入可单测——resolvePath/dest 全注入，零环境直读）。 */
export function fetchVec0(deps: {
  readonly platform: DesktopPlatform;
  readonly resourcesDir: string;
  readonly resolvePath: () => string;
  readonly hostPlatform?: DesktopPlatform;
}): FetchVec0Result {
  const spec = platformSpec(deps.platform);
  const host = deps.hostPlatform ?? deps.platform;
  if (host !== deps.platform) {
    throw new Error(
      `vec0 跨档获取不支持（宿主 ${host} ≠ 目标 ${deps.platform}）——sqlite-vec 只装宿主平台 optional 包，请在目标平台构建机上执行`,
    );
  }
  const src = deps.resolvePath();
  if (!existsSync(src)) {
    throw new Error(`vec0 源不存在：${src}（sqlite-vec 平台包未安装？——先 bun install）`);
  }
  const dest = join(deps.resourcesDir, "bin", spec.vec0BinaryName);
  if (existsSync(dest) && statSync(dest).size === statSync(src).size) {
    return { dest, action: "skipped" };
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return { dest, action: "copied" };
}

function parsePlatform(argv: readonly string[]): DesktopPlatform {
  const idx = argv.indexOf("--platform");
  const value = idx >= 0 ? argv[idx + 1] : undefined;
  if (value === "darwin-arm64" || value === "windows-x64") return value;
  // 缺省 = 宿主档（TR-95 双档外平台 → 报错引导）
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "win32" && process.arch === "x64") return "windows-x64";
  throw new Error(`宿主平台不在 TR-95 双档内（${process.platform}-${process.arch}）——请显式 --platform`);
}

if (import.meta.main) {
  // sqlite-vec 装在 daemon 包（bun.lock 单点锁），根 scripts/ 经 createRequire
  // 指向 daemon package.json 解析——脚本自身零依赖，免根目录重复安装
  const daemonRequire = createRequire(
    join(import.meta.dir, "..", "apps", "daemon", "package.json"),
  );
  const { getLoadablePath } = daemonRequire("sqlite-vec");
  const platform = parsePlatform(process.argv.slice(2));
  const result = fetchVec0({
    platform,
    resourcesDir: join(import.meta.dir, "..", "apps", "shell", "src-tauri", "resources"),
    resolvePath: () => getLoadablePath(),
  });
  console.log(`[fetch-vec0] ${result.action === "copied" ? "已落位" : "已存在（幂等跳过）"}：${result.dest}`);
}
