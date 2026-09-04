/**
 * 命令目录（C→S，契约 §4 + 契约 B §1 / 契约 C §1；目录文档见同包 PROTOCOL.md）。
 *
 * 共 45 个命令：v0 5 + v0.1 3 + v0.2 新增 13（session 族 3 / model 族 6 /
 * auth 族 4）；v0.3 零新增——三处扩展全部为可选参数/字段（tier /
 * instanceId / anchorEntryId，TR-AD-23① 可选参数优先于新命令对）；
 * v0.4 新增 1（trace 族 trace.query，契约 v0.4 §1，iter-20260819-erio T2.1）；
 * v0.6 新增 2（agent.config 族，M6 T3 智能体配置页）；
 * v0.7 新增 2（web 族，T4 联网状态图标）；
 * v0.9 新增 1（web.start，T7 CDP 显式启动通路）。
 * v0.11 新增 1（thinking.set，thinking 批，iter-20260823-6ps5 T1.1，AD-2/AD-4）。
 * kg 批新增 6（kg 族，iter-20260825-11fo T5.3：P-1 图谱查看页六命令，
 * v0.11 后 additive 微批；五图谱命令携带必填 project 按项目作用域）。
 * workspace 批新增 2（workspace.get/open，W1 绑定闭环）。
 * task 批新增 9（task 族，iter-20260829-ys7q T1.5：P-2 任务页九命令，
 * workspace 批后 additive 微批；零内容干预——AD-2：无 steer/批次重试/
 * 内容编辑命令，九命令清单即全集）。
 * kg-bootstrap 批新增 5（kg 族 additive，iter-20260829-ys7q T3.2：/project 页
 * bootstrap 入口与产出呈现五命令；契约 contracts/kg-bootstrap-api.md）。
 * `CommandEnvelope` 为判别式联合，daemon 侧 switch(cmd.type)
 * 分发。会话作用域命令的信封 sessionId 必填（AD-4 路由位，类型层可选、
 * 客户端纪律保证）；全局命令（session.list / model.set_default /
 * model.get_default / model.catalog* / auth.*）省略。未知 type / payload
 * 不符的错误回执见 §7（command.unknown / command.invalid_payload；
 * v0.2 已登记未实现命令 → command.unimplemented，T2.x 前占位回执）。
 */
import type { CommandFrame } from "./envelope";
import type { SessionListResultPayload } from "./events";
import type { SessionLoadHistoryResultEventPayload } from "./events/session";
import type { AuthProviderInfo } from "./types/auth";
import type { CatalogModel } from "./types/model";
import type { EntryDto } from "./types/session";
import type { ProfileKind } from "./types/agent";
import type { TaskStatus } from "./types/task";
import type { TraceQueryPageInput, TraceTimeRange } from "./types/trace";

/** chat.send 载荷：发送用户消息（新输入，ChatPort.sendMessage） */
export interface ChatSendPayload {
  text: string;
  /**
   * 草稿建会话标记（v0.2 新增，契约 B §1.5 定稿）：draft=true 且信封 sessionId
   * 省略 → daemon 新建会话聚合落库（首条用户消息即建会话）；sessionId 携带
   * 时忽略本标记（既有会话内发送）。
   */
  draft?: boolean;
  /**
   * 建会话模型（T4，additive）：仅 draft:true 建会话链消费——用户建会话前
   * 选定的模型；缺省 = 全局默认（不换模）。
   */
  model?: string;
  /**
   * 建会话模式（P1 会话模式框架 T2，additive；PROTOCOL-CHANGELOG.md §18）：仅
   * draft:true 建会话链消费——草稿态选定的会话模式（唯一设置入口；建会话
   * 定格锁定，无 mode.set 命令——锁定 = 结构不可能，非校验拒绝）；缺省 =
   * "default"（旧客户端兼容）。字符串透传：未知 mode 由 daemon 模式注册表
   * fallback "default"（T3），协议面不校验注册表成员资格（AD-2 同构）。
   */
  mode?: string;
  /**
   * 图片附件（v0.10 新增，T9 图片上行）：base64 data URL 数组
   * （`data:image/png;base64,…`，≤4 张、单张解码后 ≤2MB——超限 daemon
   * 回中文错误不落消息）；缺省 = 纯文本发送（additive 纪律）。daemon 解码
   * 后转 ImageContent[] 交引擎（agent.prompt(input, images)）。
   */
  images?: readonly string[];
}

/** chat.steer 载荷：生成中注入消息（ChatPort.steer → SteerQueue.enqueue） */
export interface ChatSteerPayload {
  text: string;
  /** 目标实例（v0.3 新增，契约 v0.3 §3）：缺省 = 主实例（既有语义不变）；携带时路由归 ChatService（TR-AD-9） */
  instanceId?: string;
}

/** 无载荷命令的空 payload */
export type EmptyPayload = Record<string, never>;

export interface ChatSendCommand extends CommandFrame<ChatSendPayload> {
  type: "chat.send";
}
export interface ChatSteerCommand extends CommandFrame<ChatSteerPayload> {
  type: "chat.steer";
}
/** 中断当前生成（ChatPort.abort） */
export interface ChatAbortCommand extends CommandFrame<EmptyPayload> {
  type: "chat.abort";
}
/**
 * session.subscribe 载荷（v0.3 新增，契约 v0.3 §2，Q-2b②）：订阅档位。
 * 缺省 full（既有语义不变）；monitor 档白名单过滤归 daemon 事件分发层
 * 一处（T2.2 落地，协议面仅类型）。同连接同会话重复 subscribe 换 tier =
 * 幂等更新，不新增命令对（TR-AD-23①）。
 */
export interface SessionSubscribePayload {
  /** 订阅档位：full = 全量（缺省）；monitor = 3 事件白名单（Q-2a 消息档） */
  tier?: "full" | "monitor";
}

/**
 * 订阅会话事件流。v0.2 升级语义（契约 B §1.2，AD-4）：从「连接级全量广播
 * 开关」升级为「按会话订阅」——**信封 sessionId 必填**，连接订阅某会话后
 * 只收该会话（+系统级）事件帧；v0.3 起 payload 携带可选 tier 档位
 * （SessionSubscribePayload，缺省 full；原 EmptyPayload 形态仍合法）。
 */
export interface SessionSubscribeCommand extends CommandFrame<SessionSubscribePayload> {
  type: "session.subscribe";
}
/** 退订会话事件流（v0 通路语义保留；per-session 语义随 T2.1 定稿） */
export interface SessionUnsubscribeCommand extends CommandFrame<EmptyPayload> {
  type: "session.unsubscribe";
}

// ── v0.1 新增（契约 protocol-v0.1.md §4；AD-7 手动终止权在用户） ──

/** agent.kill 载荷：用户终止实例（抽屉 kill 两步确认后发送） */
export interface AgentKillPayload {
  agentId: string;
}
/** agent.subscribe 载荷：订阅实例全流（v0.1 通路语义，不做事件过滤） */
export interface AgentSubscribePayload {
  agentId: string;
}
/** agent.unsubscribe 载荷：退订实例全流（同上） */
export interface AgentUnsubscribePayload {
  agentId: string;
}

/** 用户终止实例；正常路径回执 agent.killed 事件（单一终态） */
export interface AgentKillCommand extends CommandFrame<AgentKillPayload> {
  type: "agent.kill";
}
/** 订阅实例事件流（v0.1 通路语义：订阅表 + 全广播，见 PROTOCOL-CHANGELOG.md §10.6） */
export interface AgentSubscribeCommand extends CommandFrame<AgentSubscribePayload> {
  type: "agent.subscribe";
}
/** 退订实例事件流（v0.1 通路语义） */
export interface AgentUnsubscribeCommand extends CommandFrame<AgentUnsubscribePayload> {
  type: "agent.unsubscribe";
}

// ── v0.2 新增：session 族（契约 B §1；AD-1 / AD-4） ──

/**
 * 会话清单条目响应（session.list 结果载荷；SessionMeta 同源）。
 * T4.1（CL-5 漂移合一）：与 events.ts SessionListResultPayload 同形双定义收敛为
 * 单定义——权威位 = 事件线形 SessionListResultPayload（session.list.result 实帧
 * 载荷），本名为兼容别名（协议面 additive 纪律 TR-AD-18，不删导出名）。
 */
export type SessionListResult = SessionListResultPayload;

/** session.list 载荷：全局命令（信封 sessionId 省略） */
export interface SessionListCommand extends CommandFrame<EmptyPayload> {
  type: "session.list";
}

/**
 * session.loadHistory 载荷（AD-1 分页回溯）：信封 sessionId 必填；
 * 返回 beforeEntryId 之前的更早历史（时间升序）。
 */
export interface SessionLoadHistoryPayload {
  /** 游标：当前最早 entry id；首页 = 尾窗最早 entry id（快照 DTO 下发） */
  beforeEntryId: string;
  /** 缺省 50（G-1 分页大小），上限 200（防滥用） */
  limit?: number;
}

/** session.loadHistory 结果载荷（code-review M56：收敛为 events 侧载荷的类型别名——T4.1 同规消同形双定义漂移面） */
export type SessionLoadHistoryResult = SessionLoadHistoryResultEventPayload;

export interface SessionLoadHistoryCommand
  extends CommandFrame<SessionLoadHistoryPayload> {
  type: "session.loadHistory";
}

/**
 * session.delete 载荷（Q-4④）：信封 sessionId 必填；payload 空（路由位在
 * 信封）。daemon 顺序硬约束：取消全部执行完成 → 删库 → 注册表移除 →
 * 广播 session.list_changed（T2.2 落地）。
 */
export interface SessionDeleteCommand extends CommandFrame<EmptyPayload> {
  type: "session.delete";
}

// ── v0.2 新增：model 族（契约 C §1；AD-2，G-6 定名） ──

/** model.set 载荷：运行期切换（P-3，F(3.3).2）——信封 sessionId 必填（per-session），下一 turn 生效 */
export interface ModelSetPayload {
  /** "provider/model-id" 完整 id */
  model: string;
}
export interface ModelSetCommand extends CommandFrame<ModelSetPayload> {
  type: "model.set";
}

/** model.get 结果载荷 */
export interface ModelGetResult {
  model: string;
  isDefault: boolean;
  defaultModel: string;
}

/** model.get 载荷：信封 sessionId 必填（per-session） */
export interface ModelGetCommand extends CommandFrame<EmptyPayload> {
  type: "model.get";
}

/** 目录结果载荷（model.catalog / model.catalog_refresh 共用） */
export interface ModelCatalogResult {
  models: CatalogModel[];
  refreshedAt: number;
  source: "cache" | "builtin" | "remote";
}

/** model.catalog 载荷：全局命令（4h 缓存口径，T2.3 落地） */
export interface ModelCatalogCommand extends CommandFrame<EmptyPayload> {
  type: "model.catalog";
}

/** model.catalog_refresh 载荷：绕过 4h 缓存强制拉 pi.dev（失败降级 builtin，响应含说明） */
export interface ModelCatalogRefreshCommand extends CommandFrame<EmptyPayload> {
  type: "model.catalog_refresh";
}

/** model.set_default 结果载荷 */
export interface ModelSetDefaultResult {
  previous: string;
}

/** model.set_default 载荷：全局默认值（无信封 sessionId；SQLite 读面，T2.3 落地） */
export interface ModelSetDefaultPayload {
  model: string;
}
export interface ModelSetDefaultCommand extends CommandFrame<ModelSetDefaultPayload> {
  type: "model.set_default";
}

/**
 * model.set_thinking_default 载荷（R7 全局推理强度兜底批）：全局默认推理
 * 强度——level = 档位字符串透传（pi-ai ThinkingLevel，AD-2）；null = 清除
 *（回退未配置态：各 agent 未配槽位 → 默认关）。与 model.set_default 同构
 *（全局命令，无信封 sessionId；runtime_config 单键存储）。
 */
export interface ModelSetThinkingDefaultPayload {
  level: string | null;
}
export interface ModelSetThinkingDefaultCommand extends CommandFrame<ModelSetThinkingDefaultPayload> {
  type: "model.set_thinking_default";
}

/** model.get_default 结果载荷 */
export interface ModelGetDefaultResult {
  model: string;
}

/** model.get_default 载荷：全局命令 */
export interface ModelGetDefaultCommand extends CommandFrame<EmptyPayload> {
  type: "model.get_default";
}

// ── config 族（压缩参数配置；全局命令，无信封 sessionId；runtime_config 单键 JSON） ──

/** config.set_compaction 载荷：压缩参数（token 绝对值）。 */
export interface ConfigSetCompactionPayload {
  reserveTokens: number;
  keepRecentTokens: number;
}
export interface ConfigSetCompactionCommand extends CommandFrame<ConfigSetCompactionPayload> {
  type: "config.set_compaction";
}

/** config.get_compaction 载荷：全局命令。 */
export interface ConfigGetCompactionCommand extends CommandFrame<EmptyPayload> {
  type: "config.get_compaction";
}

// ── v0.2 新增：auth 管理族（契约 C §1.3；G-6 定名） ──

/** auth.list 结果载荷 */
export interface AuthListResult {
  providers: AuthProviderInfo[];
}

/** auth.list 载荷：全局命令 */
export interface AuthListCommand extends CommandFrame<EmptyPayload> {
  type: "auth.list";
}

/** auth.set_key 结果载荷 */
export interface AuthSetKeyResult {
  keyMasked: string;
}

/** auth.set_key 载荷：daemon 写 ~/.helix/auth.json（0600 + 文件锁）；空 apiKey = 协议层 error */
export interface AuthSetKeyPayload {
  providerId: string;
  apiKey: string;
}
export interface AuthSetKeyCommand extends CommandFrame<AuthSetKeyPayload> {
  type: "auth.set_key";
}

/** auth.delete_key 载荷 */
export interface AuthDeleteKeyPayload {
  providerId: string;
}
export interface AuthDeleteKeyCommand extends CommandFrame<AuthDeleteKeyPayload> {
  type: "auth.delete_key";
}

/** auth.verify 结果载荷：不缓存，每次真实请求（provider 最小请求探活） */
export type AuthVerifyResult =
  | { status: "ok"; latencyMs: number }
  | { status: "fail"; reason: string };

/** auth.verify 载荷 */
export interface AuthVerifyPayload {
  providerId: string;
}
export interface AuthVerifyCommand extends CommandFrame<AuthVerifyPayload> {
  type: "auth.verify";
}

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
  /** 目标 kind：缺省 = 全部 kind（main-session + subagent-worker 双块，序固定）；携带 = 单块。 */
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
  resourceType: "tool" | "skill" | "model" | "thinking";
  /** 资源名（model 型 = "provider/model-id"；thinking 型 = 档位字符串；clear 时忽略）。 */
  name: string;
  /** tool/skill = 启停；model/thinking = set（true）/ clear（false）槽位。 */
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

// ── v0.11 新增：thinking 族（thinking 批 ①，iter-20260823-6ps5 T1.1；AD-2/AD-4，契约 = PROTOCOL-CHANGELOG.md §17.11） ──

/**
 * thinking.set 载荷：会话 thinking 档覆盖（P-1/F1.1）——信封 sessionId 必填
 *（per-session，仿 model.set L170-177 形态），下一 turn 生效。level 为 pi-ai
 * ThinkingLevel 字符串透传（AD-2：helix 不维护第二份档位枚举，SoT 在 pi-ai，
 * 协议层不校验未知档位）；无关闭态（未覆盖 = 不发命令）。chat.send 零字段
 *（AD-4①：thinking 是会话状态非逐消息参数，引擎 turn 开始读解析结果）。
 * 生效回执 = thinking.changed 广播（events/thinking.ts）。
 */
export interface ThinkingSetPayload {
  /** pi-ai ThinkingLevel 字符串透传（如 "medium" / "high"；未知档位由引擎按能力过滤） */
  level: string;
}
export interface ThinkingSetCommand extends CommandFrame<ThinkingSetPayload> {
  type: "thinking.set";
}

// ── kg 批新增（iter-20260825-11fo T5.3，P-1 图谱查看页数据面；v0.11 后 additive 微批，版本位不 bump）──

/**
 * kg 族命令通则（register V-2/V-3）：六命令全部为全局命令（信封 sessionId
 * 省略）；后五个图谱命令携带必填 `project`（项目名或绝对路径，daemon
 * 单点解析——contracts/kg-viewer-api.md 总则），跨项目不串数据；kg.projects
 * 无参（workspace 根 = daemon 启动 cwd，TR-AD-6 零 env 键）。结果 =
 * kg.*.result 点对点回执帧（events/kg.ts；O-6 轮询裁决零推送事件）。
 */
export interface KgListPayload {
  /** 项目名（workspace 一级目录名）或绝对路径（必填）。 */
  project: string;
  kind?: "rule" | "entity";
  status?: "draft" | "confirmed" | "superseded";
  q?: string;
}
export interface KgListCommand extends CommandFrame<KgListPayload> {
  type: "kg.list";
}

export interface KgNodeDetailPayload {
  project: string;
  id: string;
}
export interface KgNodeDetailCommand extends CommandFrame<KgNodeDetailPayload> {
  type: "kg.node.detail";
}

export interface KgChangeReportPayload {
  project: string;
  /** 缺省 = 当前迭代（库内最近一次变更所属迭代）。 */
  iterationId?: string;
}
export interface KgChangeReportCommand extends CommandFrame<KgChangeReportPayload> {
  type: "kg.change.report";
}

export interface KgNodeConfirmPayload {
  project: string;
  id: string;
}
/** 页面唯一写动作（走 F2.3 KgWriteService，非旁路直写）；仅 draft 可转正。 */
export interface KgNodeConfirmCommand extends CommandFrame<KgNodeConfirmPayload> {
  type: "kg.node.confirm";
}

export interface KgIndexStatusPayload {
  project: string;
  /** true = 触发构建/重建（纯 codegraph 机械动作无知识层写，AD-10；absent 态触发即首次构建 B1）。 */
  rebuild?: boolean;
}
export interface KgIndexStatusCommand extends CommandFrame<KgIndexStatusPayload> {
  type: "kg.index.status";
}

export interface KgProjectsCommand extends CommandFrame<EmptyPayload> {
  type: "kg.projects";
}

// ── kg-bootstrap 批新增（iter-20260829-ys7q T3.2，/project 页 bootstrap 数据面五命令；契约 = contracts/kg-bootstrap-api.md）──

/**
 * kg-bootstrap 批通则：五命令全部为全局命令（信封 sessionId 省略），携带
 * 必填 project（项目名或绝对路径，daemon 单点解析）；结果 = kg.*.result
 * 点对点回执帧（events/kg.ts，O-6 零推送同规）。V-1 语义：bootstrap 无
 * draft——产出落盘即 confirmed；修正 = kg.node.update / kg.node.supersede
 * （理由必填，走 KgWriteService 唯一写入口）；连带标记 = kg.bootstrap.impact
 * 只读推导零写。准入机械定义 = 索引 synced/degraded ∧ nodeCount==0（前后端
 * 双保险复核；contracts/kg-bootstrap-api.md §1）。
 */
export interface KgBootstrapCreatePayload {
  /** 项目名（kg.projects 项目标识；daemon 复核准入后调 createTask 同源 API）。 */
  project: string;
  /** 范围参数（可选收窄，进 job.params.scope）。 */
  scope?: string;
}
/** CL-1 F1.1/F1.2：发起 kg-bootstrap 任务（createdBy="page"，与 chat task_create 同源）。 */
export interface KgBootstrapCreateCommand extends CommandFrame<KgBootstrapCreatePayload> {
  type: "kg.bootstrap.create";
}

export interface KgBootstrapProducePayload {
  project: string;
}
/** CL-4 F4.1：产出呈现读面（任务→阶段→批次三级分组，originBatchId+layer 元数据驱动）。 */
export interface KgBootstrapProduceCommand extends CommandFrame<KgBootstrapProducePayload> {
  type: "kg.bootstrap.produce";
}

export interface KgNodeUpdatePayload {
  project: string;
  nodeId: string;
  /** 至少携带其一（空 patch → task.validation_failed）。 */
  digest?: string;
  body?: string;
}
/** CL-4 F4.2 修正写面（一）：内联编辑保存即 updateNode，节点保持 confirmed。 */
export interface KgNodeUpdateCommand extends CommandFrame<KgNodeUpdatePayload> {
  type: "kg.node.update";
}

export interface KgNodeSupersedePayload {
  project: string;
  nodeId: string;
  /** 必填非空（前后端双防线；空 → task.validation_failed）。 */
  reason: string;
}
/** CL-4 F4.2 修正写面（二）：superseded 留史 + change_log 记理由；无转正无否决。 */
export interface KgNodeSupersedeCommand extends CommandFrame<KgNodeSupersedePayload> {
  type: "kg.node.supersede";
}

export interface KgBootstrapImpactPayload {
  project: string;
  /** 被修正（update/supersede）的节点 id。 */
  nodeId: string;
}
/** CL-4 F4.3：受影响连带只读推导（edges 引用方；不落库零自动写）。 */
export interface KgBootstrapImpactCommand extends CommandFrame<KgBootstrapImpactPayload> {
  type: "kg.bootstrap.impact";
}

// ── kg 维护批新增（C1：清空图谱 + 删除索引两命令；全局命令，必填 project）──

export interface KgGraphPurgePayload {
  /** 项目名或绝对路径（daemon 单点解析）。 */
  project: string;
}
/**
 * 清空本项目 kg 库全部内容（知识面 + 符号面 + meta 基准，全量清 + 索引态复位
 * absent——不动 .codegraph，那是 kg.index.delete 的职责）。安全门禁：存在
 * 运行中（running/pending）kg-bootstrap 任务时拒绝（kg.graph.purge_blocked）。
 */
export interface KgGraphPurgeCommand extends CommandFrame<KgGraphPurgePayload> {
  type: "kg.graph.purge";
}

export interface KgIndexDeletePayload {
  /** 项目名或绝对路径（daemon 单点解析）。 */
  project: string;
}
/**
 * 删除项目 .codegraph 索引目录 + kg 索引态复位 absent（联动停 fs-watch
 * watcher；知识层不动——下次 triggerManual 重建索引后符号面自动恢复）。
 */
export interface KgIndexDeleteCommand extends CommandFrame<KgIndexDeletePayload> {
  type: "kg.index.delete";
}

// ── kg.health 批新增（W2-E 轨一结构体检看板；设计 kg-driven-dev-loop-design D5 + R15）──

export interface KgHealthPayload {
  /** 项目名或绝对路径（daemon 单点解析）。 */
  project: string;
}
/**
 * 结构体检五项读面聚合（findConflicts / findOrphans / orphan 计数 / index
 * 状态 / candidates 四态计数）——纯只读零写路径；absent 项目短路返回空态
 * （不建库）。结果 = kg.health.result 点对点回执帧（O-6 零推送同规）。
 */
export interface KgHealthCommand extends CommandFrame<KgHealthPayload> {
  type: "kg.health";
}

// ── kg.candidates.list 批新增（台账读面三件套之三：P-1 台账查看面板数据面；只读零裁决） ──

export interface KgCandidatesListPayload {
  /** 项目名或绝对路径（daemon 单点解析）。 */
  project: string;
  /** 状态过滤（可选四态；缺省全量最新在前）。 */
  status?: "pending" | "deferred" | "applied" | "discarded";
  /** 分页（可选：行数上限 / 跳过行数；缺省全量）。 */
  limit?: number;
  offset?: number;
}
/**
 * 候选台账列表读面（candidates 表 status 过滤 + 分页；行含 body 全文——
 * 选中行展开详情数据源）。只读零写路径——本轮无页面裁决写命令（裁决归
 * kg-review 人审 / decideCandidate）；unbound 防御 = 空集结果非报错
 * （kg.list 同规）。结果 = kg.candidates.list.result 点对点回执帧。
 */
export interface KgCandidatesListCommand extends CommandFrame<KgCandidatesListPayload> {
  type: "kg.candidates.list";
}

// ── kg 评审批新增（W2-F 轨二语义体检任务 kg-review；设计 kg-driven-dev-loop-design D5 + R21/R23）──

export interface KgReviewCreatePayload {
  /** 项目名或绝对路径（daemon 单点解析 + 准入复核：索引存在即可，允许反复发起）。 */
  project: string;
}
/**
 * 发起 kg-review 语义体检任务（type="kg-review"、projects=[project]、
 * params={projectRoot}、createdBy="page"，与 kg.bootstrap.create 同源 createTask）。
 * 与 bootstrap 一次性语义不同：体检面向存量图谱，知识层非空恰是评审对象，
 * 可反复发起；准入从简 = 索引存在（index_absent → kg.review.not_eligible）。
 */
export interface KgReviewCreateCommand extends CommandFrame<KgReviewCreatePayload> {
  type: "kg.review.create";
}

// ── code.review.create（code-review v1.5：P-1 体检区双入口之代码评审发起）──

export interface CodeReviewCreatePayload {
  /** 项目名或绝对路径（daemon 单点解析；准入从简——无索引门槛，允许反复发起）。 */
  project: string;
}
/**
 * 发起 code-review 代码评审任务（type="code-review"、projects=[project]、
 * params={projectRoot}、createdBy="page"，与 kg.review.create 同源 createTask）。
 * 无准入门槛（不要求 .helix-kg 索引——评审对象是代码不是图谱）。
 */
export interface CodeReviewCreateCommand extends CommandFrame<CodeReviewCreatePayload> {
  type: "code.review.create";
}

// ── workspace 批新增（W1 workspace 绑定闭环；契约 = 设计稿 workspace-feature-design-candidate.md §3.1）──

/**
 * workspace.get 载荷：绑定门禁读面（全局命令，无参）。结果帧 =
 * workspace.get.result 点对点回执（TR-AD-21 模式）——前端启动门禁分流
 * 依据（bound → 主壳 / null → 选择页）。无 close/unbind 命令（v1 裁决：
 * 切换 = open 另一 root）。
 */
export interface WorkspaceGetCommand extends CommandFrame<EmptyPayload> {
  type: "workspace.get";
}

/** workspace.open 载荷：显式绑定写面（全局命令）。 */
export interface WorkspaceOpenPayload {
  /** 待绑定的工作空间根（daemon 单点校验：realpath 规范化 + 危险根拒绝）。 */
  root: string;
}
export interface WorkspaceOpenCommand extends CommandFrame<WorkspaceOpenPayload> {
  type: "workspace.open";
}

// ── task 批新增（iter-20260829-ys7q T1.5，P-2 任务页数据面九命令族；契约 = contracts/task-api.md §2）──

/**
 * task 族命令通则：九命令全部为全局命令（信封 sessionId 省略）——任务
 * 是 daemon 级实体非会话作用域。零内容干预（AD-2）：无 steer/批次重试/
 * 内容编辑命令——九命令清单即全集（机械 grep 断言守护）。结果 = 点对点
 * 结果帧（types/task.ts，不入 EVENT_TYPES 目录——契约 §0 计数 57→58
 * 仅 task.changed）；生命周期错误码词表 = 契约 §4（handler 透传引擎
 * TaskError，状态判断收口 T1.3 引擎）。
 */
export interface TaskListPayload {
  /** 状态过滤器（服务端生效；六态枚举，越界 → command.invalid_payload）。 */
  status?: TaskStatus;
  /** 项目过滤器（AD-8：0..n 项目标签之一；服务端生效）。 */
  project?: string;
}
export interface TaskListCommand extends CommandFrame<TaskListPayload> {
  type: "task.list";
}

export interface TaskDetailPayload {
  jobId: string;
}
export interface TaskDetailCommand extends CommandFrame<TaskDetailPayload> {
  type: "task.detail";
}

export interface TaskArtifactsPayload {
  jobId: string;
}
/** 结果只读查询（F3.4）：节点详情/修正转 /project 页（AD-10）。 */
export interface TaskArtifactsCommand extends CommandFrame<TaskArtifactsPayload> {
  type: "task.artifacts";
}

export interface TaskSubscribePayload {
  /** 缺省 = 订阅全部任务变更（通配档；连接级订阅表机械定义）。 */
  jobId?: string;
}
/** 连接级订阅（F3.2 WS 实时推送；订阅表登记 → task.changed 按连接过滤投递）。 */
export interface TaskSubscribeCommand extends CommandFrame<TaskSubscribePayload> {
  type: "task.subscribe";
}

export interface TaskUnsubscribePayload {
  /** 缺省 = 清空订阅集与通配档（对称语义）。 */
  jobId?: string;
}
export interface TaskUnsubscribeCommand extends CommandFrame<TaskUnsubscribePayload> {
  type: "task.unsubscribe";
}

export interface TaskPausePayload {
  jobId: string;
}
/** 暂停（F3.5；仅 running → paused 合法——O-2 停派新批次+在跑自然收口；非法态 → task.invalid_state 引擎透传）。 */
export interface TaskPauseCommand extends CommandFrame<TaskPausePayload> {
  type: "task.pause";
}

export interface TaskResumePayload {
  jobId: string;
}
/** 恢复（仅 paused → running；与断点恢复同路径）。 */
export interface TaskResumeCommand extends CommandFrame<TaskResumePayload> {
  type: "task.resume";
}

export interface TaskCancelPayload {
  jobId: string;
}
/** 取消（running/paused/pending → cancelled 终态；在跑批次 SIGTERM）。 */
export interface TaskCancelCommand extends CommandFrame<TaskCancelPayload> {
  type: "task.cancel";
}

export interface TaskRetryPayload {
  jobId: string;
}
/** 人工重试（仅 failed → running 复活：批次重试预算归零留痕 + 失败阶段重开 + 重开编排——token 耗尽换 key 后续跑场景，已 done 阶段/批次不动）。 */
export interface TaskRetryCommand extends CommandFrame<TaskRetryPayload> {
  type: "task.retry";
}

export interface TaskDeletePayload {
  jobId: string;
}
/** 删除（F3.6：仅终态 done/failed/cancelled 可删；清任务域记录不触 kg 产出；判断收口引擎）。 */
export interface TaskDeleteCommand extends CommandFrame<TaskDeletePayload> {
  type: "task.delete";
}

/** 命令信封联合（判别式：type 字段窄化；v0.2：8 → 21；v0.4：21 → 22；v0.6：22 → 24；v0.7：24 → 26；v0.9：26 → 27；v0.11：27 → 28；kg 批：28 → 34；workspace 批：34 → 36；task 批：36 → 45；kg-bootstrap 批：45 → 50；kg 维护批：50 → 52；kg.health 批 + kg 评审批：52 → 54；kg.candidates.list 批：54 → 55；base prompt 批：55 → 56） */
export type CommandEnvelope =
  | ChatSendCommand
  | ChatSteerCommand
  | ChatAbortCommand
  | SessionSubscribeCommand
  | SessionUnsubscribeCommand
  | AgentKillCommand
  | AgentSubscribeCommand
  | AgentUnsubscribeCommand
  | SessionListCommand
  | SessionLoadHistoryCommand
  | SessionDeleteCommand
  | ModelSetCommand
  | ModelGetCommand
  | ModelCatalogCommand
  | ModelCatalogRefreshCommand
  | ModelSetDefaultCommand
  | ModelSetThinkingDefaultCommand
  | ModelGetDefaultCommand
  | ConfigSetCompactionCommand
  | ConfigGetCompactionCommand
  | AuthListCommand
  | AuthSetKeyCommand
  | AuthDeleteKeyCommand
  | AuthVerifyCommand
  | TraceQueryCommand
  | AgentConfigListCommand
  | AgentConfigSetEnabledCommand
  | AgentBasePromptGetCommand
  | WebStatusCommand
  | WebStopCommand
  | WebStartCommand
  | ThinkingSetCommand
  | KgListCommand
  | KgNodeDetailCommand
  | KgChangeReportCommand
  | KgNodeConfirmCommand
  | KgIndexStatusCommand
  | KgProjectsCommand
  | KgBootstrapCreateCommand
  | KgBootstrapProduceCommand
  | KgNodeUpdateCommand
  | KgNodeSupersedeCommand
  | KgBootstrapImpactCommand
  | KgGraphPurgeCommand
  | KgIndexDeleteCommand
  | KgHealthCommand
  | KgReviewCreateCommand
  | CodeReviewCreateCommand
  | KgCandidatesListCommand
  | WorkspaceGetCommand
  | WorkspaceOpenCommand
  | TaskListCommand
  | TaskDetailCommand
  | TaskArtifactsCommand
  | TaskSubscribeCommand
  | TaskUnsubscribeCommand
  | TaskPauseCommand
  | TaskResumeCommand
  | TaskCancelCommand
  | TaskRetryCommand
  | TaskDeleteCommand;

/** 命令目录常量（运行时可用；与 CommandEnvelope 联合由测试双向一致性守护） */
export const COMMAND_TYPES = [
  "chat.send",
  "chat.steer",
  "chat.abort",
  "session.subscribe",
  "session.unsubscribe",
  "agent.kill",
  "agent.subscribe",
  "agent.unsubscribe",
  "session.list",
  "session.loadHistory",
  "session.delete",
  "model.set",
  "model.get",
  "model.catalog",
  "model.catalog_refresh",
  "model.set_default",
  "model.set_thinking_default",
  "model.get_default",
  "config.set_compaction",
  "config.get_compaction",
  "auth.list",
  "auth.set_key",
  "auth.delete_key",
  "auth.verify",
  "trace.query",
  "agent.config.list",
  "agent.config.set_enabled",
  "agent.base_prompt.get",
  "web.status",
  "web.stop",
  "web.start",
  "thinking.set",
  "kg.list",
  "kg.node.detail",
  "kg.change.report",
  "kg.node.confirm",
  "kg.index.status",
  "kg.projects",
  "kg.bootstrap.create",
  "kg.bootstrap.produce",
  "kg.node.update",
  "kg.node.supersede",
  "kg.bootstrap.impact",
  "kg.graph.purge",
  "kg.index.delete",
  "kg.health",
  "kg.review.create",
  "code.review.create",
  "kg.candidates.list",
  "workspace.get",
  "workspace.open",
  "task.list",
  "task.detail",
  "task.artifacts",
  "task.subscribe",
  "task.unsubscribe",
  "task.pause",
  "task.resume",
  "task.cancel",
  "task.retry",
  "task.delete",
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];
