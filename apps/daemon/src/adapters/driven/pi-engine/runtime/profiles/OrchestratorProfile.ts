import type { AgentProfile } from "../AgentProfile";
import { SteerHooks } from "../hooks/SteerHooks";
import { MinimalHooks } from "../hooks/MinimalHooks";
import { BRIEF_ASSEMBLY_GUIDE } from "../templates/guide";

/**
 * OrchestratorProfile —— 任务编排主 agent profile（architecture.md §5.1，
 * AD-3③，T2.2）。daemon 内部 agent：无 WS 会话、无人类交互面，每运行中
 * 任务一个（TaskOrchestratorService 装配驱动）。
 *
 * 纯声明式配置（无行为方法，AD-15）：单轮收敛形态由编排服务驱动语义决定
 * （起跑一次驱动 + 收口注入续驱动——收口结论以消息注入驱动下一轮，与
 * 主会话消费 closure 同构）；hooks 为构造器引用（每 runtime 实例化，T1）。
 *
 * 工具集（§5.1 表）：
 * - 派批次 SubAgent（编排工具族既有面，经 AgentOrchestrationPort 回调度器
 *   ——与 chat 共享全局预算 maxConcurrent，批次实例才占预算，编排 loop 本身
 *   不经调度器 spawn）；
 * - 读批次实例工作台账（编排者变体——按实例 id 读批次台账，机械判据
 *   （closure 全 resolve 硬约束）在编排服务代码面，不依赖 LLM 判读）；
 * - 知识图谱只读查询（层间上下文：上层产出 digest 供下层批次锚定）；
 * - 只读基础工具（规模预估/批次划分输入：exportSymbols 投影经只读面，F-5）；
 * - 任务引擎回口（划批次落行/派发落章/阶段推进/阶段产物聚合/任务收口
 *   ——TaskEnginePort inbound 内部 port，非 WS）。
 *
 * **不持知识图谱写工具**（AD-10 边界：产出落库是批次 SubAgent 的职责，
 * 编排器只编排）——机械断言在 profile 契约测试。
 *
 * D6（code-review 任务设计）：tools +write（不加 edit）——编排器不改
 * 项目代码，write 仅用于任务报告目录内的产物落盘（任务级汇总报告
 * 固定落点 <home>/reports/task:<jobId>/summary.md，目录路径由 kickoff
 * 起跑信息携带，orchestrator 不需自己猜）。
 *
 * 系统提示 = base + 段库装配指引（三段组装：SystemPromptAssembler，
 * 与 MainAgent 消费 skill 同构——F-8）。
 */

/**
 * 编排 base prompt（瘦身契约：零工具名枚举——清单唯一来源 = 组装产物；
 * 只留角色 + 批次循环协议 + 判读分工 + 派发顺序 + 暂停语义）。
 */
const ORCHESTRATOR_BASE_PROMPT =
  "你是 helix 的任务编排主 agent：按任务 skill 的 SOP 驱动「划批次 → 派批次 SubAgent → 读收口判定 → 推进或重试 → 阶段产物聚合 → 任务收口」的多 agent 编排循环，全程无人工交互、无中途人审门。\n" +
  "工作方式：\n" +
  "- 起跑信息含任务参数、冻结的阶段行、恢复现场与任务 skill 全文——先按 skill 的 SOP 执行，阶段行已冻结，不重议、不增删；\n" +
  "- 划批次与推进选择是你的判断（skill 批次划分原则 × 项目实况）；批次成败判定不由你做——系统按「收口结论 + 台账全 resolve」双硬约束机械判读，结果会以「批次收口」消息自动注入驱动你的下一轮；\n" +
  "- 每派一个批次的固定顺序：先在本阶段插入批次行（落库成功拿到批次号）→ 再派 SubAgent（brief 按段库与 skill 的批次模板装配）→ 随后把批次号与实例 id 落派发章——顺序不可颠倒（行先于派发是审计链前提）；\n" +
  "- 收到「批次收口」注入后：阶段批次全成功则聚合阶段产物并推进（摘要给人类读：本层建了什么、覆盖哪些域/模块、有什么已知缺口），有失败批次时系统已按重试上限自动重派（接力 brief 含前序台账摘要），等待即可；\n" +
  "- 全部阶段完成后申报任务完成——系统会机械复核全部阶段行后收口，未完成会被拒绝并回执原因；\n" +
  "- 任务暂停期间派发与推进会被拒绝——不要重试，等待恢复注入后从现场摘要续跑；\n" +
  "- 你的会话可丢弃：权威状态只有 skill、任务四表行与实例台账，任何时刻可从行状态重建现场；不要在会话内自建平行账本。\n" +
  "批次 brief 装配（必须遵守）：按段库与任务 skill 的批次 brief 模板段装配；强制台账的任务类型，台账硬约束段由系统在派发时机械追加——你不必重复、不可移除。\n" +
  "派发提示（W3-G）：任务涉及知识管辖的代码面时，在 brief 中提示执行者走开工链路" +
  "（codegraph 落地符号 → kg affected 锚反查 → kg get 读全文）。\n" +
  "产物落盘纪律（D6）：write 仅用于任务报告目录内的任务产物落盘（任务级汇总报告等，目录路径见起跑信息）——项目代码零写，不持 edit 编辑面。";

/** base + 段库装配指引（AD-18：提示词携带段库+硬约束+装配示例引用）。 */
export const ORCHESTRATOR_SYSTEM_PROMPT = ORCHESTRATOR_BASE_PROMPT + "\n\n" + BRIEF_ASSEMBLY_GUIDE;

export const OrchestratorProfile: AgentProfile = {
  kind: "orchestrator",
  systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
  tools: [
    // 只读基础工具（规模预估/批次划分输入；不改项目代码，write 仅用于
    // 任务报告目录内的产物落盘——D6：任务级汇总报告固定落点）
    "bash",
    "read",
    "grep",
    "write",
    // 派批次 SubAgent（编排工具族既有面；批次实例占预算，编排 loop 不占）
    "agent_spawn",
    // 读批次实例工作台账（编排者变体：按实例 id 参数读，非本实例）
    "plan_read",
    // 知识图谱只读查询（层间上下文锚定；AD-10：不持写面——无即时落账工具）
    "kg",
    // 任务引擎回口（TaskEnginePort inbound，内部 port 非 WS；批次成败收口
    // 的两个引擎方法不在 LLM 面——硬约束判定归编排服务代码机械执行）
    "task_insert_batch",
    "task_dispatch_batch",
    "task_advance_stage",
    "task_stage_artifact",
    "task_complete_job",
    "task_fail_job",
  ],
  lifecycle: { mode: "persistent" },
  hooks: [SteerHooks, MinimalHooks], // 构造器引用（T1：装配点每 runtime 实例化）
  // model：不声明槽位——组合根解析（编排任务模型面归资源管理后续迭代）
};
