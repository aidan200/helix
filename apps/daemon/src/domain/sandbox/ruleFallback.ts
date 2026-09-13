/**
 * 规则级 fallback 执行器（U0c 二期第一项——全平台降基层）。
 *
 * 为什么存在：seatbelt 只在 macOS 存在。Windows / macOS 自检失败
 * （sandbox-exec 缺失或行为漂移）时，旧降级路径是 undefined（全透传
 * ——「降级=裸奔」）。fallback 把降级语义改为规则级防护：
 * - bash：静态提取写候选（复用 U0b L1——planBashSegments，cd-aware
 *   段级），候选 ∉ writableRoots → 拒执行；无候选（不可判定类：
 *   python -c / node -e / make / test）→ 放行，靠 U0b L2 感知对账；
 * - 工具写（write/edit 族）：TS 判定，与 seatbelt 模式同一包装
 *   （全平台同构，非本文件职责）。
 *
 * 威胁模型（U0c 定稿）：防诚实错误（agent 没意识到越界/算错路径），
 * 不防蓄意逃逸（eval/变量拼接构造静态不可判定写——绕过后有
 * undeclared 审计兜底，物理拦截是内核级沙箱的职责）。
 *
 * 诚实边界：提取器覆盖可判定形态（重定向 / sed -i / mv / cp / rm /
 * tee / git apply 等——U0b 既有词汇表），任意 shell 静态分析不可能
 * 完备；「可判定类硬阻断 + 不可判定类放行对账」是明知的取舍。
 */

import { planBashSegments } from "../writefact/bashExtract";
import { isPathWritable, type SandboxPolicy } from "./SandboxPolicy";

/** 纯字符串路径解析（base + rel 折叠——与 bashExtract.resolveWithin 同语义，domain 纪律不 import node:path）。 */
function resolveWithin(base: string, rel: string): string {
  const isAbs = rel.startsWith("/");
  const parts = (isAbs ? rel : `${base}/${rel}`).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(p);
  }
  return `/${out.join("/")}`;
}

/** fallback 判定结果。violations 为越界候选的绝对路径（段 cwd 解析后）。 */
export interface FallbackVerdict {
  readonly allowed: boolean;
  readonly violations: readonly string[];
}

/**
 * 规则级写判定：提取命令全部写候选（cd-aware 段规划），逐个对
 * writableRoots 判定。任一越界 → 拒整条命令（宁可整拒——部分放行
 * 会留下「命令跑了一半」的中间态，比拒绝更糟）。
 *
 * 失锁段（cd $VAR 后）相对路径候选已被 planBashSegments 丢弃
 * （根不可知——错根误判比漏判糟），只剩绝对路径候选参与判定。
 */
export function classifyBashWrites(command: string, cwd: string, policy: SandboxPolicy): FallbackVerdict {
  const violations: string[] = [];
  for (const seg of planBashSegments(command, cwd)) {
    for (const w of seg.writes) {
      const abs = w.startsWith("/") ? resolveWithin(w, ".") : seg.cwd !== null ? resolveWithin(seg.cwd, w) : null;
      if (abs === null) continue; // 失锁段相对候选已滤，防御性兜底
      if (!isPathWritable(abs, policy)) violations.push(abs);
    }
  }
  return { allowed: violations.length === 0, violations };
}

/** fallback 拒绝文案（出路导向：工具通道有精确感知且不受 bash 判定约束）。 */
export function fallbackDeniedMessage(violations: readonly string[]): string {
  const list = violations.map((v) => `  - ${v}`).join("\n");
  return [
    `helix 沙箱（规则级防护）：命令的写目标超出允许面：`,
    list,
    ``,
    `出路：`,
    `  1. 目标确需写入且属本任务范围 → 用 write/edit 工具写（精确感知，不走 bash 判定）；`,
    `  2. 目标是可再生产物 → 指向允许面内路径（workspace / ~/.helix / 系统临时目录）；`,
    `  3. 误判（静态提取的路径不是真实写目标）→ 改写命令形态（显式绝对路径）后重试。`,
  ].join("\n");
}

/**
 * 执行器形态决策（纯函数——供 readSandboxRuntime 与测试直用）。
 * darwin + seatbelt 自检过 → seatbelt；win32 + helper 可用且自检过 → helper；
 * 其余（linux / 自检败 / helper 缺失）→ fallback。
 */
export function resolveEnforcer(
  platform: NodeJS.Platform,
  seatbeltSelfCheckOk: boolean,
  windowsHelperOk: boolean,
): "seatbelt" | "helper" | "fallback" {
  if (platform === "darwin") return seatbeltSelfCheckOk ? "seatbelt" : "fallback";
  if (platform === "win32") return windowsHelperOk ? "helper" : "fallback";
  return "fallback";
}
