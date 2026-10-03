/**
 * stewardPrompts —— 管家提示词单点（application 层自持件）。
 *
 * 历史：原 domain/loop/policy/Compaction.ts（loop 域 L2 策略层）。段C
 * 内核退役：压缩策略函数族（estimateLoopTokens/planCompactionWindow/
 * createCompactionStep）随内核退役——压缩执行面在 pi-engine
 * CompactionHook（vendored compact 机器 + request 档触发）。管家摘要
 * 身份词是管家应用层语义，迁入本文件单点。
 */

/** 管家压缩摘要 system prompt（任务书要点：保留任务上下文/用户偏好/
 *  未完结话题，丢弃工具结果原文只留结论，输出压缩后摘要消息）。
 *  经 CompactionHook summarizeOverride 注入（自带身份词——pi 侧
 *  customInstructions 落 user 消息不落 system，故管家摘要面整体自持）。 */
export const STEWARD_COMPACTION_SUMMARY_PROMPT = `你是 helix 管家的上下文压缩器。把给定的历史对话压缩为一段摘要，供后续对话作为最早的上下文使用。

要求：
- 保留：任务上下文（用户在做什么/关注什么）、用户偏好与明确指示、未完结的话题与待办、工具调用已得出的结论；
- 丢弃：工具结果的原文细节（只留结论一行）、寒暄与重复表述、已完结且无后续引用价值的轮次；
- 输出：一段紧凑的中文摘要（不用列表头、不用客套话，直接陈述事实与状态），长度不超过 300 字。`;
