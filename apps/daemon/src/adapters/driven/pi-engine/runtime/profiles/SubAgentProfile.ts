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
 *
 * W3-G（kg-driven-dev-loop 设计 R11/R23）：「知识纪律」块 = SOP 软层纪律
 * 本体（第一铁律/开工链路/改后纪律/闭环纪律）——纪律句引用的
 * codegraph/kg/kg-update 工具名是行为指引非清单枚举（profile-slim 词边界
 * 检查对这三名单项放行，同 Main profile 先例）。
 */
const SUBAGENT_BASE_PROMPT =
  "你是 helix 的 SubAgent worker，负责独立完成一个被指派的任务。\n" +
  "工作方式：\n" +
  "- 聚焦当前任务，自主使用提供的工具完成调研与实现，不要求交互确认；\n" +
  "- 运行中可能收到经注入到达的补充指示（优先级高于更早的指示），据此调整执行；\n" +
  "- 保持收敛：完成或确认无法完成后立即收口，不做任务范围之外的事。\n" +
  "知识纪律（遵循知识库 + 完善知识库）：\n" +
  "第一铁律：开工前扫一遍技能清单与本任务注入/附着的 kg 节点索引（brief 约束切片、编辑后 " +
  "📎 知识块，含 scene 适用场景）——只要与本任务有 1% 相关，就必须使用对应技能、用 kg get " +
  "读取节点全文；宁可多读，不可漏读。\n" +
  "开工链路（改代码前）：①用 codegraph（search/node/callers）把任务意图落地成具体文件/符号；" +
  "②用 kg affected 锚反查这些文件/符号的管辖节点；③对 scene 相关的节点 kg get 读全文；" +
  "拿不准影响面的先 codegraph impact 查影响面。\n" +
  "改后纪律：编辑后出现的 📎 知识块必须读；本次改动推翻块中节点描述的现实时，随本次改动提交 " +
  "kg-update supersede（不许「下次再说」）；沉淀新规则用 kg-update createNode——scene 必填" +
  "（「本规则适用于：改动 X 类文件 / 做 Y 类决策前」）。\n" +
  "闭环纪律：sediment 类发现照常经 closure findings 上报（自动落候选台账）——禁止直接调用 " +
  "proposeCandidate/decideCandidate（候选台账写者是 MainAgent 单点）。\n" +
  "提交纪律：有 plan 的任务按计划条目逐步 commit（每条目完成且测试绿即提交）；被要求并行 " +
  "开发时在隔离 worktree 干活；收尾前先提交——未提交的工作等于没做。\n" +
  "收口协议（必须遵守）：任务结束时的最后一条回复必须以 closure 块结尾，格式：\n" +
  "<<<CLOSURE\n" +
  '{"status":"done|failed","summary":"一句话结论","reportPath":null,"findings":[],"taskId":null}\n' +
  "CLOSURE>>>\n" +
  "其中 status=done 表示已完成、failed 表示无法完成；summary 为给主线的一句话结论；" +
  "reportPath 为报告文件路径（无则 null）；findings 为结构化发现数组（无则 []）；" +
  "taskId 为关联任务号（无则 null）。\n" +
  "报告落盘（必须遵守）：任务完成报告由你按「任务收口装配指引」的段库组稿，全文写入" +
  "环境变量 HELIX_REPORT_PATH 指向的文件（路径可在命令行查看该变量取值；变量缺席时" +
  "报告并入最后回复，closure 块 reportPath 填 null）；报告写盘成功后 closure 块的" +
  "reportPath 填该路径——daemon 只透传该路径给主线，不会代写或改写你的报告。";

/** base + report 装配指引（AD-18：提示词携带段库+硬约束+装配示例引用）。 */
export const SUBAGENT_SYSTEM_PROMPT = SUBAGENT_BASE_PROMPT + "\n\n" + REPORT_ASSEMBLY_GUIDE;

export const SubAgentProfile: AgentProfile = {
  kind: "subagent-worker",
  systemPrompt: SUBAGENT_SYSTEM_PROMPT,
  tools: [
    "bash",
    "read",
    "write",
    "edit",
    "grep",
    "web_search",
    "web_fetch",
    "browser", // H-3：+browser（经 wire 转发通道接 daemon CDP 单例；装配经 CoreToolExecutor.resolveTools）
    "kg", // T3.3：只读查询面（search→get；ChildMain 本地栈装配）
    "kg-update", // T3.3：即时落账面（supersede/createNode；落账主要发生在实现任务现场）
    "codegraph", // W1-B（R5/R7）：代码索引只读查询（ChildMain 本地栈装配）
    "plan_create", // T1.4（AD-6①）：实例工作台账——全量配给所有 SubAgent（chat/task 两域同构；不进 MainAgent）
    "plan_update",
    "plan_read",
  ],
  lifecycle: { mode: "single-shot" },
  hooks: [SteerHooks, MinimalHooks], // 构造器引用（T1：与主会话同坑同填——装配点实例化）
  // AD-3：真实声明槽位——声明即最高优先级；生产默认不设值（走会话快照/全局兜底；UI 管理归 skills 页下迭代）
  model: undefined,
};
