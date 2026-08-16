import type { AgentProfile } from "../AgentProfile";
import { SteerHooks } from "../hooks/SteerHooks";
import { MinimalHooks } from "../hooks/MinimalHooks";

/**
 * SubAgent worker profile（architecture.md §4.4「实例化」，T2.2）。
 *
 * 纯声明式配置（无行为方法，AD-3 同构）：单轮收敛（single-shot）+ steer
 * 转投接线 + 全工具集（照抄 MainSessionProfile 工具名清单，不新增）。
 * 「单轮收敛」由 ChildMain 消费——驱动一次 run、解析 closure、exit；
 * runtime 侧不感知（AG-10 零 kind 分支）。
 *
 * model 缺省继承（AD-6）：undefined → 继承 config 解析出的完整 Model 对象
 * （F-14 透传）；需要廉价模型时在此声明 "provider/model-id"（装配期经
 * registry 解析，失败 fail-fast 含 id）。
 */
export const SUBAGENT_SYSTEM_PROMPT =
  "你是 helix 的 SubAgent worker，负责独立完成一个被指派的任务。\n" +
  "工作方式：\n" +
  "- 聚焦当前任务，自主使用提供的工具（bash/read/write/edit/grep）完成调研与实现，不要求交互确认；\n" +
  "- 运行中可能收到经注入到达的补充指示（优先级高于更早的指示），据此调整执行；\n" +
  "- 保持收敛：完成或确认无法完成后立即收口，不做任务范围之外的事。\n" +
  "收口协议（必须遵守）：任务结束时的最后一条回复必须以 closure 块结尾，格式：\n" +
  "<<<CLOSURE\n" +
  '{"status":"done|failed","summary":"一句话结论","reportPath":null,"findings":[],"taskId":null}\n' +
  "CLOSURE>>>\n" +
  "其中 status=done 表示已完成、failed 表示无法完成；summary 为给主线的一句话结论；" +
  "reportPath 为报告文件路径（无则 null）；findings 为结构化发现数组（无则 []）；" +
  "taskId 为关联任务号（无则 null）。";

export const SubAgentProfile: AgentProfile = {
  kind: "subagent-worker",
  systemPrompt: SUBAGENT_SYSTEM_PROMPT,
  tools: ["bash", "read", "write", "edit", "grep"], // 与 MainSessionProfile 同清单（装配经 CoreToolExecutor.resolveTools）
  lifecycle: { mode: "single-shot" },
  hooks: [new SteerHooks(), new MinimalHooks()],
  model: undefined, // AD-6：缺省继承（config 解析对象透传，F-14）
};
