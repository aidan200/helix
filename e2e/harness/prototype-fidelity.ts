/**
 * G11 checkPrototypeFidelity —— 原型还原度机械化断言承载工具
 * （TP-CL5-5 / F(5.5).5；iter-20260818-mq5a T4.1，CL-5 裁决 G11 落地）。
 *
 * 对「实现 vs review.md 必须还原清单」做机械化断言承载：每条断言以
 * review.md 清单编号（R-Pn-m，test-design §3 映射表标「G ✓」项）登记，
 * 工具统一执行并产出逐项报告（PASS / FAIL / PENDING）——红输出直接映射
 * 回清单条目，替代 spec 内散点显式断言（test-design §5 注记 8：工具落地后
 * §3「G ✓」项由工具统一跑，spec 保留行为/状态类断言）。
 *
 * 形态：纯 runner（不内嵌 Playwright 断言上下文）——check 是返回
 * Promise<void> 的闭包（内部用 expect/locator 均可），工具只簿记结果；
 * 因此工具自身可离浏览器做红/绿两路径自测（见 CL-5-prototype-fidelity.spec.ts）。
 *
 * 状态语义：
 * - run：本期接入实跑（失败 = 还原缺口，测试红）；
 * - pending：已登记但依赖未落地实现（如并行任务面），报告标 PENDING 不计
 *   失败——清单登记先行、实现落地后翻 run（防「清单与断言两张皮」）。
 */

/** 单条还原度断言（对应 review.md 必须还原清单一项）。 */
export interface FidelityCheck {
  /** review.md 清单编号（R-Pn-m）。 */
  id: string;
  /** 断言要点（清单条目摘要）。 */
  title: string;
  /** run = 实跑；pending = 登记待落地（缺省 run）。 */
  status?: "run" | "pending";
  /** 断言体：抛错 = 还原缺口（FAIL）。 */
  run: () => void | Promise<void>;
}

export type FidelityStatus = "pass" | "fail" | "pending";

export interface FidelityResult {
  id: string;
  title: string;
  status: FidelityStatus;
  /** status = fail 时的断言错误信息。 */
  error?: string;
}

export interface FidelityReport {
  results: FidelityResult[];
  passed: FidelityResult[];
  failed: FidelityResult[];
  pending: FidelityResult[];
}

/** 执行清单并簿记逐项结果（单条失败不中断后续项——报告全量缺口）。 */
export async function checkPrototypeFidelity(checks: FidelityCheck[]): Promise<FidelityReport> {
  const results: FidelityResult[] = [];
  for (const check of checks) {
    if (check.status === "pending") {
      results.push({ id: check.id, title: check.title, status: "pending" });
      continue;
    }
    try {
      await check.run();
      results.push({ id: check.id, title: check.title, status: "pass" });
    } catch (err) {
      results.push({
        id: check.id,
        title: check.title,
        status: "fail",
        error: err instanceof Error ? (err.message.split("\n")[0] ?? err.message) : String(err),
      });
    }
  }
  return {
    results,
    passed: results.filter((r) => r.status === "pass"),
    failed: results.filter((r) => r.status === "fail"),
    pending: results.filter((r) => r.status === "pending"),
  };
}

/** 报告格式化（逐项 [PASS]/[FAIL]/[PENDING] + 汇总行；红输出映射清单编号）。 */
export function formatFidelityReport(report: FidelityReport): string {
  const lines = report.results.map((r) => {
    const tag = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "PENDING";
    const tail = r.status === "fail" ? ` —— ${r.error}` : "";
    return `[${tag}] ${r.id} ${r.title}${tail}`;
  });
  lines.push(
    `checkPrototypeFidelity: ${report.passed.length} pass / ${report.failed.length} fail / ${report.pending.length} pending（共 ${report.results.length} 项）`,
  );
  return lines.join("\n");
}

/** 绿门：存在 FAIL 项即抛（信息 = 全量报告）。spec 末尾统一调用。 */
export function assertFidelityGreen(report: FidelityReport): void {
  if (report.failed.length > 0) {
    throw new Error(`checkPrototypeFidelity 检出还原缺口：\n${formatFidelityReport(report)}`);
  }
}
