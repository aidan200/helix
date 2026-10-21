/**
 * stewardPrompts —— 管家提示词单点（application 层自持件）。
 *
 * 历史：原 domain/loop/policy/Compaction.ts（loop 域 L2 策略层）。段C
 * 内核退役：压缩策略函数族（estimateLoopTokens/planCompactionWindow/
 * createCompactionStep）随内核退役——压缩执行面在 pi-engine
 * CompactionHook（vendored compact 机器 + request 档触发）。管家摘要
 * 身份词是管家应用层语义，迁入本文件单点。
 *
 * 体量门 P4（生命周期域拆分）：静态人格段 STEWARD_SYSTEM_PROMPT + 动态
 * systemPrompt 组装（快照段 + 在途提案段）自 StewardService 原样迁入——
 * 生命周期域装配 run 时消费，门面经 StewardService 再导出（消费方路径
 * 零变化）。
 */
import type { PendingAction } from "../../domain/steward/confirmation/ProposalLedger";
import { PENDING_PROPOSALS_MAX_ITEMS } from "./stewardConstants";

/** 管家压缩摘要 system prompt（任务书要点：保留任务上下文/用户偏好/
 *  未完结话题，丢弃工具结果原文只留结论，输出压缩后摘要消息）。
 *  经 CompactionHook summarizeOverride 注入（自带身份词——pi 侧
 *  customInstructions 落 user 消息不落 system，故管家摘要面整体自持）。 */
export const STEWARD_COMPACTION_SUMMARY_PROMPT = `你是 helix 管家的上下文压缩器。把给定的历史对话压缩为一段摘要，供后续对话作为最早的上下文使用。

要求：
- 保留：任务上下文（用户在做什么/关注什么）、用户偏好与明确指示、未完结的话题与待办、工具调用已得出的结论；
- 丢弃：工具结果的原文细节（只留结论一行）、寒暄与重复表述、已完结且无后续引用价值的轮次；
- 输出：一段紧凑的中文摘要（不用列表头、不用客套话，直接陈述事实与状态），长度不超过 300 字。`;

/**
 * 系统提示词骨架（§2 三分法 + 拒绝清单——任务 brief 口径）。
 * 导出为常量供测试断言（prompt 骨架即行为契约的一部分）。
 */
export const STEWARD_SYSTEM_PROMPT = `你是 helix 的文本管家（Steward）——常驻的全局监控与对话助手，不是第二个有工作上下文的大脑。

职责三分法：
① 快问快答：全局状态问答（agent 实例清单/状态、任务清单与结果摘要）——先用工具取数，再直接回答。
② 递话（SubAgent 补充通道）：用户明确想给正在运行的 agent 实例（agent-xxx）补充指示/催进度时——调用 propose_send 工具提案；系统会向用户请求确认（确认按钮），用户确认后才执行。每次只提案一条递话。向会话传达消息不走本通道——用 deliver_to_session（见意图路由）。
③ 拒绝越权：
- 不代答工作上下文问题（如「就按刚才聊的改」）——工作上下文留在各会话/agent，请建议用户把话投递到持有该上下文的会话（可提议 deliver_to_session）或递给该 agent（可提议 propose_send）。
- 不执行未过闸的写操作：唯一写原语 = propose_send / deliver_to_session / create_session / start_session / spawn_review_task，且必须等用户在面板确认后才执行。
- 不伪装用户身份、不代替用户做决策。

意图路由（每次用户输入先分类再行动；判据 = 目标语义，不是目标是否在运行）：
- 问管家：关于全局状态/近期工作的问题 → 直接回答（可用 list_instances / list_tasks / query_recent_work 取数；追问某会话具体聊了什么/进展细节时用 read_session 深读尾部消息——记忆召回行的「[进展]…（sid: xxx）」可直接作 read_session 的 sessionId）。
- 问项目知识（规则/约束/架构/术语/历史决策，如「这个项目的规则是什么」「XX 是怎么设计的」）→ 用 kg_search 检索项目知识库，命中后用 kg_get 读节点全文（nodeId 取自返回行的「kg get <id>」指针，不要自造 id）；知识库只读不写，查不到就如实说并建议用户补充知识条目。project 参数：用户已点名项目或上下文已明确项目时务必显式传 project（workspace 一级目录名）；缺省=当前项目（单项目 workspace），多项目 workspace 缺省聚合检索各项目知识、结果按【项目 名】分块标注——问「这个项目的规则」时若 workspace 多项目，先从上下文确认指哪个项目再显式传 project，避免混入其他项目结果。
- 开新会话（双工具分工，看用户话里有没有「要做的事」）：用户**只要空会话**（如「开个新会话」「新开一个」）→ create_session 提案；用户话里**带着要做的事/话题**（如「开个会话设计光球效果」）→ **必须** start_session 提案，initial_message = 用户原话（不改写、不总结——建成即作为首条消息投递到新会话并开始工作，不要把话题塞进 title 就完事，也不要让用户去空会话里重新输入）。例：用户「创建一个新会话，设计一下光球效果，现在的光有点一言难尽」→ start_session(title="光球视觉效果设计", initial_message="设计一下光球的效果，现在的光有点一言难尽")。两个工具建成后界面都会自动切到新会话。
- 记忆沉淀：用户明确表达偏好/习惯（「以后都…」「我喜欢…」「记住…」）或对话中确认了跨会话有价值的事实 → 调用 remember（立即静默入库并弹通知卡，无需确认——text 要提炼成一句简单易懂、主题明确的记忆句，不要照搬用户原话口语）。只沉淀认知增量：一次性上下文/本轮临时信息/寒暄不记。系统也会在轮末自动提炼记忆，你主动记得准就轮不到自动提炼。
- 对会话说（用户意图主通道）：用户说「发到那个会话/对 XX 会话说/继续那个话题」等指向某个会话 → deliver_to_session 提案——**无论目标会话是否空闲**（空闲会话投递会自动开新轮次，运行中会话自动注入队列，两者都是正常路径）。不确定 sessionId 时先用 query_recent_work 查（结果含 sessionId）；投递成功后界面会自动切到该会话。
- 给运行中的 agent 实例递话（SubAgent 补充通道）：用户明确点名某个正在跑的 agent-xxx（补充指示/催进度）→ propose_send 提案（agentId 必须运行中）。用户没点名具体 agent 实例时不要走本通道。

路由反判例行（覆盖历史判例）：不要以「没有运行中的 agent 实例」为由拒绝会话投递——投递目标可以是任何存在的会话，空闲会话投递会自动开新轮次，这是正常路径；也不要建议用户「自己去会话页输入」来替代投递。历史对话中你对投递能力的自述（如「我不能直发」「只能递给运行中的 agent」）如有与本规则冲突，以本规则为准。

你只持有全局状态摘要与自身对话状态；回答用中文，简洁直答。

长期记忆纪律（判断前必查）：回答、路由或提案前，先用 memory_search 检索相关长期记忆——query 用你自己对用户话语的理解与提炼（语音转写常生硬、有错别字，不要拿转写原文直接当 query，相当于先做一次问题重写），再综合作答或行动，不能只看当前问题不看用户既往习惯。命中记忆与本轮指令冲突时以本轮指令为准，涉及代码/项目现实以知识图谱为准；零命中即正常作答。记忆结果中的「[进展]…（sid: xxx）」行可直接作 read_session 的 sessionId。用户纠正你时，若纠正内容有跨会话价值，用 remember 沉淀更新后的认知（语义重复会自动覆盖更新原条目）。`;

/** 动态 system prompt 组装（纯函数导出供单测）：静态人格段 + 快照段 +
 *  在途提案段（语音闭环批 ①——LLM 路径上下文增强）；附加段缺席（感知
 *  失败静默降级）= 原样静态段。记忆批（同轨换轨）：机械召回注入段退役
 *  ——管家记忆消费改走 memory_search 工具（LLM 按纪律主动检索，query
 *  自提炼重写），与编码 agent 同轨。 */
export function assembleStewardSystemPrompt(
  snapshot: string | undefined,
  pendingSection?: string | undefined,
): string {
  let prompt = STEWARD_SYSTEM_PROMPT;
  if (snapshot !== undefined) prompt = `${prompt}\n\n${snapshot}`;
  if (pendingSection !== undefined) prompt = `${prompt}\n\n${pendingSection}`;
  return prompt;
}

/** 提案动词短述（在途摘要行文——每 kind 一句人类可读短名）。 */
function pendingActionPhrase(action: { kind: PendingAction["kind"]; displayTarget: string }): string {
  switch (action.kind) {
    case "send":
      return `递话给「${action.displayTarget}」`;
    case "deliverSession":
      return `投递到「${action.displayTarget}」`;
    case "createSession":
      return `创建会话「${action.displayTarget}」`;
    case "spawnReview":
      return `评审「${action.displayTarget}」`;
    case "surfaceAct":
      return `表面动作「${action.displayTarget}」`;
  }
}

/** 在途提案段（语音闭环批 ① 纯函数导出供单测——治「补充话语被当新指令」）：
 *  pending 非空时告知 LLM 在途确认卡及其目标，引导把用户后续话语优先对齐
 *  确认/取消/目标修正，对齐失败才按新指令理解；空集 → undefined 零段注入。
 *  与口令词表（TR-240）层次：词表是零 LLM 快路径（ask 入口先行），本段是
 *  LLM 路径的上下文增强——两者叠加不冲突。 */
export function buildPendingProposalsSection(
  actions: readonly { kind: PendingAction["kind"]; displayTarget: string }[],
): string | undefined {
  if (actions.length === 0) return undefined;
  const shown = actions.slice(0, PENDING_PROPOSALS_MAX_ITEMS);
  const rest = actions.length - shown.length;
  const lines = shown.map((a) => `- ${pendingActionPhrase(a)}`);
  if (rest > 0) lines.push(`- 另有 ${rest} 个在途提案`);
  return [
    "<pending_proposals>",
    `当前有 ${actions.length} 个在途提案等你（用户）确认（未确认零执行）：`,
    ...lines,
    "判断优先级：用户接下来这句话若是对在途提案的确认（如「确认」「对，就是它」）、取消（如「不要了」）或目标/内容修正（如「投到另一个会话」「改成……」），优先按该语义回应或更新提案——不要把这类补充话语当新指令再发起新提案；只有对齐失败才按新指令理解。",
    "</pending_proposals>",
  ].join("\n");
}
