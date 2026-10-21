/**
 * StewardService 接线面类型集合（体量门 P4：自 StewardService.ts 原样迁出）。
 *
 * 纯类型面（零运行时代码）：依赖注入面 StewardServiceDeps 与各感知/投递/
 * 记忆窄接口，加引擎装配入参与 ask 载体内。门面 StewardService.ts 精确
 * 再导出——消费方 import 路径与符号零变化。
 */

import type { RuntimeConfigPort } from "../ports/outbound/RuntimeConfigPort";
import type { AgentOrchestrationPort } from "../ports/inbound/AgentOrchestrationPort";
import type { StewardLlmPort, StewardLlmMessage } from "../ports/outbound/StewardLlmPort";
import type { AgentEngineEvent, AgentEngineListener, AgentEnginePort } from "../ports/outbound/AgentEnginePort";
import type { StewardToolSpec } from "../ports/outbound/StewardToolSpec";
import type { StewardSurfacePort } from "../ports/outbound/StewardSurfacePort";
import type {
  StewardActionCompletedPayload,
  StewardAskResultPayload,
  StewardFeedPayload,
  StewardMemoryWrittenPayload,
  StewardNavigatePayload,
  StewardNotifyPayload,
  StewardProactivePayload,
} from "@helix/protocol";
import type { StewardDialogMemory } from "./StewardDialogMemory";
import type { StewardMemoryService } from "./StewardMemoryService";
import type { TriageJudgeFace } from "./StewardTriageJudge";
import type { IntentJudgeFace } from "./StewardIntentJudge";
import type { StewardTuning } from "../../domain/steward/tuning/StewardTuning";

/** 挂闸校验上下文（中立——原 GateToolContext 的 application 形态）。 */
export interface GateToolContext {
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
}

/** 挂闸校验结果（中立——原 {pause, outcome} 判别：result/terminate 两出口）。 */
export type GateToolOutcome =
  | { readonly kind: "result"; readonly text: string; readonly isError?: boolean }
  | { readonly kind: "terminate"; readonly reason: string };

/** ask 过程事件面（A1 批：工具/thinking 过程对屏幕通道可见；由 handler 层
 *  接帧——点对点仅发发起连接。TTS 播报链路零接入（耳朵只听 assistant 结论）。 */
export interface StewardAskEvents {
  /** 文本生成段增量（V2.5 体验批）。 */
  readonly onDelta?: (chunk: string) => void;
  /** thinking 段级（一个完成态块一帧全量文本）。 */
  readonly onThinking?: (block: string) => void;
  /** 工具开始（name + 参数摘要）。 */
  readonly onToolStart?: (name: string, argsSummary: string) => void;
  /** 工具结束（name + 结果摘要）。 */
  readonly onToolEnd?: (name: string, resultSummary: string) => void;
}

/** 任务清单读面窄接口（TaskQueryService.listTasks 注入）。 */
export interface StewardTasksSource {
  listTasks(filter: { status?: string }): readonly {
    jobId: string;
    title: string;
    status: string;
    /** 任务类型（= skill 名）；缺省消费面回落 "task"（additive——旧读面/测试
     *  替身不携带）。 */
    type?: string;
    /** 归属项目徽章（projects 过滤判据）；缺省 = 无归属（additive）。 */
    projects?: readonly string[];
    /** 创建时间（ISO；时间窗过滤判据）；缺省 = 不入窗（additive）。 */
    createdAt?: string;
    progress: { stageName: string | null; batchesDone: number; batchesTotal: number; percent: number } | null;
    error: string | null;
  }[];
}

/** A2：会话元数据行（session_state 轻量读面——SessionRepositoryPort
 *  .listSessionMetadata 同形，additive entryCount 消息量级 + title 显式标题列）。 */
export interface StewardSessionMetaRow {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** 首条用户消息全文（title 推导源）；无用户消息的持久化会话为 null。 */
  readonly firstUserText: string | null;
  /** 显式会话标题（L1 投影修复批：createTitledSession 定格；投影优先于
   * firstUserText 推导；additive——旧数据源缺省不携带）。 */
  readonly title?: string;
  /** 阶段演进主题（动态主题批：轮次锚点矫正产生；displayTitle 优先级
   * title > topic > firstUserText；additive——旧数据源缺省不携带）。 */
  readonly topic?: string;
  /** 消息条目量级（json_array_length(entries)；查询面不可得 = null）。 */
  readonly entryCount: number | null;
}

/** A2：L1 感知面（情景快照 + query_recent_work 数据源；快照降级容忍缺席）。 */
export interface StewardSessionsSource {
  /** 会话元数据轻量读面（updated_at 倒序）。 */
  listSessionMetadata(): Promise<readonly StewardSessionMetaRow[]>;
  /** 会话创建（SessionDirectoryPort.startDraftSession 同款窄面——与 shell
   *  新建会话同一条服务路径；text = 首条消息文本兼 title 推导源）。 */
  startDraftSession(text: string, mode?: string): Promise<{ sessionId: string }>;
  /** 显式建标题会话（修复批① 死锁链）：同轨不同入口——createFresh 同一
   *  构造路径，但不发送任何消息不点火引擎；零条目即 INSERT 一等可见，
   *  title 进 meta 列（首条消息派生不覆盖）。createSession 执行体改调本面
   *  （对照事故：startDraftSession(title) 把 title 当首条用户消息发送，
   *  触发完整幽灵 agent run）。 */
  createTitledSession(title: string): Promise<{ sessionId: string }>;
  /** 会话存在性（驾驶舱批：deliver_to_session 提案前引导式校验——不存在
   *  即拒绝提案，引导 LLM 用 query_recent_work 重查）。 */
  sessionExists(sessionId: string): Promise<boolean>;
  /** 轻量单会话标题查询（语音闭环批 ④：投递提案/回执念短标题——title >
   *  topic > firstUserText，缺席 = undefined 回退 sessionId；避免全量
   *  listSessionMetadata 拉表）。 */
  sessionTitleOf?(sessionId: string): Promise<string | undefined>;
  /** session 级投递执行面（驾驶舱批；确认闸后调用）：把用户输入投进目标
   *  会话——复用主会话 steer 机制（运行中 → steer 队列；空闲 → 新轮次，
   *  与用户在该会话页直接输入同语义）。delivered=false = 拒绝（detail 含
   *  引导）；成功后由调用方广播 steward.navigate 切页。 */
  deliverToSession(sessionId: string, text: string): Promise<{ delivered: boolean; detail: string }>;
  /** 尾部消息投影读面（progress 批 M3——read_session 工具数据源）：单会话
   *  最后 N 条 {role, text}（旧→新；opts 参数化批——entryOffset 翻页 /
   *  maxEntryChars 单条截断覆盖，缺省 repo 层截 300）；sessionId 不存在
   *  = undefined（引导层判据）。 */
  readSessionTail(
    sessionId: string,
    tailEntries: number,
    opts?: { entryOffset?: number; maxEntryChars?: number },
  ): Promise<readonly { role: string; text: string }[] | undefined>;
}

/** A2：kg 项目解析面（KgProjectService 同款窄接口——spawn_review_task
 *  前置校验：项目存在性 + .kg 索引判定）。 */
export interface StewardProjectsSource {
  /** 项目名/绝对路径 → projectRoot；不在 workspace 扫描全集 = undefined。 */
  resolve(project: string): string | undefined;
  /** projectRoot 有 .helix-kg/kg.db（读面绝不新建库）。 */
  hasIndex(projectRoot: string): boolean;
}

/** 批A（管家开放 kg 只读工具）：项目知识只读检索面——实现体 = adapters/
 *  driven/tools/kg/StewardKgTool.ts createStewardKgSource（复用 createKgTool
 *  语义：search = digest+指针形态摘要行 / get = 节点全量；全链路零写——
 *  本域不提供任何 kg 写原语，写面不进管家工具面）。渲染文本直接过
 *  capToolResultText 体量护栏。 */
export interface StewardKgSource {
  /** 当前 kg 项目域（已建 .helix-kg 的项目根列表，workspace-scan/scanProjects
   *  口径；空集 = absent 判定源——引导式降级，读面绝不新建库文件）。 */
  kgProjects(): readonly string[];
  /** 关键词检索（渲染文本）：projectRoot 缺省 = kg 项目域聚合（多项目分块
   *  带【项目】头——调用方 resolveKgScope 已按当前项目口径先行解析，缺省
   *  仅多项目/未绑定时到达）；指定 = 单项目范围。 */
  search(q: string, projectRoot?: string): Promise<string>;
  /** 节点全量读取（渲染文本）：nodeId 形态校验/查无节点在实现体抛中文引导
   *  错，执行体兜底转文本不抛错不炸轮。 */
  get(nodeId: string, projectRoot?: string): Promise<string>;
}

export interface StewardServiceDeps {
  readonly llm: StewardLlmPort;
  /** 编排面（status 只读 + send 写注入——agent_send 等价 steer 通道）。 */
  readonly orchestration: Pick<AgentOrchestrationPort, "status" | "send">;
  /** 任务清单只读面（TaskQueryService 注入）。 */
  readonly tasks: StewardTasksSource;
  /** 运行时配置 KV（开关 + 模型槽位持久化；缺省时同时充当工作记忆底座）。 */
  readonly config: RuntimeConfigPort;
  /** 工作记忆 KV（缺省 = StewardDialogMemory(config)——A1 批完整记录持久化）。 */
  readonly dialog?: StewardDialogMemory;
  /** 时钟（记录 at 时间戳；缺省 Date.now）。 */
  readonly clock?: () => number;
  /** 行为阈值现拍面（批 0 配置域：组合根接 resolveStewardTuning(runtimeConfig)
   *  运行期即热；缺省 = STEWARD_TUNING_DEFAULTS 即原硬编码常量——零注入零
   *  行为变化）。测试注入字面量免 mock 时钟跳拍。 */
  readonly tuningOf?: () => StewardTuning;
  /** feed 闸门读面（EventStream 连接级 steward 订阅表窄接口）。 */
  readonly feedGate: { hasStewardSubscribers(): boolean };
  /** feed 帧出口（组合根接 EventStream.broadcastStewardFeed）。 */
  readonly emitFeed: (payload: StewardFeedPayload) => void;
  /** 记忆落盘通知帧出口（memory_written 通知卡链；组合根接 EventStream
   *  .broadcastStewardMemoryWritten——与 feed 同订阅闸；缺席 = 落盘零通知
   *  （语义面零降级，仅通知缺席）。 */
  readonly emitMemoryWritten?: (payload: StewardMemoryWrittenPayload) => void;
  /** 页面导航出口（M0 表面协议地基批收编：组合根接 SurfaceRegistry
   *  .act("navigate")——deliver_to_session 受理 / create_session 建成后
   *  路由 surface.action {verb:"navigate"}；旧 steward.navigate 帧由 Registry
   *  兼容镜像双发，M1 前检查点删除。域层纯 payload 端口零组帧。
   *  缺席 = 无切页指令（语义面零降级，仅行为缺席）。 */
  readonly emitNavigate?: (payload: StewardNavigatePayload) => void;
  /** M2 表面消费面（四泛型工具 surface_list/snapshot/read/act 执行体——
   *  StewardSurfacePort；act 经确认闸后走同一动作管道）。缺席 = 四工具
   *  引导式降级（零抛错，对话主链路不受影响）。 */
  readonly surfaces?: StewardSurfacePort;
  /** A2：L1 感知面（快照 + query_recent_work + create_session 执行面）。
   *  缺席 = 无快照段/query_recent_work 降级提示/create_session 引导式不可用
   *  ——感知查询绝不能挡住对话主链路（缺席零抛错）。 */
  readonly sessions?: StewardSessionsSource;
  /** A2：kg 项目解析面（spawn_review_task 前置校验；缺席 = 项目校验降级
   *  为存在性未知，直接进确认闸）。 */
  readonly projects?: StewardProjectsSource;
  /** 批A：kg 只读检索面（kg_search/kg_get 执行体——StewardKgSource；
   *  缺席 = 引导式降级（零抛错），对话主链路零影响。 */
  readonly kg?: StewardKgSource;
  /** A2：任务创建面（task_create 同款引擎通道——paramsSchema 校验在引擎，
   *  TaskError message 原样透传；method 语法容忍 CreateTaskInput 逆变）。 */
  readonly taskEngine?: {
    createTask(input: {
      type: string;
      projects: readonly string[];
      params: Record<string, unknown>;
      createdBy: "page" | "chat" | "auto";
    }): Promise<{ jobId: string }>;
  };
  /** A2：code-review 前置校验——项目 git 仓存在性（组合根 fs 注入；
   *  application 零直接 IO）。 */
  readonly hasGitRepo?: (projectRoot: string) => boolean;
  /** 引擎构造工厂（段B翻转：唯一配方 buildStewardEngine 的 application 面——
   *  生产装配（组合根）与测试（剧本 streamFnOverride）共用同一 driven 配方；
   *  首问时懒调用（dialog 回填 initialMessages 需懒加载后取）。 */
  readonly createEngine: (opts: StewardEngineAssemblyOptions) => AgentEnginePort;
  /** 引擎事件出口（追踪可见性——组合根接 domain_events 投影：
   *  AgentEngineEvent → DomainEvent{instanceId:"steward"} 落库；缺席 =
   *  零落库零广播，对话主链路零降级）。 */
  readonly emitEngineEvent?: (event: AgentEngineEvent) => void;
  /** 压缩参数覆盖（thresholdTokens/keepRecent 缺省回落导出常量；本体能力
   *  = pi CompactionHook（turn 边界）经 createEngine 装配——同轨共享钩子）。 */
  readonly compaction?: { readonly thresholdTokens?: number; readonly keepRecent?: number };
  /** 管家记忆 B1：长期记忆编排面（召回段注入 + remember 执行体 + 配置读写）。
 *  缺席 = 记忆整体降级不可用（recall 零段/remember 引导拒/配置面
 *  available=false）——对话主链路零影响。 */
  readonly memory?: StewardMemoryService;
  /** 分诊判官配置与判定面（分诊判官接入批：steward.set_config {triage}
 *  组读写 + 感知服务判定依赖同源真体；缺席 = triage 组读写降级不可用
 *  + 判定面不启用——回退现行 LLM JSON 路径）。 */
  readonly triageJudge?: TriageJudgeFace;
  /** M3-a 意图判别判定面（判官第五消费面——词表未命中 ∧ pending 卡在场
   *  时的泛化判定：确认/取消/修正三问 noul 分流；缺席/关闭/未配/抛错 →
   *  回退词表后行为（原样走 LLM），零劣化。与分诊判官共享开关与端点
   *  （组合根 makeIntentJudgeFace 单源闭包）。 */
  readonly intentJudge?: IntentJudgeFace;
  /** 当前项目口径解析（项目隔离批引入；kg 缺省范围批起双消费面）：返回
 *  workspace 一级项目目录名（workspace 绑定根 + 一级目录扫描的单项目口径
 *  ——记忆召回与 kg_search/kg_get 缺省范围共用同源，不另造口径判定）；多
 *  项目/未绑定/未注入 → undefined = 召回只 global / kg 缺省聚合兑底。 */
  readonly memoryProject?: () => string | undefined;
  /** M3-d1 感知兑现批：最近活动条目读面（活动账白话行——组合根接
   *  StewardActivityService.recent(N)；快照活动段数据源。**静默降级**：
   *  读面抛错/缺席 → 快照仅基础段（assembleStewardSystemPrompt 附加段
   *  缺席 = 原样静态段语义），绝不阻塞对话主链路。） */
  readonly recentActivity?: () => readonly { at: number; domain: string; attribution: string; text: string }[];
  /** 管家感知批（M0.5）：用户 ask 活动信号（感知服务激活衰减窗点亮——
   *  响应环点亮主动环，D12-⑪；组合根接 StewardPerceptionService
   *  .noteUserActivity；缺席 = 零信号）。 */
  readonly onUserActivity?: () => void;
  /** 回合终态感知批：投递成功回调（感知服务投递关注注册——该会话回合
   *  结束即命中分诊锚「那边回完了」；组合根接 noteDelivered；缺席 =
   *  零关注注册，回合终态只入 ring 零 LLM）。 */
  readonly onDelivered?: (sessionId: string, text?: string) => void;
  /** 可靠性批：生命周期日志（run 开始/收口/挂闸暂停 info + 看门狗/TTL warn；
   *  info 可选——旧装配只带 warn 时降级只出 warn）。 */
  readonly logger?: { info?(message: string): void; warn(message: string): void };
  /** 可靠性批：确认卡 TTL 作废的 action.completed 广播出口（组合根接
   *  EventStream.broadcastStewardActionCompleted——与 feed 同订阅闸，多窗
   *  卡栈同步收口；缺席 = 作废仅 daemon 侧簿记零广播）。 */
  readonly emitActionCompleted?: (payload: StewardActionCompletedPayload) => void;
  /** 可靠性批：用户提醒出口（挂起恢复/确认可达性/TTL 作废三提醒帧——组合根
   *  接 EventStream.broadcastStewardNotify；缺席 = 零提醒）。 */
  readonly emitNotify?: (payload: StewardNotifyPayload) => void;
  /** 光球健康角标批：子系统健康上报出口（组合根接
   *  EventStream.reportStewardHealth——同态去重在出口把门；缺席 = 零帧）。
   *  触发面：judge（判官降级/恢复）/ llm（run 级失败/恢复）。 */
  readonly emitHealth?: (
    component: "judge" | "tts" | "stt" | "llm",
    status: "degraded" | "ok",
    reason?: string,
  ) => void;
  /** M3-a：对话内主动汇报实时帧出口（CAND-601 闭环——组合根接
   *  EventStream.broadcastStewardProactive；缺席 = 零帧，工作记忆记录照写
   *  ——语义面零降级，仅实时性缺席）。 */
  readonly emitProactive?: (payload: StewardProactivePayload) => void;
}

/** 挂闸中待确认项（pause 态的 resume 凭据 + 提案动作——actionId 单次消费）。 */
// PendingEntry 已迁确认闸聚合域（domain/steward/confirmation——批 1）。

/** 排队 ask 项（方案甲自持队列——E-197 行为等价：上限/收口后自动下一轮/
 *  queued 双帧回执；events/deliver 是应用面载荷（pi followUp 队列不自动
 *  开 run——E-239，自持队列 + agent_end 驱动）。 */
export interface StewardAskItem {
  readonly text: string;
  readonly events: StewardAskEvents;
  readonly deliver?: (payload: StewardAskResultPayload) => void;
}

/** 引擎装配上下文（createEngine 入参——application 中立形状，driven 侧
 *  buildStewardEngine 唯一配方消费）。 */
export interface StewardEngineAssemblyOptions {
  readonly systemPrompt: string;
  readonly tools: readonly StewardToolSpec[];
  readonly gatedTools: ReadonlySet<string>;
  readonly persistentListener: AgentEngineListener;
  readonly initialMessages: readonly StewardLlmMessage[];
  readonly compaction?: {
    readonly thresholdTokens: number;
    readonly keepRecent: number;
    readonly summarizeInstructions?: string;
    /** 触发档位（缺省 request——管家纯问答轮也压）。 */
    readonly trigger?: "turn" | "request";
    /** 摘要单轮执行体（缺省 = deps.llm.complete 无工具形态）。 */
    readonly summarize?: (systemPrompt: string, messages: readonly StewardLlmMessage[]) => Promise<string>;
  };
}
