/**
 * StewardService —— 管家域门面与聚合根（V2.5 文本管家 application service；
 * 设计 §2 三分法 / §5.2 权限分级 / §5.3 ①②层；文本形态架构验证——语音版
 * V3 直接套壳）。
 *
 * 体量门 P4 拆分（本文件原 2691 行拆出四域，读面/行为零变更）：
 * - 分诊路由域 StewardRouting：ask 判定漏斗（词表 → 停止判定 → 意图泛化
 *   → addressee 分诊）+ 确认闸门禁（放行/作废/执行/终局登记）；
 * - 播报编排域 StewardOutlet：feed 播报直出、生命周期提醒、主动汇报、
 *   过程流式回执；
 * - 生命周期域 StewardLifecycle：run 执行链（装配/投影/收口）、看门狗、
 *   确认卡 TTL 与提醒巡检、启停定时器、对话记忆读写、情景快照组装；
 * - 共享内核 StewardCore：依赖注入面 + 可达状态容器 + 伴随编排态。
 * 本文件保留：聚合根装配（三域构造与绑定）、配置/档案/记忆管理读回口、
 * 工具声明面（JSON Schema 契约），以及对外公共面的一手委托。
 *
 * 三类能力（任务 brief 口径）：
 * ① 只读状态问答直达：LLM 循环（flash 级槽位独立配置）经 list_instances /
 *    list_tasks 只读工具取数 → answer 直答（决策收口 application 层，E-19
 *    handlers 只转发）；
 * ② 写注入唯一原语 = propose_send（agent_send 等价——AgentOrchestrationPort
 *    .send steer 注入通道）：**必须过确认闸**——LLM 只能提案（confirm_required
 *    回执携带 actionId + 全文），面板确认按钮 → confirm(actionId) 单次消费执行；
 *    未确认 = 零执行（§5.2 防火墙）；
 * ③ 事件 feed：agent 生命周期事件（wireEventFanout steward-feed-bridge 装配）
 *    → ①层粗筛（生命周期子集）→ ②层模板直出（中文文本行，不进 LLM——
 *    BroadcastService 先例同构）→ steward.feed 帧（仅已订阅连接，连接级闸门）。
 *
 * money gate（服务端权威）：steward.enabled ≠ "1" → ask 直接 error 判别，
 * 零 LLM 调用（RuntimeConfigPort KV 持久化，steward.set_config 写面）。
 *
 * 防自激循环（TR-169/TR-173 族纪律）：本服务订阅事件流只产出协议帧
 * （steward.feed——不 publish 领域事件），写注入只由离散用户动作（面板确认
 * 按钮）驱动——事件订阅面与写面无反馈边，结构上无环。
 *
 * 对话状态仅会话内（不持久化——任务范围钳制）：滚动窗口截尾，daemon 重启
 * 即清（与「不是第二个大脑」的上下文不分裂原则一致：只持全局状态摘要 +
 * 自身对话状态，工作上下文留在各 session/agent）。
 */
import type { DomainEvent } from "../../domain/events/DomainEvent";
import type { StewardComponent } from "./StewardComponent";
import type {
  StewardActionCompletedPayload,
  StewardAskResultPayload,
  StewardConfirmResultPayload,
  StewardAskSource,
  StewardHistoryRecord,
} from "@helix/protocol";
import type { StewardLlmTool } from "../ports/outbound/StewardLlmPort";
import { readSummaryConfig } from "../summary/summaryConfig";
import type { TriageJudgeState } from "./StewardTriageJudge";
import { StewardCore } from "./StewardCore";
import { StewardRouting } from "./StewardRouting";
import { StewardOutlet } from "./StewardOutlet";
import { StewardLifecycle } from "./StewardLifecycle";
import { STEWARD_SYSTEM_PROMPT } from "./stewardPrompts";
import { STEWARD_ENABLED_KEY, STEWARD_MODEL_KEY } from "./stewardConstants";
import type { StewardAskEvents, StewardServiceDeps } from "./stewardServiceTypes";

// 确认闸聚合域 re-export（批 1：定义已迁 domain/steward/confirmation——
// 兼容既有引用面；行为零变更）
export { pendingKeyOf } from "../../domain/steward/confirmation/ProposalLedger";
export type { PendingAction, PendingEntry } from "../../domain/steward/confirmation/ProposalLedger";


// ── 体量门 P4：迁出符号经门面原路径精确再导出（消费方 import 零改动）──
export { STEWARD_FEED_EVENT_TYPES, FEED_SUMMARY_MAX_CHARS, buildFeedText } from "./stewardFeed";
export {
  summarizeArgsLite,
  hasExemptionAffordance,
  formatActReceipt,
  displayTitleOf,
  capChars,
  formatDeliverReceipt,
  capToolResultText,
  compactInstanceRows,
  buildLlmWindow,
  matchStewardCommandPhrase,
} from "./stewardProjections";
export {
  STEWARD_MAX_TOOL_ROUNDS,
  HISTORY_WINDOW,
  TOOL_RESULT_MAX_CHARS,
  TOOL_RESULT_TRUNCATION_MARK,
  INSTANCE_TASK_MAX_CHARS,
  INSTANCE_SUMMARY_MAX_CHARS,
  STEWARD_MISSING_TOOL_RESULT_TEXT,
  STEWARD_ENABLED_KEY,
  STEWARD_MODEL_KEY,
  STEWARD_COMPACTION_THRESHOLD_TOKENS,
  STEWARD_COMPACTION_KEEP_RECENT,
  STEWARD_PENDING_ASKS_MAX,
  STEWARD_RUN_WATCHDOG_MS,
  STEWARD_RUN_WATCHDOG_TICK_MS,
  STEWARD_RUN_WATCHDOG_ABORT_GRACE_MS,
  STEWARD_MANUAL_ABORT_GRACE_MS,
  STEWARD_CONFIRM_TTL_MS,
  STEWARD_CONFIRM_REMIND_AFTER_MS,
  STEWARD_CONFIRM_TIMEOUT_DETAIL,
  CONTEXT_SNAPSHOT_MAX_CHARS,
  SNAPSHOT_TITLE_MAX_CHARS,
  SNAPSHOT_RECENT_SESSIONS,
  SNAPSHOT_ACTIVITY_MAX_ENTRIES,
  SNAPSHOT_ACTIVITY_LINE_MAX_CHARS,
  SNAPSHOT_ACTIVITY_MAX_CHARS,
  SNAPSHOT_ACTIVITY_DOMAIN_LABELS,
  RECENT_WORK_LINES_MAX,
  RECENT_WORK_TITLE_MAX_CHARS,
  DELIVER_TITLE_MAX_CHARS,
  PENDING_PROPOSALS_MAX_ITEMS,
  GATED_TOOLS,
} from "./stewardConstants";
export type {
  GateToolContext,
  GateToolOutcome,
  StewardAskEvents,
  StewardTasksSource,
  StewardSessionMetaRow,
  StewardSessionsSource,
  StewardProjectsSource,
  StewardKgSource,
  StewardServiceDeps,
  StewardEngineAssemblyOptions,
} from "./stewardServiceTypes";

// ── 体量门 P4（生命周期域拆分）：迁出符号经门面原路径精确再导出 ──
export { STEWARD_SYSTEM_PROMPT, assembleStewardSystemPrompt, buildPendingProposalsSection } from "./stewardPrompts";
export { buildContextSnapshot, timeRangeWindow, fmtWhen, type TimeRange } from "./stewardSnapshots";

/** 确认闸目标（面板两行渲染语义重载：send = 递话目标实例；createSession /
 *  spawnReview = 动作标识；deliverSession = 递话目标会话；surfaceAct = 表面
 *  动作目标 surfaceId——见各分支注释）。 */
// PendingAction 已迁确认闸聚合域（domain/steward/confirmation——批 1）。

/** 工具声明（JSON Schema 面——flash 级模型的 function calling 契约）。 */
export const TOOL_LIST_INSTANCES: StewardLlmTool = {
  name: "list_instances",
  description: "查询全部 agent 实例的状态清单（id、运行态、被指派任务、终态摘要）。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export const TOOL_LIST_TASKS: StewardLlmTool = {
  name: "list_tasks",
  description: "查询任务清单（标题、状态、进度、错误）。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export const TOOL_PROPOSE_SEND: StewardLlmTool = {
  name: "propose_send",
  description:
    "提案向运行中的 agent 实例递话（写操作——仅提案，系统会请求用户确认后才执行）。agentId 必须是当前运行中的实例。",
  parameters: {
    type: "object",
    properties: {
      agentId: { type: "string", description: "目标实例 id（如 agent-1；须运行中）" },
      message: { type: "string", description: "递话内容（将向用户全文展示以供确认）" },
    },
    required: ["agentId", "message"],
    additionalProperties: false,
  },
};

export const TOOL_QUERY_RECENT_WORK: StewardLlmTool = {
  name: "query_recent_work",
  description:
    "按时间范围查询近期工作（会话清单 + 任务清单；可按项目过滤任务、按标题关键词过滤会话）。会话行携完整 sessionId——可直接用作 deliver_to_session 的 sessionId 参数（不要让用户去界面查 id）。回答「最近在忙什么/今天做了什么/找到某个会话」类问题时先用本工具取数。",
  parameters: {
    type: "object",
    properties: {
      time_range: {
        type: "string",
        enum: ["today", "yesterday", "this_week", "last_week"],
        description: "时间范围（缺省 this_week）",
      },
      project: { type: "string", description: "项目过滤（可选——仅过滤任务清单）" },
      title_contains: {
        type: "string",
        description: "会话标题关键词过滤（可选——仅过滤会话清单；按显示标题包含匹配，不区分大小写；显示标题 = 显式标题或首条用户消息）",
      },
    },
    additionalProperties: false,
  },
};

export const TOOL_READ_SESSION: StewardLlmTool = {
  name: "read_session",
  description:
    "读取指定会话的消息内容（尾部窗口，旧→新，单条全文）——回答「那个会话聊到哪了/进展如何/具体说了什么」类问题时深读用；只读不改。sessionId 先用 query_recent_work 查（或用记忆召回行里的 sid）。需读更早的消息时用 offset 翻页（跳过最近 offset 条再取 tail 条，逐步步进）；单次结果总量有上限，读不全就加大 offset 继续翻。",
  parameters: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "目标会话 id（query_recent_work 结果或记忆召回行的 sid）" },
      tail: { type: "number", description: "本次读取条数（可选，缺省 6，上限 20）" },
      offset: { type: "number", description: "跳过最近 N 条再取（翻页读更早消息；可选，缺省 0 = 最近窗口；逐次步进如 0→6→12…可通读全对话）" },
    },
    required: ["sessionId"],
    additionalProperties: false,
  },
};

// ── 批A（管家开放 kg 只读工具）：项目知识只读检索二件 ────────

export const TOOL_KG_SEARCH: StewardLlmTool = {
  name: "kg_search",
  description:
    "检索项目知识图谱（只读）。按关键词（节点名/摘要子串匹配，非语义）返回摘要列表，每行含适用场景、摘要与 `kg get <id>` 指针。回答「这个项目的规则/架构/术语/历史决策是什么」类问题时先用本工具取数，命中后用 kg_get 读全文。id 永远取自返回行指针，不要自造。",
  parameters: {
    type: "object",
    properties: {
      q: { type: "string", description: "关键词（取用户问题里的核心名词/术语——子串匹配，短而准命中率高）" },
      project: { type: "string", description: "项目名（可选；已知目标项目时显式传入避免跨项目混排——多项目 workspace 缺省聚合各项目结果并带【项目 名】标注；取 workspace 一级目录名）" },
    },
    required: ["q"],
    additionalProperties: false,
  },
};

export const TOOL_KG_GET: StewardLlmTool = {
  name: "kg_get",
  description:
    "读取项目知识节点全量（只读）：digest/适用场景/正文/锚/关系/supersede 链/变更日志。nodeId 必须取自 kg_search 返回行的「kg get <id>」指针（TR-n / E-n 形态）；结果体量大时先看 digest 与适用场景再引用。",
  parameters: {
    type: "object",
    properties: {
      nodeId: { type: "string", description: "节点 id（TR-n / E-n 形态——必须取自 kg_search 返回行指针）" },
      project: { type: "string", description: "项目名（可选；多项目 workspace 建议显式传入以定位同号节点——缺省聚合域取首个命中）" },
    },
    required: ["nodeId"],
    additionalProperties: false,
  },
};

export const TOOL_CREATE_SESSION: StewardLlmTool = {
  name: "create_session",
  description:
    "提案创建新会话（写操作——仅提案，系统会请求用户确认后才执行）。**只在用户只要一个空会话时使用**；用户话里带着任何要做的事/话题时必须改用 start_session（话题是用户要在新会话里开始的内容，不是标题——塞进 title 会丢）",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "会话主题标题（可选，缺省自动生成；仅作显示标题，不派生消息）" },
      project: { type: "string", description: "关联项目名（可选——织入标题标注）" },
    },
    additionalProperties: false,
  },
};

export const TOOL_START_SESSION: StewardLlmTool = {
  name: "start_session",
  description:
    "提案创建新会话并带着话题开局（写操作——仅提案，系统会请求用户确认后才执行）。用户想开新会话且话里带着要做的事/话题时使用：initial_message = 用户原话（不改写、不总结——确认后建成会话即作为首条消息投递并在新会话开启工作，将向用户全文展示以供确认）；话题可另提炼 title",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "会话主题标题（可选，可从话题提炼；仅作显示标题）" },
      project: { type: "string", description: "关联项目名（可选——织入标题标注）" },
      initial_message: {
        type: "string",
        description:
          "初始话题/首条消息（必填——用户想在 新会话里开始的内容，用户原话，原文投递不经改写）",
      },
    },
    required: ["initial_message"],
    additionalProperties: false,
  },
};

export const TOOL_SPAWN_REVIEW_TASK: StewardLlmTool = {
  name: "spawn_review_task",
  description:
    "提案发起评审任务（写操作——仅提案，系统会请求用户确认后才执行）。review_type: code-review（代码评审，需项目有 git 仓）或 kg-review（知识图谱评审，需项目已建 .kg 索引）",
  parameters: {
    type: "object",
    properties: {
      review_type: { type: "string", enum: ["code-review", "kg-review"], description: "评审类型" },
      project: { type: "string", description: "目标项目名（workspace 内）" },
      params: { type: "object", description: "任务参数（按任务类型 paramsSchema 透传）" },
    },
    required: ["review_type", "project"],
    additionalProperties: false,
  },
};

export const TOOL_DELIVER_TO_SESSION: StewardLlmTool = {
  name: "deliver_to_session",
  description:
    "提案向指定会话投递用户输入（写操作——仅提案，系统会请求用户确认后才执行；投递成功后界面自动切到该会话）。sessionId 可先用 query_recent_work 查询（结果含 sessionId）。",
  parameters: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "目标会话 id（query_recent_work 结果中的 sessionId）" },
      text: { type: "string", description: "投递内容（将向用户全文展示以供确认）" },
    },
    required: ["sessionId", "text"],
    additionalProperties: false,
  },
};

export const TOOL_REMEMBER: StewardLlmTool = {
  name: "remember",
  description:
    "沉淀长期记忆（立即静默入库并弹通知卡，无需用户确认）。仅用于跨会话有持久价值的认知增量：用户明确表达的偏好/习惯（kind=preference）或对话中确认的事实（kind=fact）。text 要提炼成一句简单易懂、主题明确的记忆句（不要照搬用户原话口语）。一次性上下文、本轮临时信息、寒暄不记；语义重复会自动覆盖更新原条目。domain 标注记忆的业务领域（缺省按 kind 推导：preference→habit、fact→general）：habit = 关于用户怎么干活（换个团队也成立）；general = 环境与通用工作方式事实（跟项目无关）；project = 绑定具体项目才有意义（换个项目不成立——项目专属事实/约定请显式标注 project）。",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "记忆文本（一句自然语言，将向用户全文展示以供确认）" },
      kind: { type: "string", enum: ["fact", "preference"], description: "条目类别（缺省 fact）" },
      domain: {
        type: "string",
        enum: ["habit", "general", "project"],
        description:
          "业务领域（可选；缺省按 kind 推导：preference→habit、fact→general）：habit=用户习惯（换个团队也成立）/ general=通用事实（跟项目无关）/ project=项目专属（换个项目不成立）",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

/** memory_search（记忆批·同轨换轨）：管家长期记忆只读检索——机械注入
 *  退役后的唯一管家记忆消费面。query = 管家对用户话语的提炼重写（ASR
 *  转写生硬/错别字，不拿原文直接查）；语义与编码面 memory_search 工具
 *  同族但分野：管家面 kinds 全类收（progress 走配额 ≤2，E-247）、topK =
 *  memory.recallTopK 生效值（E-261 配置消费面保留）、幸存者记 markRecalled。 */
export const TOOL_MEMORY_SEARCH: StewardLlmTool = {
  name: "memory_search",
  description:
    "检索用户长期记忆（偏好/事实/会话进展，只读）。回答、路由或提案前必查：query 用你自己对用户话语的理解与提炼（语音转写常生硬、有错别字，先做一次问题重写再查），再综合作答——不能只看当前问题不看用户既往习惯。返回逐条记忆行，「[进展]…（sid: xxx）」行可直接作 read_session 的 sessionId；命中记忆与本轮指令冲突时以本轮指令为准，零命中即正常作答。",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "检索意图（对用户话语的提炼重写，非转写原文；语义匹配用户偏好与工作状态类记忆）" },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

/** surface_list（M2 四泛型工具之一，D4）：动态发现表面与能力——新表面/新
 *  动词靠它发现，不加工具膨胀。 */
export const TOOL_SURFACE_LIST: StewardLlmTool = {
  name: "surface_list",
  description:
    "列出当前全部表面（浏览器 tab / helix 页面等）及其能力动词清单——不知道 surfaceId 或想知道能做什么时先用本工具。只读免确认。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

/** snapshot：表面状态快照（只读免确认）。 */
export const TOOL_SNAPSHOT: StewardLlmTool = {
  name: "snapshot",
  description:
    "读取指定表面的当前状态快照（页面标题/网址/可见文本摘要）——帮用户看页面现状时用。只读免确认；surfaceId 用 surface_list 查（如 browser:xxx）。",
  parameters: {
    type: "object",
    properties: {
      surfaceId: { type: "string", description: "目标表面 id（如 browser:<targetId>，先用 surface_list 查）" },
    },
    required: ["surfaceId"],
    additionalProperties: false,
  },
};

/** read：表面内容读取（只读免确认）。 */
export const TOOL_READ: StewardLlmTool = {
  name: "read",
  description:
    "读取指定表面的页面内容（可见文本全文，可限定元素范围）——需要看页面具体写了什么时用。只读免确认。",
  parameters: {
    type: "object",
    properties: {
      surfaceId: { type: "string", description: "目标表面 id（如 browser:<targetId>）" },
      selector: { type: "string", description: "CSS 选择器限定范围（可选，缺省整页）" },
      max_chars: { type: "number", description: "返回长度上限（可选，缺省 4000）" },
    },
    required: ["surfaceId"],
    additionalProperties: false,
  },
};

/** act：表面动作（risk 三级闸——read 直行 / write·destructive 提案确认后执行）。 */
export const TOOL_ACT: StewardLlmTool = {
  name: "act",
  description:
    "在指定表面上执行动作（verb 封闭词汇表：click/type/navigate/scroll/focus）。risk 挂动作：scroll/focus 免确认直行；click/type/navigate 属 write——仅提案，系统会请求用户确认后才执行；destructive 强制确认不可豁免。args 按表面与动词：navigate 在 shell 表面 {sessionId}（会话 id 字符串——切换会话，不是 url）、navigate 在 browser 表面 {url}、click {selector}、type {selector,text}、scroll {y} 或 {direction}（up/down/top/bottom）、focus {selector}。形状不合法会收到即时错误指引。",
  parameters: {
    type: "object",
    properties: {
      surfaceId: { type: "string", description: "目标表面 id（如 browser:<targetId> 或 shell:<connId>，先用 surface_list 查）" },
      verb: { type: "string", enum: ["click", "type", "navigate", "scroll", "focus"], description: "动作动词（封闭词汇表，不得私造）" },
      args: { type: "object", description: "动词参数（按表面×动词形状，见工具描述；navigate 在 shell 表面是 {sessionId}，在 browser 表面是 {url}）" },
      risk: {
        type: "string",
        enum: ["read", "write", "destructive"],
        description: "风险档（可选，缺省按动词注册档；只可升档不可降档）",
      },
    },
    required: ["surfaceId", "verb"],
    additionalProperties: false,
  },
};

export class StewardService implements StewardComponent {
  /** 共享内核（依赖注入面 + 可达状态 + 伴随编排态；体量门 P4）。 */
  private readonly core: StewardCore;
  /** 分诊路由域（ask 判定漏斗 + 确认闸门禁）。 */
  private readonly routing: StewardRouting;
  /** 播报编排域（feed 播报 / 提醒帧 / 主动汇报 / 过程回执）。 */
  private readonly outlet: StewardOutlet;
  /** 生命周期域（run 执行链 / 兜底巡检 / 对话记忆读写 / 快照组装）。 */
  private readonly lifecycle: StewardLifecycle;

  constructor(deps: StewardServiceDeps) {
    this.core = new StewardCore(deps);
    // 协作面（分诊路由域 → run 驱动 / 提醒播报）：域间协作一律指对应域实例，
    // 不回落门面（门面只做公共面委托，零编排逻辑）
    this.outlet = new StewardOutlet(this.core);
    this.lifecycle = new StewardLifecycle(this.core);
    this.routing = new StewardRouting(this.core, {
      driveAsk: (item) => this.lifecycle.driveAsk(item),
      emitLifecycleNotify: (urgency, title, body) => this.outlet.emitLifecycleNotify(urgency, title, body),
    });
    this.core.bindDomains({ routing: this.routing, outlet: this.outlet, lifecycle: this.lifecycle });
  }

  /** 八工具中立规格（createEngine 装配面——委托内客观测面）。 */
  private get toolSpecs() {
    return this.core.toolSpecs;
  }

  /** 隐藏面板原语名（不进引擎工具面——getProfile 观测面合并显示）。 */
  private get hiddenToolNames() {
    return this.core.hiddenToolNames;
  }

  // ── 分诊路由域委托（StewardRouting）────────────────────────

  /** 入站 ask（判定漏斗 + 排队接管——域内实现见 StewardRouting.ask）。 */
  async ask(
    text: string,
    events: StewardAskEvents = {},
    deliver?: (payload: StewardAskResultPayload) => void,
    source: StewardAskSource = "text",
  ): Promise<StewardAskResultPayload> {
    return this.routing.ask(text, events, deliver, source);
  }

  /** 在途轮 abort（幂等轻停——队列照常）。 */
  abortInFlight(reason: string): boolean {
    return this.routing.abortInFlight(reason);
  }

  /** 全停（abort 当前 + 清空排队；语音停止判定通道）。 */
  interruptAll(reason: string): number {
    return this.routing.interruptAll(reason);
  }

  /** 停止意图判定（协议面 steward.judge_stop_intent 单源）。 */
  async judgeStopIntent(
    text: string,
  ): Promise<{ stop: boolean; score?: number; degraded?: "off" | "unready" | "error" }> {
    return this.routing.judgeStopIntent(text);
  }

  /** 确认闸放行（两段式：受理即回 + 异步执行回执）。 */
  async confirm(
    actionId: string,
    onCompleted?: (payload: StewardActionCompletedPayload) => void,
  ): Promise<StewardConfirmResultPayload> {
    return this.routing.confirm(actionId, onCompleted);
  }

  /** 确认卡作废（幂等；作废即终局）。 */
  cancel(actionId: string): void {
    this.routing.cancel(actionId);
  }

  /** 在途确认卡快照（steward.pending.snapshot 对账/跨重启清场）。 */
  pendingSnapshot(): readonly string[] {
    return this.routing.pendingSnapshot();
  }

  /** 开关现态（money gate 读面）。 */
  isEnabled(): boolean {
    return this.core.isEnabled();
  }

  // ── 播报编排域委托（StewardOutlet）──────────────────────────

  /** 事件 feed 播报入口（①层粗筛 + 订阅闸 + ②层模板直出 + feed 帧）。 */
  onDomainEvent(event: DomainEvent): void {
    this.outlet.onDomainEvent(event);
  }

  /** 对话内主动汇报（记录入工作记忆 + steward.proactive 实时帧）。 */
  async reportProactive(report: {
    title: string;
    text: string;
    suggestions?: readonly { label: string; verb?: string; sessionId?: string }[];
  }): Promise<void> {
    return this.outlet.reportProactive(report);
  }

  // ── 生命周期域委托（StewardLifecycle）────────────────────────

  /** 启动可靠性巡检定时器（生产面；幂等——域内实现见 StewardLifecycle）。 */
  startReliabilityTimers(): void {
    this.lifecycle.startReliabilityTimers();
  }

  /** StewardComponent 契约（批 0 生命周期登记表）：start/stop 映射既有
   *  可靠性巡检定时器面（幂等语义不变）。 */
  start(): void {
    this.lifecycle.start();
  }

  stop(): void {
    this.lifecycle.stop();
  }

  /** 停巡检定时器（shutdown 链挂点/测试清理）。 */
  stopReliabilityTimers(): void {
    this.lifecycle.stopReliabilityTimers();
  }

  /** 可靠性巡检单拍（看门狗 → 可达性提醒 → 确认闸 TTL；幂等可重入）。 */
  reliabilityTick(): void {
    this.lifecycle.reliabilityTick();
  }

  /** 工作记忆读面（steward.history 回放：完整记录数组——UI 渲染与 LLM 窗口
   *  同源重建；A1 批）。 */
  async getHistory(): Promise<readonly StewardHistoryRecord[]> {
    return this.lifecycle.getHistory();
  }

  /** 新对话闸（steward.history {clear:true}：KV + daemon LLM 窗口同清——
   *  前端显示由回执空数组同步；A1 批）。 */
  async clearHistory(): Promise<void> {
    return this.lifecycle.clearHistory();
  }

  /** 设置现态（steward.get_config / set_config 共用读面）。summary 组 =
   *  总结配置域只读回显（config.result 回显 summary 组——写面在
   *  config.set_summary，管家配置零总结项）。triage 组 = 分诊判官配置
   *  现态（分诊判官接入批：judgeEnabled + judgeEndpoint 引用态——端点
   *  删除读面视为未配 null）。 */
  getConfig(): {
    enabled: boolean;
    model: string;
    summary: import("../summary/summaryConfig").SummaryConfigState;
    memory: import("./StewardMemoryService").StewardMemoryState;
    triage: TriageJudgeState;
  } {
    return {
      enabled: this.isEnabled(),
      model: this.core.deps.config.get(STEWARD_MODEL_KEY) ?? this.core.deps.llm.modelId,
      // 总结配置组回显（summary.* 通用域生效值——所见即所得）
      summary: readSummaryConfig(this.core.deps.config),
      // 管家记忆 B1：记忆面现态（未装配 = 全降级缺省——开关关/零条目；批1：
      //  endpoint 摘除——向量端点恒为全局默认端点，回执不回 endpointId）
      memory: this.core.deps.memory?.getMemoryState() ?? {
        enabled: false,
        available: false,
        judgeEndpoint: null,
        entryCount: 0,
        dim: null,
      },
      // 分诊判官配置现态（未装配 = 全降级缺省——开关关/端点未配）
      triage: this.core.deps.triageJudge?.state() ?? { judgeEnabled: false, judgeEndpoint: null },
    };
  }

  /** 管家只读档案（agent.steward_profile.get；管家公民权批）：纯导出面——
   *  零新状态，三现有源：①静态人格段 STEWARD_SYSTEM_PROMPT（动态情景快照
   *  段运行期拼入不在本面）；②注册面八工具清单（ToolRegistry.manifest 含
   *  hidden 面板原语——观测透明度 = 真实工具面）；③模型槽位 KV 现值
   *  （未设 = null——修改走智能体页管家卡模型槽位）。回执不含任何凭据类字段。 */
  getProfile(): { systemPrompt: string; tools: readonly { name: string; description: string }[]; model: string | null; kindLabel: "steward" } {
    return {
      systemPrompt: STEWARD_SYSTEM_PROMPT,
      tools: [
        ...this.core.toolSpecs.map((t) => ({ name: t.name, description: t.description })),
        { name: "steward_confirm", description: "确认闸放行（面板确认按钮原语；非 LLM 工具）" },
      ],
      model: this.core.deps.config.get(STEWARD_MODEL_KEY) ?? null,
      kindLabel: "steward",
    };
  }

  // ── 记忆条目管理委托面（管家记忆 B2：steward.memory_* 四命令回口——
  //    memory 服务缺席时零记忆降级形态）───────────────────────

  /** 条目只读清单（空数组 = 记忆面缺席/空库）。 */
  listMemoryEntries(): readonly import("../ports/outbound/StewardMemoryPort").StewardMemoryEntry[] {
    return this.core.deps.memory?.listEntries() ?? [];
  }

  /** 人工新增（embed 入库；缺席/失败 → error outcome）。projectScope =
   *  显式指定通道（项目隔离批——"global" 或项目目录名）；domain（domain
   *  维度批）= 业务领域显式指定，缺省按 kind 推导（preference→habit、
   *  fact→general）或由显式 projectScope 反向隐含 project 域。 */
  async appendMemoryEntry(
    text: string,
    kind?: "fact" | "preference",
    projectScope?: string,
    domain?: import("../ports/outbound/StewardMemoryPort").MemoryDomain,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.core.deps.memory === undefined) {
      return { ok: false, error: "记忆面未装配（daemon 装配缺 memory 源）" };
    }
    return this.core.deps.memory.appendMemoryEntry(text, kind, projectScope, domain);
  }

  /** 重嵌更新（缺席/失败 → error outcome）。 */
  async updateMemoryEntry(id: number, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.core.deps.memory === undefined) {
      return { ok: false, error: "记忆面未装配（daemon 装配缺 memory 源）" };
    }
    return this.core.deps.memory.updateMemoryEntry(id, text);
  }

  /** 行级删除（缺席 → false，幂等）。 */
  forgetMemoryEntry(id: number): boolean {
    return this.core.deps.memory?.forgetEntry(id) ?? false;
  }

  /** 置顶切换（遗忘机制批命令回口：置顶 = 解除淡忘 + 刷 updatedAt；
   *  缺席 → false）。 */
  pinMemoryEntry(id: number, pinned: boolean): boolean {
    return this.core.deps.memory?.pinMemoryEntry(id, pinned) ?? false;
  }

  /** 淡忘恢复（遗忘机制批命令回口：active 条目幂等 no-op；缺席 → false）。 */
  restoreMemoryEntry(id: number): boolean {
    return this.core.deps.memory?.restoreMemoryEntry(id) ?? false;
  }

  /** 设置写面（槽位可选更新；model 格式校验 "provider/model-id"；
   *  memory 组 {enabled?,judgeEndpointId?} + 批B 召回量
   *  {recallTopK?,recallPool?} + 阈值 {recallMinScore?}——组内字段整体转发
   *  通用记忆配置域 memory.*；批1：memory.endpointId 退役（向量端点选择
   *  收编 embedding.defaultEndpointId），旧壳传值由 handler 静默忽略；
   *  triage 组 {judgeEnabled?,judgeEndpointId?} 转发分诊判官配置域
   *  （分诊判官接入批）。
   *  **summary/sessionMemory 组已摘除**（会话总结器独立化批①——总结配置
   *  收编 summary.* 通用域，写面在 config.set_summary；携带旧组的载荷在
   *  handler 层拒答 invalid_payload）。 */
  async setConfig(patch: {
    enabled?: boolean;
    model?: string;
    memory?: { enabled?: boolean; judgeEndpointId?: string; recallTopK?: number; recallPool?: number; recallMinScore?: number };
    triage?: { judgeEnabled?: boolean; judgeEndpointId?: string };
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (patch.memory !== undefined) {
      // 管家记忆 B1：记忆配置委托记忆域服务（校验在其中——开启前端点必填）
      if (this.core.deps.memory === undefined) {
        return { ok: false, error: "记忆面未装配（daemon 装配缺 memory 源）" };
      }
      const outcome = await this.core.deps.memory.setMemoryConfig(patch.memory);
      if (!outcome.ok) return outcome;
    }
    if (patch.triage !== undefined) {
      // 分诊判官接入批：判官配置委托判定域面（空串 judgeEndpointId = 清除引用）
      if (this.core.deps.triageJudge === undefined) {
        return { ok: false, error: "分诊判官面未装配（daemon 装配缺 triage 源）" };
      }
      const outcome = await this.core.deps.triageJudge.setConfig(patch.triage);
      if (!outcome.ok) return outcome;
    }
    if (patch.model !== undefined) {
      const model = patch.model.trim();
      if (model !== "" && !/^[^/\s]+\/[^/\s]+$/.test(model)) {
        return { ok: false, error: `模型格式非法：${model}（应为 "provider/model-id" 形态）` };
      }
      if (model !== "") await this.core.deps.config.set(STEWARD_MODEL_KEY, model);
    }
    if (patch.enabled !== undefined) {
      await this.core.deps.config.set(STEWARD_ENABLED_KEY, patch.enabled ? "1" : "0");
    }
    return { ok: true };
  }
}
