/**
 * 装配指引（architecture.md §7 落位：由 SubAgentProfile/MainAgent 提示词
 * 携带段库+硬约束+装配示例引用，AD-18）。
 *
 * 两个变体只差首句角色定位（brief 装配端 = MainAgent 派发时；report
 * 装配端 = SubAgent 收口时），段库目录与三条硬约束全文共用同一数据源
 * （catalog.ts）——提示词与段库元数据零漂移。
 *
 * 约束：指引文本不得含英文工具名（profile 瘦身契约，profile-slim
 * 测试断言静态工具名词边界零命中）；深入材料经 TEMPLATE-USAGE.md
 * 路径按需获取（渐进披露，dense payload 教训 F-4）。
 */

import { SEGMENT_CATALOG, SEGMENT_SCENARIOS, TEMPLATE_HARD_CONSTRAINTS } from "./catalog";

/** TEMPLATE-USAGE.md 仓内路径（段库全文+装配示例的按需读取入口）。 */
export const TEMPLATE_USAGE_PATH =
  "apps/daemon/src/adapters/driven/pi-engine/runtime/templates/TEMPLATE-USAGE.md";

/** 按场景渲染段目录行：「- 段名：用途」。 */
function catalogLines(): string[] {
  const lines: string[] = [];
  for (const scenario of SEGMENT_SCENARIOS) {
    lines.push(`[${scenario} 场景]`);
    for (const seg of SEGMENT_CATALOG.filter((s) => s.scenario === scenario)) {
      lines.push(`- ${seg.title}：${seg.purpose}`);
    }
  }
  return lines;
}

/** 共用指引体：段库目录 + 三条硬约束 + USAGE 文档引用。 */
function guideBody(roleLine: string): string {
  return [
    roleLine,
    "模板段库（AD-18：按任务实况选段装配，任务形态是开放集合——僵死模板致错配，不为填段执行段外动作）：",
    ...catalogLines(),
    "硬约束（不可裁剪——你判断任务需要哪些段，不判断约束要不要守）：",
    ...TEMPLATE_HARD_CONSTRAINTS.map((c, i) => `${i + 1}. ${c.text}`),
    `段库片段全文与装配示例见 ${TEMPLATE_USAGE_PATH}（示例为参考格式非强制）。`,
  ].join("\n");
}

/** MainAgent（brief 装配端）提示词追加段。 */
export const BRIEF_ASSEMBLY_GUIDE = guideBody(
  "任务派发装配指引：派发 SubAgent 任务时，按模板段库组任务 brief——brief 四段逻辑：任务→约束（kg 约束切片注入区）→测试→完成标准；空段整段省略。",
);

/** SubAgent（report 装配端）提示词追加段。 */
export const REPORT_ASSEMBLY_GUIDE = guideBody(
  "任务收口装配指引：写任务完成报告时，按模板段库组 report（summary/deviation/findings/tests 执行记录，按实况选段）；findings 是知识落账输入，无发现也必须显式写「无」。",
);
