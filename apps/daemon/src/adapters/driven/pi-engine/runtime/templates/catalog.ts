/**
 * 段库目录（architecture.md §7，AD-18，F1.3/F3.1/F3.3；T2.2 增批次两段）。
 *
 * 模板体系 = **段库 + LLM 装配 + 三条硬约束**：brief / report /
 * kg-change-report 三场景各持段库；装配由 LLM 按任务实况选段
 * （派发时 MainAgent 组 brief、收口时 SubAgent 同策略组 report；T2.2 起
 * 任务编排主 agent 同策略组批次 brief）——任务形态是开放集合，僵死模板
 * 致错配（F-23：agent 为填段执行段外动作）。
 *
 * 本模块是段库元数据的**唯一事实源**（段名×场景×用途）：
 * - guide.ts 据此把段目录渲染进 profile 提示词（接线零漂移）；
 * - test/unit/kg-templates.test.ts 据此做目录↔文件存在性断言；
 * - TEMPLATE-USAGE.md（人类面目录文档）与此保持同步。
 *
 * 纯数据模块、零 IO（TR-AD-1）。
 */

/** 段库场景（三场景 = 三类被装配文档）。 */
export type SegmentScenario = "brief" | "report" | "kg-change-report";

/** 场景清单（目录渲染与存在性断言的遍历序）。 */
export const SEGMENT_SCENARIOS: readonly SegmentScenario[] = [
  "brief",
  "report",
  "kg-change-report",
];

/** 单段元数据：一个可引用的 md 片段（templates/<scenario>/<file>）。 */
export interface SegmentMeta {
  readonly scenario: SegmentScenario;
  /** 段文件名（templates/<scenario>/ 下）。 */
  readonly file: string;
  /** 标准段标题（ATX 二级标题行；硬约束机械判据的标题来源，见 validate.ts）。 */
  readonly title: string;
  /** 用途一句话（目录展示 + LLM 选段判断依据）。 */
  readonly purpose: string;
}

/** 段库全目录（16 段：brief 8 / report 4 / kg-change-report 4；T2.2 brief +批次两段）。 */
export const SEGMENT_CATALOG: readonly SegmentMeta[] = [
  // ── brief 场景（F1.3：派发时 MainAgent 组任务 brief）──
  {
    scenario: "brief",
    file: "task-goal.md",
    title: "任务目标",
    purpose: "声明任务要交付什么——可验收的目标句式（硬约束①三要素之一，不可省）",
  },
  {
    scenario: "brief",
    file: "background.md",
    title: "背景",
    purpose: "任务上下文与现状事实（为什么做/已知约束）；无实义内容时整段省略",
  },
  {
    scenario: "brief",
    file: "kg-constraint-slice.md",
    title: "kg 约束切片",
    purpose: "图谱约束注入区：digest+scene+指针切片 + supersede 协议行（附着渲染同格式，R23 索引面必带 scene）",
  },
  {
    scenario: "brief",
    file: "scope-clamp.md",
    title: "范围钳制",
    purpose: "明确不做什么的边界清单，防段外动作（F-23 教训；硬约束①三要素之二，不可省）",
  },
  {
    scenario: "brief",
    file: "test-requirements.md",
    title: "测试要求",
    purpose: "TDD 先写失败测试：测试点清单/层级/运行方式/红绿判定",
  },
  {
    scenario: "brief",
    file: "completion-criteria.md",
    title: "完成标准",
    purpose: "验收条件+交付物+闭环要求——完成判定要素的载体段（硬约束①三要素之三，不可省）",
  },
  {
    scenario: "brief",
    file: "batch-brief-template.md",
    title: "批次 brief 模板",
    purpose: "任务编排批次 brief 的固定段骨架：范围/锚定上层上下文/产出要求/验收（T2.2，AD-3③；skill 可按类型细化不可裁骨架）",
  },
  {
    scenario: "brief",
    file: "plan-hard-constraint.md",
    title: "plan 硬约束",
    purpose: "强制 plan 任务的模板层硬约束（先写 plan 再动手+阶段转换必更新+closure 全 resolve；T2.2 派发面机械追加，LLM 不可裁）",
  },
  // ── report 场景（F3.1：收口时 SubAgent 组任务完成报告）──
  {
    scenario: "report",
    file: "summary.md",
    title: "summary",
    purpose: "一句话结论+关键证据（硬约束②必含；summary 足够决策要不要深入）",
  },
  {
    scenario: "report",
    file: "deviation.md",
    title: "deviation",
    purpose: "与设计/架构的偏差及理由；无偏差时整段省略（显式「无」可选）",
  },
  {
    scenario: "report",
    file: "findings.md",
    title: "findings",
    purpose: "新知识候选+supersede 声明+理由——kg 落账输入；无发现必须显式写「无」（硬约束②必含）",
  },
  {
    scenario: "report",
    file: "tests.md",
    title: "tests 执行记录",
    purpose: "真实执行的测试命令与结果（红→绿证据链）",
  },
  // ── kg-change-report 场景（F3.3：验证期变化报告四类条目）──
  {
    scenario: "kg-change-report",
    file: "stale-anchor.md",
    title: "失效锚点",
    purpose: "机械确定性检出的锚失效条目（符号消亡→物化锚孤儿），陈述句",
  },
  {
    scenario: "kg-change-report",
    file: "rule-conflict.md",
    title: "规则冲突",
    purpose: "机械确定性检出的逻辑冲突条目（如双向 governs 矛盾），陈述句",
  },
  {
    scenario: "kg-change-report",
    file: "suspect-stale.md",
    title: "疑似过时",
    purpose: "活跃度错位启发排序条目——必须标「疑似」非结论（启发式不可下结论）",
  },
  {
    scenario: "kg-change-report",
    file: "knowledge-change.md",
    title: "知识变化",
    purpose: "本迭代「代码改动→知识变化」因果叙述段（事件导向/因果链完整/带行动项）",
  },
];

/** 三条硬约束（LLM 不可裁，AD-18 分界：LLM 判选段，不判守不守约束）。 */
export interface HardConstraint {
  readonly id: string;
  /** 约束全文（提示词携带与 TEMPLATE-USAGE 声明共用此文本，零漂移）。 */
  readonly text: string;
}

export const TEMPLATE_HARD_CONSTRAINTS: readonly HardConstraint[] = [
  {
    id: "brief-three-elements",
    text: "brief 必含「任务目标+范围钳制+完成判定」三要素（完成判定由「完成标准」段承载），缺一任务不成立",
  },
  {
    id: "report-summary-findings",
    text: "report 必含 summary+findings；findings 无发现时必须显式写「无」，不得缺失、留空或用「（无内容）」类占位",
  },
  {
    id: "no-empty-section",
    text: "空段省略不占位——无实义内容的段整段省略，不得输出「（无内容）/待补充」类占位行",
  },
];

/**
 * plan 硬约束段全文（AD-6⑥，T2.2）：强制 plan 的任务类型（manifest
 * plan=enforced）批次 brief 的模板层硬约束——任务编排派发面在 spawn 时
 * **机械追加**（LLM 装配的 brief 无论是否包含，系统都追加本段；模板层
 * 硬约束 LLM 不可裁）。文本与段文件 brief/plan-hard-constraint.md 同源
 * （存在性测试断言文件含本段正文——双源零漂移）。
 */
export const PLAN_HARD_CONSTRAINT_SEGMENT = [
  "## plan 硬约束（任务系统追加，模板层强制——不可裁）",
  "",
  "本批次为强制 plan（工作台账）任务，必须遵守：",
  "1. 开工先建工作台账（一次给出全部计划条目）再动手执行；",
  "2. 阶段转换必须同步更新台账项状态（in_progress/done/abandoned）；",
  "3. 收口时台账须全部 resolve——每项 done，或 abandoned 且带非空理由 note；",
  "4. 台账 note 记录关键事实与产物指针（文件路径/知识节点 id），供接力恢复与幂等重跑使用。",
  "5. 按计划条目逐步提交（commit）——每条目完成且验证绿即提交一次；收尾前先提交，未提交的工作等于没做。",
].join("\n");
