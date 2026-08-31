import type { AgentProfile } from "../AgentProfile";
import { DEFAULT_COMPACTION } from "../AgentProfile";
import { SteerHooks } from "../hooks/SteerHooks";
import { MinimalHooks } from "../hooks/MinimalHooks";
import { BRIEF_ASSEMBLY_GUIDE } from "../templates/guide";

/**
 * 主会话 profile（architecture.md §4.4「实例化」）。
 *
 * 纯声明式配置（无行为方法）：常驻多轮 + steer/abort 语义 + 最小钩子。
 * 「常驻」由生命周期策略声明，CLI/WS 驱动入口经 ChatService 反复
 * sendMessage 即多轮复用——runtime 侧不做任何轮次计数。
 *
 * **hooks 为构造器引用而非实例（T1）**：SteerHooks.bind 会把 agent 绑进
 * 钩子实例，模块级共享实例会让后建 runtime 覆盖先建 runtime 的
 * steer/abort 通道（跨会话串台，P0）——故此处只声明类引用（纯数据），
 * 实例化在 AgentRuntime 装配点（每 runtime 新建）。快照读面用类的
 * hookName（与实例 .name 等值）。
 *
 * 工具集：十八工具按名声明（编排六工具 + 静态联网两工具 +
 * 动态族单 browser 工具），装配在组合根
 * （CoreToolExecutor → resolveTools；bash/read/write/edit 为 pi 内置、grep 自写、
 * agent_spawn/agent_send/agent_status/agent_inspect/agent_park/agent_resume
 * 经 AgentOrchestrationPort 回调度器，
 * browser 经 BrowserPort 薄转投（零 CDP 知识），同一沙箱 cwd 与端口注入）。
 *
 * compaction：默认参数保留（实测值）；摘要执行受 provider
 * 约束（非流式 complete），daemon 侧容忍失败不崩会话，
 * 实际生效经集成验收。
 */
/**
 * 主会话 base prompt（瘦身消双源）：只留角色+行为引导，**不枚举工具清单**
 * ——可用工具清单唯一来源 = SystemPromptAssembler 组装产物（工具段从
 * resolveTools 产物同源派生（消除手写清单与 tools 数组的双源漂移
 * 事实 8）。「并行委派」段保留行为策略措辞（T3-C 正向契约：结束回合 +
 * closure/进展报告自动注入 + 不轮询不抢跑 + 零增量 agent_inspect 核实），
 * 契约句引用的编排工具名是行为指引而非清单枚举；组装器不做
 * 任何状态联动（编排关不删委派段——用户裁决，错配=使用不当）。
 *
 * W3-G（kg-driven-dev-loop 设计 R11/R23）：「知识纪律」块 = SOP 软层纪律
 * 本体（第一铁律/开工链路/改后纪律/MainAgent 专属纪律）——纪律句引用的
 * codegraph/kg/kg-update 工具名与委派契约句同性质：行为指引非清单枚举
 * （profile-slim 词边界检查对这三名单项放行）。三条硬约束与
 * PLAN_HARD_CONSTRAINT_SEGMENT 不动（R12：本批全是软层，不装新门禁）。
 */
const MAIN_SESSION_BASE_PROMPT =
  "你是 helix 的主会话助手。可使用提供的工具完成文件与命令类任务；" +
  "回答简洁、准确；用户消息中的修正与补充" +
  "（可能经 steer 注入到达）优先于更早的指示。\n" +
  "知识纪律（遵循知识库 + 完善知识库）：\n" +
  "第一铁律：开工前扫一遍技能清单与本任务注入/附着的 kg 节点索引（含 scene 适用场景）——" +
  "只要与本任务有 1% 相关，就必须使用对应技能、用 kg get 读取节点全文；宁可多读，不可漏读。\n" +
  "开工链路（改代码前）：①用 codegraph（search/node/callers）把任务意图落地成具体文件/符号；" +
  "②用 kg affected 锚反查这些文件/符号的管辖节点；③对 scene 相关的节点 kg get 读全文；" +
  "拿不准影响面的先 codegraph impact 查影响面。\n" +
  "改后纪律：编辑后出现的 📎 知识块必须读；本次改动推翻块中节点描述的现实时，随本次改动提交 " +
  "kg-update supersede（不许「下次再说」）；沉淀新规则用 kg-update createNode——scene 必填" +
  "（「本规则适用于：改动 X 类文件 / 做 Y 类决策前」）。\n" +
  "候选台账：你是台账唯一写者——人审清台时用 kg-update decideCandidate 裁决" +
  "（applied/discarded/deferred + reason）；清台前必看体检（/project 页 kg.health 看板五项）；" +
  "任务完成出现 kg sync 提示时，向用户确认后再触发 sync（机械只提醒，动手权在用户）。\n" +
  "工程纪律：①并行开发一律隔离 worktree——并行派发多个开发 SubAgent 时要求各自在隔离 " +
  "worktree 的分支上干活与提交（禁止共享同一工作树并行写；图谱产出型任务（kg-bootstrap/kg-review）" +
  "不开 worktree，主工作树执行）；各分支的合入由你在计划阶段检查点统一执行（merge 冲突由你裁决解决），" +
  "SubAgent 不自行合入；同一检查点落账 SubAgent 经 findings 申报的 kg 变更（supersede/createNode 走 " +
  "kg-update——知识与代码同一检查点合入）；②计划阶段检查 commit——推进/验收计划阶段时核查工作树提交情况，" +
  "有未提交工作即要求先提交再推进。\n" +
  "并行委派：独立可并行的任务可指派 SubAgent 实例执行" +
  "（agent_spawn 立即返回，不等完成）。指派后向用户简述计划并结束回合——" +
  "实例收口结论（\"agent-N closure: …\"）与周期进展报告会自动注入、驱动下一轮；" +
  "不要轮询 agent_status 等待结果，也不要在实例执行期间自行重做该任务。" +
  "长任务 spawn 时设 reportIntervalMs（预估执行超过 10 分钟再设，建议 600000 起步，由你自估）；" +
  "收到连续零增量的进展报告时用 agent_inspect 核实真实执行轨迹，确无进展可终止（kill）后重派。" +
  "agent_status 仅在用户主动询问进度时使用；运行中可用 agent_send 追加指示；" +
  "不再需要的实例可提醒用户终止。" +
  "用户要求暂停某实例时用 agent_park（完成当前工具调用后暂停，上下文保留零消耗）；" +
  "用户要求继续时先 agent_status 查看 parked 实例再 agent_resume 恢复" +
  "（closure 会照常注入驱动下一轮）。";

/**
 * T4.2（AD-18）：导出常量 = base + brief 装配指引段（段库目录+三条硬约束
 * +装配示例引用，templates/guide 同源）——派发时 MainAgent 按段库组任务
 * brief（brief 装配端；kg 约束切片注入区见段库）。
 */
export const MAIN_SESSION_SYSTEM_PROMPT = MAIN_SESSION_BASE_PROMPT + "\n\n" + BRIEF_ASSEMBLY_GUIDE;

export const MainSessionProfile: AgentProfile = {
  kind: "main-session",
  systemPrompt: MAIN_SESSION_SYSTEM_PROMPT,
  tools: [
    "bash",
    "read",
    "write",
    "edit",
    "grep",
    "web_search",
    "web_fetch",
    "agent_spawn",
    "agent_send",
    "agent_status",
    "agent_inspect", // T3-B：死循环核实（编排四工具）
    // ⑤ 链 C 挂起/恢复（P1 裁决：专用工具仅 Main——挂起是调度器级机械
    // 动作不靠 LLM 措辞；SubAgent/Orchestrator/kg-writer 均不声明）
    "agent_park",
    "agent_resume",
    // 动态族（单 browser 工具 + action 参数；条件注册——CoreToolExecutor options.browser）
    "browser",
    // kg 双工具（T3.3，CL-4/CL-3）：只读查询面 + 即时落账面
    //（AD-14 协议行兑现在 edit 现场——findings 收口通道之外的第二通道）
    "kg",
    "kg-update",
    // codegraph（W1-B，R5/R7）：代码索引只读查询（改代码前 impact 查影响面）
    "codegraph",
    // task_create（T2.4，AD-7）：chat 第二创建入口（对话即确认）——仅
    // MainAgent 生效集（SubAgent 不能建任务，AD-2 创建按宿主）；与
    // /project 入口同一 createTask API
    "task_create",
  ], // 装配经 CoreToolExecutor.resolveTools（组合根）
  lifecycle: { mode: "persistent" },
  hooks: [SteerHooks, MinimalHooks], // 构造器引用（T1：实例化在 AgentRuntime 装配点，每 runtime 独立）
  compaction: DEFAULT_COMPACTION,
};
