#!/usr/bin/env bun
/**
 * build-desktop —— CL-2/F2.1/F2.4 一条命令桌面端构建管线（architecture §4.3/§4.7）。
 *
 * 六步依序（任一步非零退出即中断：打印 ✗ 步骤N + 透传 stderr 末 50 行 +
 * 以该 code 退出，后续步骤不启动——机械判据见 brief「决策消解」）：
 *   ① fetch-rg（bun scripts/fetch-rg.ts，幂等：已存在且 arm64 校验通过则跳过）
 *   ② fetch-codegraph（bun scripts/fetch-codegraph.ts，幂等：树完整+vendored node arm64 校验通过则跳过）
 *   ③ compile（bun scripts/compile-daemon.ts，daemon → arm64 单文件 sidecar）
 *   ④ F2.2 等价验证（bun smoke/verify-compiled-daemon.ts，双形态三探针对照，
 *      失败即断——管线内步骤，非手工检查项，架构 §4.3）
 *   ⑤ vite build（apps/shell → 静态产物，frontendDist 消费位）
 *   ⑥ tauri build（cargo tauri build，捆绑 sidecar + rg + codegraph + 静态产物 →
 *      src-tauri/target/release/bundle/{macos/*.app, dmg/*.dmg}，arm64 only AD-6）
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
 * 用法：bun run build:desktop
 */
import { join } from "node:path";

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

/** 五步契约（root 注入，命令组装可单测）。 */
export function pipelineSteps(root: string): StepSpec[] {
  const bun = process.execPath;
  const shellDir = join(root, "apps/shell");
  return [
    { name: "fetch-rg（rg arm64 获取，幂等）", cmd: [bun, join(root, "scripts/fetch-rg.ts")], cwd: root },
    { name: "fetch-codegraph（codegraph arm64 树获取，幂等）", cmd: [bun, join(root, "scripts/fetch-codegraph.ts")], cwd: root },
    { name: "compile（daemon → arm64 sidecar）", cmd: [bun, join(root, "scripts/compile-daemon.ts")], cwd: root },
    { name: "F2.2 等价验证（双形态探针对照）", cmd: [bun, join(root, "smoke/verify-compiled-daemon.ts")], cwd: root },
    { name: "vite build（shell 静态产物）", cmd: [bun, "run", "build"], cwd: shellDir },
    { name: "tauri build（bundle → .app/.dmg）", cmd: ["cargo", "tauri", "build"], cwd: shellDir },
  ];
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
  const mode = resolveSigning(process.env);
  console.log(signingLogLine(mode));
  const code = await runPipeline(pipelineSteps(root), realRunner, (l) => console.log(l));
  if (code === 0) {
    console.log("✓ build-desktop 全管线完成：src-tauri/target/release/bundle/{macos/*.app, dmg/*.dmg}");
  }
  process.exit(code);
}
