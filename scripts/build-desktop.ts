#!/usr/bin/env bun
/**
 * build-desktop —— CL-2/F2.1/F2.4 一条命令桌面端构建管线（architecture §4.3/§4.7，
 * 平台化 TR-95：{darwin-arm64, win32-x64} 双档）。
 *
 * 六步依序（任一步非零退出即中断：打印 ✗ 步骤N + 透传 stderr 末 50 行 +
 * 以该 code 退出，后续步骤不启动——机械判据见 brief「决策消解」）：
 *   ① fetch-rg（bun scripts/fetch-rg.ts --platform <档>，幂等）
 *   ② fetch-codegraph（bun scripts/fetch-codegraph.ts --platform <档>，幂等）
 *   ③ compile（bun scripts/compile-daemon.ts --platform <档>，daemon → 单文件 sidecar）
 *   ④ F2.2 等价验证（bun smoke/verify-compiled-daemon.ts，双形态三探针对照，
 *      失败即断——管线内步骤，非手工检查项，架构 §4.3）——**仅 darwin-arm64 档
 *      编排**：windows-x64 档交叉编译产物（.exe）在 mac 宿主不可执行，F2.2
 *      双形态对照无从谈起；Windows 侧等价验证归 release workflow（Windows
 *      runner 原生跑）负责，不在本管线内。
 *   ⑤ vite build（apps/shell → 静态产物，frontendDist 消费位）
 *   ⑥ tauri build（cargo tauri build [--target <triple>]，捆绑 sidecar + rg +
 *      codegraph + 静态产物 → bundle；darwin 档保持裸 build 零回归，windows
 *      档显式 --target x86_64-pc-windows-msvc）
 *
 * 签名配置位（F2.4/AD-5）：resolveSigning 纯函数集中判定 tauri 官方环境
 * 变量键族，三分支——
 *   - 全缺 → adhoc：不显式禁签名，tauri 默认 ad-hoc 签名态；
 *   - 部分存在（有签名无公证凭据，或反之）→ sign-only：日志明示「签名不公证」；
 *   - 齐全（签名身份/证书对 + 公证凭据族）→ sign-and-notarize。
 * 三种分支均零硬编码证书：环境变量原样透传给 tauri build（spawn env 继承
 * process.env），脚本只读不写。
 *
 * 工程层脚本，不被 apps 任何层 import（架构 §5.2）。CLI 形态不做（AD-4）。
 * 用法：bun run build:desktop [-- --platform darwin-arm64|windows-x64]
 */
import { join } from "node:path";

import { platformSpec, resolvePlatformArg, type DesktopPlatform } from "./desktop-platform";

// ── 签名配置位（F2.4，纯函数面，集中一处判定）────────────────

export type SigningMode = "adhoc" | "sign-only" | "sign-and-notarize";

/** tauri 官方约定键族（docs：code signing macOS / notarization）。 */
const SIGNING_IDENTITY_KEY = "APPLE_SIGNING_IDENTITY";
const CERT_PAIR = ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD"] as const;
/** 公证两族：Apple ID app-specific password 族 / App Store Connect API key 族。 */
const NOTARIZE_APPLE_ID = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"] as const;
const NOTARIZE_API_KEY = ["APPLE_API_KEY", "APPLE_API_ISSUER"] as const;

const present = (v: string | undefined): boolean => v !== undefined && v.trim() !== "";
const hasAll = (env: Record<string, string | undefined>, keys: readonly string[]): boolean =>
  keys.every((k) => present(env[k]));

function signingConfigured(env: Record<string, string | undefined>): boolean {
  return present(env[SIGNING_IDENTITY_KEY]) || hasAll(env, CERT_PAIR);
}

function notarizeConfigured(env: Record<string, string | undefined>): boolean {
  return hasAll(env, NOTARIZE_APPLE_ID) || hasAll(env, NOTARIZE_API_KEY);
}

/**
 * 三分支判定：齐全 → sign-and-notarize；全缺 → adhoc；部分存在 → sign-only。
 * 纯函数（env 注入），全分支可单测。
 */
export function resolveSigning(env: Record<string, string | undefined>): SigningMode {
  const sign = signingConfigured(env);
  const notarize = notarizeConfigured(env);
  if (sign && notarize) return "sign-and-notarize";
  if (!sign && !notarize) return "adhoc";
  return "sign-only";
}

/** 签名分支一行明示日志（F2.4：部分存在须明示「签名不公证」）。 */
export function signingLogLine(mode: SigningMode): string {
  switch (mode) {
    case "adhoc":
      return "签名配置位：无证书环境变量 → ad-hoc 分支（tauri 默认签名态，AD-5 本迭代默认）";
    case "sign-only":
      return "签名配置位：部分凭据存在 → 签名不公证（缺签名身份或公证凭据族，见 APPLE_* 键族）";
    case "sign-and-notarize":
      return "签名配置位：凭据齐全 → 签名 + 公证（环境变量原样透传 tauri build）";
  }
}

// ── 管线编排（F2.1）────────────────────────────────────────

export interface StepSpec {
  readonly name: string;
  readonly cmd: string[];
  readonly cwd: string;
}

export interface StepResult {
  readonly code: number;
  readonly stderr: string;
}

export type StepRunner = (step: StepSpec) => Promise<StepResult>;
export type Logger = (line: string) => void;

/** 管线步骤契约（root + 平台档注入，命令组装可单测；TR-95 双档分发）。
 * darwin-arm64 档六步（含 F2.2）；windows-x64 档五步（省 F2.2——交叉编译
 * 产物 mac 宿主不可执行，见头注④）。 */
export function pipelineSteps(root: string, platform: DesktopPlatform = "darwin-arm64"): StepSpec[] {
  const bun = process.execPath;
  const spec = platformSpec(platform);
  const shellDir = join(root, "apps/shell");
  const steps: StepSpec[] = [
    { name: `fetch-rg（rg ${platform} 获取，幂等）`, cmd: [bun, join(root, "scripts/fetch-rg.ts"), "--platform", platform], cwd: root },
    { name: `fetch-codegraph（codegraph ${platform} 树获取，幂等）`, cmd: [bun, join(root, "scripts/fetch-codegraph.ts"), "--platform", platform], cwd: root },
    { name: `compile（daemon → ${platform} sidecar）`, cmd: [bun, join(root, "scripts/compile-daemon.ts"), "--platform", platform], cwd: root },
  ];
  if (!spec.isWindows) {
    steps.push({
      name: "F2.2 等价验证（双形态探针对照）",
      cmd: [bun, join(root, "smoke/verify-compiled-daemon.ts"), "--platform", platform],
      cwd: root,
    });
  }
  steps.push(
    { name: "vite build（shell 静态产物）", cmd: [bun, "run", "build"], cwd: shellDir },
    // 双档统一显式 --target：tauri 裸 build 按运行环境猜主机 triple（CI macos-14
    // 上曾解析成 x86_64-apple-darwin——tauri-cli 装了 x86 版跑在 Rosetta 下或
    // rust 主机误判——externalBin 期望 x86_64 daemon 而 compile-daemon 按
    // --platform 产 aarch64，错位构建失败）。显式 triple 消除猜测；
    // 代价 = 产物统一落 target/<triple>/release/bundle（双档一致）
    {
      name: `tauri build（bundle → ${spec.isWindows ? "nsis" : ".app/.dmg"}，--target ${spec.triple}）`,
      cmd: ["cargo", "tauri", "build", "--target", spec.triple],
      cwd: shellDir,
    },
  );
  return steps;
}

/** stderr 末 N 行截取（失败透传尾部，默认 50 行）。 */
export function stderrTail(text: string, n = 50): string {
  if (text === "") return "";
  const lines = text.replace(/\n+$/, "").split("\n");
  return lines.slice(-n).join("\n");
}

/**
 * 依序执行：任一步非零退出 → ✗ 步骤N 日志 + stderr 末 50 行 + 返回该 code；
 * 后续步骤不启动（runner 不再被调用）。runner/log 注入，全分支可单测。
 */
export async function runPipeline(
  steps: readonly StepSpec[],
  runner: StepRunner,
  log: Logger,
): Promise<number> {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const n = i + 1;
    log(`▶ 步骤${n}/${steps.length} ${step.name}`);
    const t0 = Date.now();
    const result = await runner(step);
    if (result.code !== 0) {
      log(`✗ 步骤${n} ${step.name} 失败（exit ${result.code}）`);
      const tail = stderrTail(result.stderr, 50);
      if (tail !== "") log(`  stderr 末 50 行：\n${tail}`);
      return result.code;
    }
    log(`✓ 步骤${n} ${step.name}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  }
  return 0;
}

/** 生产 runner：stdout 直通；stderr tee 直通 + 尾部累积（失败透传用）。 */
const realRunner: StepRunner = async (step) => {
  const proc = Bun.spawn({
    cmd: step.cmd,
    cwd: step.cwd,
    // 签名凭据等环境变量原样透传（F2.4 零硬编码证书）
    env: process.env as Record<string, string | undefined>,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "pipe",
  });
  let tail = "";
  const dec = new TextDecoder();
  const reader = proc.stderr.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      process.stderr.write(chunk);
      tail = (tail + chunk).slice(-16_384); // 尾部缓冲上界，末 50 行截取在 runPipeline
    }
  } catch {
    /* 进程已退出 */
  }
  const code = await proc.exited;
  return { code, stderr: tail };
};

// ── main ────────────────────────────────────────────────────

// import.meta.main 守卫：纯函数面被测试 import，导入不得触发管线副作用。
if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const platform = resolvePlatformArg(process.argv, process.env);
  const spec = platformSpec(platform);
  if (spec.isWindows) {
    // TR-95：首发不签名——Windows 无 Authenticode（SmartScreen 拦截为已知限制）
    console.log(`平台档：${platform}（TR-95 首发不签名：Windows 无 Authenticode）`);
  } else {
    const mode = resolveSigning(process.env);
    console.log(`平台档：${platform}`);
    console.log(signingLogLine(mode));
  }
  const code = await runPipeline(pipelineSteps(root, platform), realRunner, (l) => console.log(l));
  if (code === 0) {
    console.log(
      `✓ build-desktop 全管线完成：src-tauri/target/${spec.triple}/release/bundle（${spec.isWindows ? "nsis，未签名 TR-95" : "macos/*.app + dmg/*.dmg"}）`,
    );
  }
  process.exit(code);
}
