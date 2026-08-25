import type { AgentProfile } from "../AgentProfile";
import { SteerHooks } from "../hooks/SteerHooks";
import { MinimalHooks } from "../hooks/MinimalHooks";
import { REPORT_ASSEMBLY_GUIDE } from "../templates/guide";

/**
 * SubAgent worker profile（architecture.md §4.4「实例化」）。
 *
 * 纯声明式配置（无行为方法，AD-3 同构）：单轮收敛（single-shot）+ steer
 * 转投接线 + 全工具集（照抄主会话工具名清单，不新增）。
 * 「单轮收敛」由 ChildMain 消费——驱动一次 run、解析 closure、exit；
 * runtime 侧不感知（AG-10 零 kind 分支）。
 *
 * **hooks 为构造器引用而非实例（T1）**：与主会话同坑同填——SteerHooks.bind
 * 绑定 agent 引用，共享实例即跨 runtime 覆盖泄漏；类引用保持纯声明，
 * 实例化在 AgentRuntime 装配点（每 runtime 新建）。
 *
 * model 槽位（AD-3 三级链第一级，TR-AD-24）：声明即最高优先级
 * （SubagentLauncher.resolveModelFor 解析单点，装配期 resolveModel 解析，
 * 失败 fail-fast 含 id）；未声明（undefined）→ 走第二级 spawn 会话快照 →
 * 第三级全局兜底。声明入口为代码层真实槽位；UI 管理归 skills 页下迭代。
 */
/**
 * SubAgent base prompt（瘦身消双源）：只留角色+行为引导，**不列工具
 * 名**——可用工具清单唯一来源 = SystemPromptAssembler 组装产物（spawn 时刻
 * 定格经 env 透传子进程）。「自主使用提供的工具」措辞保留（不列具体名）。
 *
 * T4.2（AD-18）：导出常量 = base + report 装配指引段（段库目录+三条硬约束
 * +装配示例引用，templates/guide 同源）——收口时 SubAgent 按段库组任务
 * 完成报告（report 装配端）。
 */
const SUBAGENT_BASE_PROMPT =
  "你是 helix 的 SubAgent worker，负责独立完成一个被指派的任务。\n" +
  "工作方式：\n" +
  "- 聚焦当前任务，自主使用提供的工具完成调研与实现，不要求交互确认；\n" +
  "- 运行中可能收到经注入到达的补充指示（优先级高于更早的指示），据此调整执行；\n" +
  "- 保持收敛：完成或确认无法完成后立即收口，不做任务范围之外的事。\n" +
  "收口协议（必须遵守）：任务结束时的最后一条回复必须以 closure 块结尾，格式：\n" +
  "<<<CLOSURE\n" +
  '{"status":"done|failed","summary":"一句话结论","reportPath":null,"findings":[],"taskId":null}\n' +
  "CLOSURE>>>\n" +
  "其中 status=done 表示已完成、failed 表示无法完成；summary 为给主线的一句话结论；" +
  "reportPath 为报告文件路径（无则 null）；findings 为结构化发现数组（无则 []）；" +
  "taskId 为关联任务号（无则 null）。";

/** base + report 装配指引（AD-18：提示词携带段库+硬约束+装配示例引用）。 */
export const SUBAGENT_SYSTEM_PROMPT = SUBAGENT_BASE_PROMPT + "\n\n" + REPORT_ASSEMBLY_GUIDE;

export const SubAgentProfile: AgentProfile = {
  kind: "subagent-worker",
  systemPrompt: SUBAGENT_SYSTEM_PROMPT,
  tools: ["bash", "read", "write", "edit", "grep", "web_search", "web_fetch", "browser"], // H-3：+browser（经 wire 转发通道接 daemon CDP 单例；装配经 CoreToolExecutor.resolveTools）
  lifecycle: { mode: "single-shot" },
  hooks: [SteerHooks, MinimalHooks], // 构造器引用（T1：与主会话同坑同填——装配点实例化）
  // AD-3：真实声明槽位——声明即最高优先级；生产默认不设值（走会话快照/全局兜底；UI 管理归 skills 页下迭代）
  model: undefined,
};
