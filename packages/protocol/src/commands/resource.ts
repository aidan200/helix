/** 资源与观测域命令族：trace.query / agent.config.* / web.*。 */
import type { CommandFrame } from "../envelope";
import type { ProfileKind } from "../types/agent";
import type { TraceQueryPageInput, TraceTimeRange } from "../types/trace";
import type { EmptyPayload } from "./session";

// ── v0.4 新增：trace 族（契约 v0.4 §1；iter-20260819-erio T2.1，CL-5/F5.6） ──

/**
 * trace.query 载荷：会话历史事件查询（连接私有读面——直查 domain_events，
 * 目标会话可为冷会话，不触发懒加载）。payload.sessionId 必填；信封
 * sessionId 位不消费（查询目标在 payload 内）。
 * 结果帧 = trace.query.result 点对点回执（TR-AD-21；帧形状见 events.ts）。
 */
export interface TraceQueryPayload {
  /** 目标会话（必填，非空 string）。 */
  sessionId: string;
  /** 实例多选：缺省 = 全部实例；空数组 = 空结果（显式语义，非「全部」）。 */
  instanceIds?: string[];
  /** 实例种类过滤。 */
  agentKind?: "main" | "subagent";
  /** 事件类型多选：缺省 = 全部类型；空数组 = 空结果（同 instanceIds 口径）。 */
  types?: string[];
  /** 时间窗（ISO 8601 文本，含起含止；from > to = 校验拒绝）。 */
  timeRange?: TraceTimeRange;
  page?: TraceQueryPageInput;
}

export interface TraceQueryCommand extends CommandFrame<TraceQueryPayload> {
  type: "trace.query";
}

// ── v0.6 新增：agent.config 族（M6 T3 智能体配置页；profile kind 维资源动态化） ──

/**
 * agent.config.list 载荷：资源配置读面（全局命令，信封 sessionId 省略）。
 * 结果帧 = agent.config.list.result 点对点回执（TR-AD-21 模式）。
 */
export interface AgentConfigListPayload {
  /** 目标 kind：缺省 = 全部可配置 kind（main-session + subagent-worker 双块，序固定；task-worker 已撤）；携带 = 单块。 */
  profileKind?: "main-session" | "subagent-worker";
}

export interface AgentConfigListCommand extends CommandFrame<AgentConfigListPayload> {
  type: "agent.config.list";
}

/**
 * agent.config.set_enabled 载荷：资源启停写面（全局命令）。
 * tool/skill：name 须在全集内（全集外 → 结果帧 skipped reason=unknown-name，
 * 不落库）；model 型语义 = 槽位 set/clear——enabled=true 设 name 为槽位模型
 * （先经合并目录校验，目录外 → skipped reason=unknown-model），enabled=false
 * 清槽（name 忽略）。thinking 型（v0.11 批内补登，AD-6）同构槽位语义：
 * enabled=true 设 name 为 thinking 槽位档位（字符串透传，helix 不做档位
 * 校验——SoT 在 pi-ai，AD-2），enabled=false 清槽。applied →
 * agent.config.changed 广播（daemon 级全局）。
 */
export interface AgentConfigSetEnabledPayload {
  /**
   * 配置单元 kind（写面五值，types/agent.ts ProfileKind 单点）：可编辑两 kind
   * 全 resourceType 可写；系统派生 kind（orchestrator / subagent-kg-writer /
   * subagent-code-reviewer）仅 model/thinking 槽位型可写（独立配置，未配跟随
   * 全局——不联动 worker 槽位），tool/skill 启停写面仍拒（agent.config.read_only）。
   */
  profileKind: ProfileKind;
  /** mcp-server = server 级配置面批：per-kind server 启停差异行（name = server 名，全集外 → skipped reason=unknown-mcp-server）。 */
  resourceType: "tool" | "skill" | "model" | "thinking" | "mcp-server";
  /** 资源名（model 型 = "provider/model-id"；thinking 型 = 档位字符串；clear 时忽略）。 */
  name: string;
  /** tool/skill/mcp-server = 启停；model/thinking = set（true）/ clear（false）槽位。 */
  enabled: boolean;
}

export interface AgentConfigSetEnabledCommand extends CommandFrame<AgentConfigSetEnabledPayload> {
  type: "agent.config.set_enabled";
}

/**
 * agent.base_prompt.get 载荷：base 段系统提示词读面（全局命令，信封
 * sessionId 省略）。base 段 = profile 静态声明 prompt（三段组装的第①段，
 * 无工具/技能清单——动态两段由 SystemPromptAssembler 运行期拼入，不在本
 * 读面）；静态不随 toggle 变化，故走独立懒查询而非塞进 list.result（避免
 * changed 重拉携带大文本）。结果帧 = agent.base_prompt.get.result 点对点
 * 回执（TR-AD-21 模式）。
 */
export interface AgentBasePromptGetPayload {
  /** 目标 kind（四值全可读——含系统派生两 kind；kg-writer = SUBAGENT base + 图谱产出型后缀同 profile 声明）。 */
  profileKind: ProfileKind;
}

export interface AgentBasePromptGetCommand extends CommandFrame<AgentBasePromptGetPayload> {
  type: "agent.base_prompt.get";
}

/**
 * agent.skill_content.get 载荷：skill 正文（SKILL.md 全文）懒查询读面
 *（全局命令，信封 sessionId 省略）。正文为静态大体量数据（不随 toggle
 * 变），走独立懒查询而非塞进 agent.config.list.result——base_prompt.get
 * 同款判据（TR-68）。按技能名取（三源全集内唯一名）；结果帧 =
 * agent.skill_content.get.result 点对点回执（TR-AD-21 模式）。
 */
export interface AgentSkillContentGetPayload {
  /** 技能名（SKILL.md frontmatter name——agent.config.list skills 行同源）。 */
  name: string;
}

export interface AgentSkillContentGetCommand extends CommandFrame<AgentSkillContentGetPayload> {
  type: "agent.skill_content.get";
}

/**
 * agent.skill.create 载荷：用户级技能创建写面（settings skills 分区添加批）。
 * 入参 = SKILL.md **全文**（frontmatter 含 name/description）——两渠道统一形态：
 * 页面表单拼装 / 文件导入原文；daemon 权威解析校验（name 安全 / description
 * 非空 / 同名不存在），前端零解析。结果帧 = agent.skill.create.result 点对点
 * 回执（TR-AD-21 模式）；applied 后新技能下次 agent.config.list 即见（扫描现拍）。
 */
export interface AgentSkillCreatePayload {
  /** SKILL.md 全文（含 frontmatter）。 */
  content: string;
}

export interface AgentSkillCreateCommand extends CommandFrame<AgentSkillCreatePayload> {
  type: "agent.skill.create";
}

// ── v0.7 新增：web 族（T4 联网状态图标；daemon BrowserPort 单例 CDP 连接面） ──

/**
 * web.status 载荷：连接状态读面（全局命令，信封 sessionId 省略；无参）。
 * 结果帧 = web.status.result 点对点回执（TR-AD-21 模式）。
 */
export interface WebStatusCommand extends CommandFrame<EmptyPayload> {
  type: "web.status";
}

/**
 * web.stop 载荷：手动停止写面（全局命令；无参）——关全部受管 tab →
 * 断 CDP 连接 → 回 idle（幂等，未连接时安全 no-op）。回执 =
 * web.stop.result 点对点（{status:"applied"}）；状态回流经
 * web.status.changed 广播。
 */
export interface WebStopCommand extends CommandFrame<EmptyPayload> {
  type: "web.stop";
}

// ── v0.9 新增：web.start（T7 CDP 显式启动通路；lazy connect 的人侧预热入口） ──

/**
 * web.start 载荷：显式启动写面（全局命令；无参）——用户知情触发 lazy connect
 *（首次连接 Chrome 可能弹授权框，不应由 LLM 静默预热）。已连接时幂等
 *（connect() no-op）。回执 = web.start.result 点对点（applied = 建连成功/
 * 已连接幂等；skipped = 未发现可用浏览器，reason 含引导用户开 remote
 * debugging 的说明）；状态回流经 web.status.changed 广播（单一事件源纪律，
 * handler 不重复广播）。
 */
export interface WebStartCommand extends CommandFrame<EmptyPayload> {
  type: "web.start";
}

