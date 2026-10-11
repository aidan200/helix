import path from "node:path";
import { existsSync } from "node:fs";
import type { SessionChatPort } from "../application/ports/inbound/ChatPort";
import type { SessionPort } from "../application/ports/inbound/SessionPort";
import type { SystemPort } from "../application/ports/inbound/SystemPort";
import type { AgentOrchestrationPort } from "../application/ports/inbound/AgentOrchestrationPort";
import type { SessionDirectoryPort } from "../application/ports/inbound/SessionDirectoryPort";
import type { TaskEnginePort } from "../application/ports/inbound/TaskEnginePort";
import type { TaskQueryService } from "../application/services/task/TaskQueryService";
import type { ClockPort } from "../application/ports/outbound/ClockPort";
import type { BrowserPort } from "../application/ports/outbound/BrowserPort";
import type { ModelPort } from "../application/ports/inbound/ModelPort";
import type { InstanceRunner } from "../application/services/InstanceRunner";
import { SessionRegistry } from "../application/services/SessionRegistry";
import type { WriteFactRegistry } from "../application/services/WriteFactRegistry";
import { ResourceService } from "../application/services/ResourceService";
import { WsServerAdapter } from "../adapters/driving/ws-server/WsServerAdapter";
import { SurfaceRegistry } from "../application/surface/SurfaceRegistry";
import { SurfaceActionService } from "../application/surface/SurfaceActionService";
import type { FrameSender } from "../adapters/driving/ws-server/EventStream";
import { webStatusPayloadOf } from "../adapters/driving/ws-server/handlers/web";
import { lastMainAnchorId, type AnchorScanEntry } from "@helix/protocol"; // 锚扫描基元单源 projection
import { isMainInstanceId } from "../domain/agent/AgentInstance";
import { SubagentLauncher } from "../adapters/driven/subagent/SubagentLauncher";
import { CdpConnectionManager } from "../adapters/driven/cdp/CdpConnectionManager";
import { BrowserSurfaceAdapter, SURFACE_AWARENESS_KEY } from "../adapters/driven/cdp/BrowserSurfaceAdapter";
import { createPaths, osHomeDir, builtinSkillsDir, type HelixPaths } from "./paths";
import { ensureConfigTemplate, loadConfig, type DaemonConfig, type LegacyModelConfig } from "./config";
import type { PortConfigPort } from "../application/ports/outbound/PortConfigPort";
import { McpRegistry } from "../adapters/driven/mcp/McpRegistry";
import { buildEditToolDeps, buildKnowledgeStack } from "./assembly/buildKnowledgeStack";
import { createOrchestratorSessionFactory } from "./assembly/orchestrator-runtime";
import { TaskOrchestratorService } from "../application/services/task/TaskOrchestratorService";
import type { TaskOrchestratorStarterPort } from "../application/ports/outbound/TaskOrchestratorStarterPort";

/** W2-D R13 job 终态同步提示文案随编排服务切片迁 assembly/buildTaskOrchestrator（M29）。 */
import { scanWorkspaceProjects, scanProjectEntries, existingKgProjects } from "../adapters/driven/workspace-scan";
import { createStewardKgSource } from "../adapters/driven/tools/kg/StewardKgTool";
import type { ClosureFindingsSink } from "../application/services/scheduler/ClosureRecorder";
import { rm, readFile } from "node:fs/promises";
import { createFileLogger, type Logger } from "./logging";
import { acquireSingletonLock, installCrashLogging, type SingletonLock } from "./lifecycle";
import { buildPersistence } from "./assembly/buildPersistence";
import { AskService } from "../application/services/AskService";
import type { SessionRunStateLike } from "../domain/agent/ObservabilityState";
import { buildModelStack } from "./assembly/buildModelStack";
import { buildTaskStack } from "./assembly/buildTaskStack";
import { buildKgResolverGroup } from "./assembly/buildKgResolverGroup";
import { buildTaskOrchestrator } from "./assembly/buildTaskOrchestrator";
import { buildCliDriving, buildWsDriving } from "./assembly/buildDrivingAdapters";
import { freezeSearchBackends, migrateLegacyModelConfig, migrateLegacyRuntimeConfig, resolveWsPort } from "./assembly/bootPrelude";
import { hasActiveJob } from "../application/services/kg/job-activity";
import type { TaskStorePort } from "../application/ports/outbound/TaskStorePort";
import { buildSessionStack, type AssemblyBackfill, type EngineAssemblyMode, type MainSessionLlmOverride } from "./assembly/buildSessionStack";
import { singleProjectDirOf } from "./assembly/singleProjectDir";
import { SkillScanner } from "../adapters/driven/pi-engine/SkillScanner";
import { FanoutPublisher, wireEventFanout, type NamedFanoutTarget } from "./assembly/wireEventFanout";
import { DashScopeTtsAdapter, DASHSCOPE_PROVIDER_ID as DASHSCOPE_TTS_PROVIDER_ID } from "../adapters/driven/tts/dashscope";
import { DashScopeStreamingTtsAdapter } from "../adapters/driven/tts/streaming";
import { TtsStreamService } from "../application/tts/TtsStreamService";
import { BroadcastService } from "../application/voice/BroadcastService";
import {
  StewardService,
  STEWARD_ENABLED_KEY,
  STEWARD_MODEL_KEY,
  formatDeliverReceipt,
  SNAPSHOT_ACTIVITY_MAX_ENTRIES,
} from "../application/steward/StewardService";
import {
  SessionSummaryService,
  recentUserTextsOf,
  recentTurnPairsOf,
} from "../application/services/session-summary/SessionSummaryService";
import { SummaryConfigStore } from "../adapters/driven/sqlite-session/SummaryConfigStore";
import { KgConfigStore } from "../adapters/driven/sqlite-session/KgConfigStore";
import {
  KG_SIMILARITY_DUP_DEFAULT,
  KG_SIMILARITY_WARN_DEFAULT,
} from "../application/services/kg/kgConfig";
import { migrateLegacySummaryKeys, readSummaryConfig } from "../application/summary/summaryConfig";
import type { DomainEvent } from "../domain/events/DomainEvent";import {
  StewardMemoryService,
  STEWARD_MEMORY_EMBEDDING_KEY,
} from "../application/steward/StewardMemoryService";
import {
  MEMORY_ENDPOINT_ID_KEY,
  MEMORY_JUDGE_ENDPOINT_ID_KEY,
  migrateLegacyStewardMemoryKeys,
  migrateMemoryEndpointToDefault,
} from "../application/memory/memoryConfig";
import {
  EmbeddingConfigService,
} from "../application/embedding/EmbeddingConfigService";
import { CustomProviderService } from "../application/services/CustomProviderService";
import { OpenAiCompatEmbeddingAdapter } from "../adapters/driven/embedding/OpenAiCompatEmbeddingAdapter";
import { makeJudgeAdapter } from "../adapters/driven/embedding/JudgeAdapterFactory";
import { makeTriageJudgeFace, resolveTriageJudgeRecord } from "../application/steward/StewardTriageJudge";
import { makeIntentJudgeFace } from "../application/steward/StewardIntentJudge";
import { SqliteVecMemoryStore } from "../adapters/driven/steward-memory/SqliteVecMemoryStore";
import { SqliteStewardDialogStore, migrateStewardDialogKv } from "../adapters/driven/steward-memory/SqliteStewardDialogStore";
import { SqliteActivityLedgerStore } from "../adapters/driven/steward-memory/SqliteActivityLedgerStore";
import { StewardActivityService } from "../application/steward/StewardActivityService";
import { StewardDialogMemory } from "../application/steward/StewardDialogMemory";
import { resolveVec0Path } from "../adapters/driven/steward-memory/resolve-vec0";
import { getLoadablePath as sqliteVecLoadablePath } from "sqlite-vec";
import type { StewardLlmPort } from "../application/ports/outbound/StewardLlmPort";
import { PiStewardLlmAdapter, STEWARD_DEFAULT_MODEL } from "../adapters/driven/loop/PiStewardLlmAdapter";
import { buildStewardEngine } from "../adapters/driven/steward/StewardEngineBuilder";
import { resolveModel } from "../adapters/driven/llm";
import { stewardEngineTraceBridge } from "./assembly/stewardEngineTraceBridge";
import { StewardDiagnosisAdapter } from "../adapters/driven/voice/StewardDiagnosisAdapter";
import type { StewardDiagnosisPort } from "../application/ports/outbound/StewardDiagnosisPort";
import { StewardPerceptionService } from "../application/steward/StewardPerceptionService";
import type { StewardComponent } from "../application/steward/StewardComponent";
import { resolveStewardTuning } from "../domain/steward/tuning/StewardTuning";
import type { TtsPort } from "../application/ports/outbound/TtsPort";
import { createResourceEventBus, type ResourceEventBus } from "./assembly/resource-events";
import { WorkspaceService } from "../application/services/workspace/WorkspaceService";
import { createWorkspaceFs } from "../adapters/driven/workspace-fs";

/**
 * 组合根（architecture.md §3.6）：整个 daemon 唯一允许 new 具体实现的地方
 * （AG-02④ 豁免面 = 本文件 + infrastructure/assembly/**——组合根锚面从
 * 单文件扩为目录，语义不变）。依赖图在这里闭合：driven adapter → service →
 * driving adapter 接线，四层内部只见接口。
 *
 * 组合根工厂化（AD-4）：会话相关件（Session 聚合 + ChatService 族 +
 * 会话投影 + 会话绑定引擎/工具）经 SessionRegistry 按需创建/卸载
 * （buildSessionStack 的 buildRuntime/engineFor 工厂是唯一 new 面）；
 * 会话无关全局件（调度器/事件总线/存储/WS 服务器/静态服务）保持单例
 * ——调度预算 daemon 全局一份不随会话数分裂（TR-AD-11/16）。
 *
 * 显式模式（§4.3）：生产入口 createDaemon = 唯一生产装配形态（真引擎 +
 * 真 SubagentLauncher + CdpConnectionManager + config 模板/加载 +
 * 单例锁）；全部测试注入口（engine/skip 锁与配置读面/静态 fixture/工具
 * 沙箱/技能目录隔离/fake runner/fake 浏览器端口/会话参数）迁
 * apps/daemon/test/helpers/createTestDaemon.ts（TestDaemonOptions）——
 * 生产面类型零测试污染；两入口共享装配核心 assembleDaemon
 * （本文件导出的组合根接缝），装配形态经 engineMode 判别字段显式声明，
 * 不从注入字段缺省推断。
 *
 * 装配序（architecture §4.2.2）：启动序前置（目录/锁/config）→ 四命名
 * 装配函数（buildPersistence → buildModelStack → buildSessionStack）→
 * wireEventFanout → 晚绑回填闭合 → registry.initialize → driving 接线
 * （ws-server / cli）→ 返回句柄。
 * M29 切片：kg 解析器群（buildKgResolverGroup）/ 任务编排服务
 * （buildTaskOrchestrator）/ driving 接线两阶段（buildDrivingAdapters）
 * 均归 infrastructure/assembly（AG-02④ 豁免面），装配顺序语义不变。
 * M5 切片：启动序前置域（bootPrelude——grep/codegraph 定格 + legacy
 * 迁移两批 + WS 端口解析链）同归豁免面，原位调用零行为改动。
 *
 * 持久化：SQLite WAL `<home>/helix.db`；WriteQueue 是 daemon 内唯一
 * SQLite 写通道（AG-06），每会话独立仓位按 session_id 路由（分仓写队列）；
 * shutdown 先 drain 写队列再释放锁（优雅退出）。
 */
export interface DaemonOptions {
  /** 显式 home（main.ts 已解析 --home；缺省 ~/.helix）。 */
  readonly home?: string;
  /** CLI 输入流覆盖（缺省 process.stdin；真实启动面）。 */
  readonly cliInput?: NodeJS.ReadableStream;
  /** CLI 输出流覆盖（缺省 process.stdout；真实启动面）。 */
  readonly cliOutput?: NodeJS.WritableStream;
  /** WS 监听端口覆盖（argv --port 解析结果：本次运行显式覆盖，不回写 KV；0 = 随机；缺省走 KV daemon_port ?? 7333——真实启动面）。 */
  readonly port?: number;
}

export interface Daemon {
  readonly paths: HelixPaths;
  readonly config: DaemonConfig;
  /** 会话路由对话入口（chatRouter 本体；SessionChatPort = ChatPort 超集）。 */
  readonly chat: SessionChatPort;
  readonly session: SessionPort;
  readonly system: SystemPort;
  readonly logger: Logger;
  /** WS 服务（127.0.0.1；实际监听端口/地址可观测）。 */
  readonly ws: WsServerAdapter;
  /** 本次启动生成的 dev token（与 <home>/dev-token 文件内容一致；sidecar ready 行上抛面，contracts/sidecar-lifecycle.md §2）。 */
  readonly devToken: string;
  /** SubAgent 子进程运行器（engineMode=override 测试形态不装配真体）。 */
  readonly subagentLauncher: SubagentLauncher | undefined;
  /** 编排入口（spawn/send/status/kill；三工具与 WS 命令的公共回口）。 */
  readonly orchestration: AgentOrchestrationPort;
  /** 模型/认证管理入口（AD-2：model 族与 auth 族命令公共回口）。 */
  readonly model: ModelPort;
  /** 资源配置入口（kind 维工具/技能启停 + model 槽位的数据与合取计算面）。 */
  readonly resource: ResourceService;
  /** 会话目录入口（AD-4：list/loadHistory/delete/草稿/懒加载取数面）。 */
  readonly directory: SessionDirectoryPort;
  /** 任务引擎入口（T1.3：createTask/生命周期/编排回口/恢复扫描；T1.5 task.* 命令族回口）。 */
  readonly task: TaskEnginePort;
  /** 任务查询入口（P-2 读面人类可读投影；T1.5 task.list/detail/artifacts 回口）。 */
  readonly taskQuery: TaskQueryService;
  /**
   * 浏览器连接入口（CDP 地基，BrowserPort）：lazy 连接， browser 工具
   * 与状态协议的消费面；生命周期 = daemon 生命周期（shutdown 挂 stop()）。
   */
  readonly browser: BrowserPort;
  /** 多会话容器（生命周期编排观测面——测试断言懒加载/卸载用）。 */
  readonly registry: SessionRegistry;
  /** U7：写事实登记表（会话足迹源；测试注入足迹/未来占用协调同源消费）。 */
  readonly writeFacts: WriteFactRegistry;
  /**
   * workspace 绑定面（W1 绑定闭环）：绑定状态机唯一事实源（restore/open/
   * bindCwd）+ 绑定 kg 栈持有者（重绑接缝——RPC 与测试消费）。shutdown
   * 路径 dispose 当前栈不变（workspace.dispose()）。
   */
  readonly workspace: WorkspaceService;
  /**
   * 会话工具沙箱 cwd 读面（W1F-F1 接线观测）：每会话装配与 SubAgent
   * spawn 的求值单点现值——绑定后 = 绑定 root 规范形，未绑定回落启动
   * cwd（集成断言用：设计稿 §8「绑定后 toolCwd 基准正确」）。
   */
  readonly toolCwdNow: () => string;
  /** fan-out 带名注册表（§4.2.4：序 = 语义唯一权威——测试断言语义序用）。 */
  readonly fanoutTargets: readonly NamedFanoutTarget[];
  /** 装配级资源事件总线（§4.2.3：resources.changed 观测面——不进 WS/不落盘/不进 fan-out）。 */
  readonly resourceEvents: ResourceEventBus;
  /** CLI 主循环（阻塞至 /exit/EOF/二次 Ctrl-C）。 */
  runCli(): Promise<void>;
  /** 优雅关闭：停 WS、停输入、释放锁。 */
  shutdown(): Promise<void>;
}

/**
 * 组合根装配接缝（§4.3）：共享装配核心 assembleDaemon 的输入——
 * 生产入口 createDaemon 与测试工厂 createTestDaemon（test/helpers/）各自
 * 构造切片后调用。装配形态全部显式：engineMode 判别字段声明引擎装配
 * 形态；lock/config/legacy 为入口已构造的启动序前置产物（测试工厂的
 * 「跳锁 / 跳配置读面」形态 = 直接传 undefined lock / 硬编码缺省 config
 * + 空 legacy，跳过语义不进生产面类型）。
 */
export interface AssembleDaemonDeps {
  // ── 真实启动参数（DaemonOptions 子集，生产/测试同形透传） ──
  readonly home?: string;
  readonly port?: number;
  readonly cliInput?: NodeJS.ReadableStream;
  readonly cliOutput?: NodeJS.WritableStream;
  // ── 启动序前置产物（入口形态决断，装配核心只消费不构造） ──
  /** 单例锁（生产必获取；测试跳锁形态传 undefined）。 */
  readonly lock: SingletonLock | undefined;
  /** 已加载配置（生产 = ensureConfigTemplate + loadConfig；测试跳配置读面形态 = 硬编码缺省）。 */
  readonly config: DaemonConfig;
  /** 旧格式遗留位（空对象 = 不触发启动迁移——测试跳配置读面形态天然为空）。 */
  readonly legacy: LegacyModelConfig;
  // ── 装配切片（测试注入口的组合根接缝形态） ──
  /** 引擎装配形态（显式判别：production 真引擎 / override 测试注入工厂）。 */
  readonly engineMode: EngineAssemblyMode;
  /** 浏览器端口实例（生产 CdpConnectionManager；测试可注入 fake BrowserPort）。 */
  readonly browserPort: BrowserPort;
  /** SubAgent runner 覆盖（测试注入 fake runner 驱动收口时序；缺省真体/占位降级）。 */
  readonly subagentRunnerOverride?: InstanceRunner;
  /**
   * TTS 合成面覆盖（语音播报批 V2：测试注入 fake TTSPort 驱动全链广播；
   * 缺省 = DashScopeTtsAdapter 真体）。
   */
  readonly voiceTtsOverride?: TtsPort;
  /**
   * 流式 TTS 服务覆盖（哑帧修复批：测试注入 fake TtsStreamService 驱动
   * chunk/done/error 帧剧本与毒化异常路径；缺省 = TtsStreamService 真体
   * ——DashScopeStreamingTtsAdapter 连接池 + authStore key 读面）。
   */
  readonly voiceTtsStreamOverride?: TtsStreamService;
  /**
   * 分诊器 LLM 面覆盖（管家感知批 M0.5：测试注入 fake StewardDiagnosisPort
   * 驱动双轨产物/降级路径；缺省 = StewardDiagnosisAdapter 真体——
   * summary.task.model 专用槽位沿用）。③层摘要面覆盖
   * （voiceSummarizerOverride）已随归一退役。
   */
  readonly stewardDiagnoseOverride?: StewardDiagnosisPort;
  /**
   * 感知服务覆盖（管家感知批 M0.5：测试注入 fake 驱动激活/限流/任务锚链路；
   * 缺省 = StewardPerceptionService 真体）。
   */
  readonly stewardPerceptionOverride?: StewardPerceptionService;
  /**
   * 管家 LLM 面覆盖（V2.5 文本管家批：测试注入 fake StewardLlmPort 驱动全链；
   * 缺省 = PiStewardLlmAdapter 真体）。
   */
  readonly stewardLlmOverride?: StewardLlmPort;
  /**
   * 会话总结器覆盖（总结器独立化批①：测试注入 fake 驱动三产物全链；
   * 缺省 = SessionSummaryService 真体）。
   */
  readonly sessionSummaryOverride?: { onDomainEvent(event: DomainEvent): void };
  /**
   * findings 落账管道覆盖（F3.0，T4.1 测试注入替身；缺省 = kg 栈真体：
   * KgWriteService 唯一写入口 + workspace 项目扫描）。
   */
  readonly findingsSinkOverride?: ClosureFindingsSink;
  /**
   * 编排会话 LLM 覆盖（T4.1 E 层测试接缝：fake 剧本 streamFn + 可解析 model）。
   * 透传 createOrchestratorSessionFactory（LLM 面单点替换；缺省生产形态）。
   */
  readonly orchestratorLlmOverride?: Parameters<typeof createOrchestratorSessionFactory>[0]["llmOverride"];
  /** 主会话 LLM 覆盖（测试接缝：fake 剧本 streamFn + 可解析 model；缺省生产形态）。 */
  readonly mainSessionLlmOverride?: MainSessionLlmOverride;
  /** 前端静态产物目录覆盖（缺省取 config.staticDir）。 */
  readonly staticDir?: string;
  /** 工具沙箱 cwd 覆盖（缺省为进程工作区）。 */
  readonly toolCwd?: string;
  /** builtin 层技能目录覆盖（缺省 = paths.builtinSkillsDir() 随仓真目录——目录缺失静默跳过）。 */
  readonly builtinSkillsDir?: string;
  /** 主时间轴尾窗大小覆盖（G-1 注入面；缺省 WsServerAdapter 内建缺省）。 */
  readonly tailSize?: number;
  /** 空闲卸载窗口 ms 覆盖（G-5 注入面；缺省 30min）。 */
  readonly sessionIdleUnloadMs?: number;
  /** 空闲卸载轮询间隔 ms 覆盖（注入面；缺省 min(60s, 窗口/10)）。 */
  readonly sessionIdlePollMs?: number;
  /**
   * kg workspace 根初始绑定值（W1 语义演进：等价 restore 预置——测试注入面
   * 指向 tmp）。缺省/显式 null = 不预置 → 走 KV restore（生产等价；
   * createTestDaemon 缺省预置 process.cwd() 保既有测试形态）。
   * 生产 createDaemon 恒不注入 → unbound boot，等 RPC open 或 CLI bindCwd。
   * §3.1/TR-AD-6 零 env 键不变。
   */
  readonly kgWorkspaceRoot?: string | null;
}

/**
 * 生产入口（§4.3 显式模式，async：重启恢复需读盘）。main.ts 唯一
 * 调用面；测试装配一律走 apps/daemon/test/helpers/createTestDaemon.ts。
 */
export async function createDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  const paths = createPaths(options.home);
  // 首启序：目录补建必须先于锁获取（daemon.lock 是首个写盘动作，
  // 目录不存在则 ENOENT）——ensureHome 是 home 目录创建的单点（TR-AD-6）。
  paths.ensureHome();
  const lock: SingletonLock | undefined = acquireSingletonLock(paths.lockPath());
  // 配置：首次创建模板（0600，AG-09）+ 加载（瘦身：纯运行参数；旧
  // 格式 model/apiKeys 读入 legacy 由装配核心迁移落新位）
  ensureConfigTemplate(paths.configPath());
  const loaded = loadConfig(paths.configPath());
  return assembleDaemon({
    home: options.home,
    port: options.port,
    cliInput: options.cliInput,
    cliOutput: options.cliOutput,
    engineMode: { kind: "production" },
    lock,
    config: loaded.config,
    legacy: loaded.legacy,
    browserPort: new CdpConnectionManager({ homeDir: osHomeDir() }),
  });
}

/**
 * 共享装配核心（组合根接缝， §4.3）：生产 createDaemon 与测试工厂
 * createTestDaemon 的公共装配序——启动序前置产物由入口传入（deps），
 * 本函数只做装配不做形态决断（async：重启恢复需读盘）。
 */
export async function assembleDaemon(deps: AssembleDaemonDeps): Promise<Daemon> {
  /** 本代 daemon 启动时刻（恢复链幽灵实例判据：agent_lifecycle 行 updated_at
   * 早于此 = 上代遗留——task-efd68911 事故：非优雅退出后非终态投影行无人收口）。 */
  const bootedAtMs = Date.now();
  // ── 装配序步 1：装配级事件总线（零依赖 pub/sub，最先构造——循环边解耦锚点，
  //    architecture §4.2.2/§4.2.3）：resources.changed 的唯一通道，
  // 不进 WS/不落盘/不进 fan-out（负断言面）。──
  const resourceEvents = createResourceEventBus();
  /** typed 回填面（§4.2.5）：构造早期声明、initialize 前闭合。 */
  const backfill: AssemblyBackfill = {};

  // ── 启动序前置（TR-AD-6/AG-09） ─────────────────────────────
  const paths = createPaths(deps.home);
  // 首启序：目录补建先于首个写盘动作（ensureHome 幂等——入口已在锁获取前
  // 补建；此处保证 logger/持久化等写盘面有目录，TR-AD-6 单点）。
  paths.ensureHome();
  const lock = deps.lock;
  const logger = createFileLogger(paths.logsDir());
  // 进程级崩溃钩子（留痕兑底：崩溃先落 ERROR 再退出——2026-09-14 事故教训）
  // + 陈锁接管检测（遗留锁+死 pid = 上次未优雅退出的签名，供追溯）。
  installCrashLogging(logger);
  if (lock?.previousCrash !== undefined) {
    logger.warn(
      `检测到上次 daemon 非正常退出（pid=${lock.previousCrash.pid}` +
        `${lock.previousCrash.startedAt !== "" ? `，startedAt=${lock.previousCrash.startedAt}` : ""}` +
        `）——未执行优雅关闭，锁为崩溃遗留，本次启动已接管；` +
        `上次运行末尾见同日 daemon-*.log。`,
    );
  }
  const config = deps.config;
  const legacy = deps.legacy;

  // ── grep/codegraph 后端启动定格（M5 切片迁 assembly/bootPrelude——AF-1
  //    二级解析 + rg 探针 / AF-2 bundle-only 语义注释随切片迁移；AG-08 env
  //    读取例外面同迁）。定格产物原位消费：grep → buildSessionStack 注入；
  //    codegraphResolution → buildKnowledgeStack/子进程 env 透传。──
  const { grepFreeze, codegraphResolution, vec0BundlePath } = await freezeSearchBackends({ config, logger });

  // ── 装配序步 2-4：持久化族 → 模型域 → 会话/运行面（architecture §4.2.2） ──
  // U2 观测态晚绑容器：trace 面板 main displayState 的会话运行态读口
  //（registry 在 buildSessionStack 后才存在——与 wsServer 同款回填模式）
  const traceSessionRunOf: { of?: (sessionId: string) => SessionRunStateLike } = {};
  const persistence = buildPersistence({ paths, logger, traceSessionRunOf });

  // ── config 瘦身批迁移第一批（M5 切片迁 assembly/bootPrelude；一次性幂等，
  //    先于端口解析与 MCP 预热——port/调度预算/mcpServers → 新位 + config.json
  //    重写瘦身形态）。model/apiKeys 迁移在模型栈就绪后（见下方第二批）。──
  await migrateLegacyRuntimeConfig({ legacy, persistence, paths, config, logger });

  // ── WS 端口解析链 + PortConfigPort（M5 切片迁 assembly/bootPrelude——
  //    argv --port > KV daemon_port > 缺省 7333；config.json port 字段退役——
  //    上方迁移第一批把旧值写入 KV，故本链在迁移后求值；port 启动期定格，
  //    set 后下次启动生效）。──
  const { resolvedPort, portConfig, bindEffectivePort } = resolveWsPort({
    argvPort: deps.port, // argv --port 本次运行显式覆盖（不回写 KV）
    runtimeConfig: persistence.runtimeConfig,
  });

  // ── workspace 绑定面（W1 绑定闭环）：绑定状态机唯一事实源 + 绑定 kg 栈
  //    持有者（重绑接缝）。物化时机迁移：unbound boot 零扫描零同步零开库
  //    ——栈只在 restore 成功/open 成功/初始绑定后建。kg 索引同步触发面：
  //    页面手动 triggerManual + fs-watch 监控（B3 重新挂接，推翻 2026-08-29
  //    退役裁决）——startSync = watcher 补齐接缝：绑定/换绑时对已建
  //    .helix-kg 的项目批量挂接；absent 项目等索引建成后经
  //    KgSyncService.onSynced 钩子挂接。启动/换绑不自动跑 sync。
  //    广播、活跃 agent 判定与会话卸载面经晚绑闭包（eventStream/
  //    registry 在 buildSessionStack 后才存在——与 wsServer 同款回填模式）。──
  let broadcastWorkspaceChanged: (root: string) => void = () => {};
  let hasActiveAgentNow: () => boolean = () => false;
  let unloadSessionsOnRebind: () => void = () => {};
  // P0① kg.projects 行 bootstrapRunning 数据源：任务栈在 workspace 之后建——
  // 晚绑回填（buildStack 闭包读取现值；kg.projects 调用必在 boot 完成后）
  let taskStoreForProjectRows: TaskStorePort | undefined;
  // 批1 WP-B：embedding 配置域晚绑引用（其构造在下方——buildStack 惰性闭包
  //  经此读现值；向量面解析恒走 resolveDefault 单点，构造窗口零调用）
  let embeddingConfigRef: EmbeddingConfigService | undefined;
  // 批2 WP-C：知识库配置域晚绑引用（KgConfigStore 构造在下方——buildStack
  //  惰性闭包经此读查重阈值生效对，运行期即热）
  let kgConfigRef: KgConfigStore | undefined;
  const workspace = new WorkspaceService({
    kv: persistence.runtimeConfig, // KV 底座（AG-06 单写通道；不进 config.json，TR-AD-6）
    fs: createWorkspaceFs(), // driven 探测端口（realpath/可读目录/危险根判定输入）
    clock: { now: () => new Date().toISOString() },
    cwd: () => process.cwd(), // CLI 例外条款源（终端站位 = 显式选择）
    buildStack: (root) =>
      buildKnowledgeStack({
        codegraphResolution,
        workspaceRoot: root,
        logger,
        hasRunningBootstrapJob: (projectName) =>
          taskStoreForProjectRows !== undefined && hasActiveJob(taskStoreForProjectRows.listJobs(), "kg-bootstrap", projectName),
        hasRunningReviewJob: (projectName) =>
          taskStoreForProjectRows !== undefined && hasActiveJob(taskStoreForProjectRows.listJobs(), "kg-review", projectName),
        hasRunningCodeReviewJob: (projectName) =>
          taskStoreForProjectRows !== undefined && hasActiveJob(taskStoreForProjectRows.listJobs(), "code-review", projectName),
        hasRunningTriageJob: (projectName) =>
          taskStoreForProjectRows !== undefined && hasActiveJob(taskStoreForProjectRows.listJobs(), "kg-triage", projectName),
        // 批1 WP-B：kg 向量联动面（嵌入经全局默认 embedding 端点单点——
        //  端点缺失/失效 = 嵌入降级 warn 不阻塞写，可选件纪律）
        makeEmbedding: () =>
          new OpenAiCompatEmbeddingAdapter({ getConfig: () => embeddingConfigRef?.resolveDefault() ?? null }),
        resolveEmbeddingEndpoint: () => embeddingConfigRef?.resolveDefault() ?? null,
        // 批2 WP-C：查重阈值生效对（kg.similarityWarn/Dup 读面裁决单点——
        //  KgConfigStore.current；未建前回缺省对）
        resolveKgThresholds: () =>
          kgConfigRef?.current() ?? { warn: KG_SIMILARITY_WARN_DEFAULT, dup: KG_SIMILARITY_DUP_DEFAULT },
      }),
    // B3 fs-watch 补齐挂接：已建 .helix-kg 索引的项目即挂 watcher（索引态
    // 补齐）；stop = 全停（重绑/dispose 清理面——栈 dispose 内含同调用，幂等）。
    startSync: (stack, root) => {
      for (const projectRoot of existingKgProjects(root)) stack.fsWatch.watchProject(projectRoot);
      return { stop: () => stack.fsWatch.dispose() };
    },
    broadcast: (root) => broadcastWorkspaceChanged(root),
    hasActiveAgent: () => hasActiveAgentNow(),
    // W4 债清偿：重绑（替换已绑定栈）时卸载全部现有会话——旧会话 executor
    // 闭包持已 dispose 旧栈；卸载后回访懒加载按新栈重建（kgTools/editDeps
    // 工厂闭包在 buildRuntime 时读 workspace.stack() 现值）。
    unloadSessions: () => unloadSessionsOnRebind(),
    logger,
  });
  if (deps.kgWorkspaceRoot != null) {
    // 测试注入面：初始绑定值（等价 restore 预置——不校验不持久化）
    workspace.bindInitial(deps.kgWorkspaceRoot);
  } else {
    // 生产/常规（缺省或显式 null）：不预置，走 KV 恢复（有效则绑定 =
    // rebind 效应；无效/无 KV 则未绑定——unbound boot，等 RPC open 或
    // CLI bindCwd）
    await workspace.restore();
  }
  // 三方平台批：config 注入（KV custom_providers 启动回读——自定义 provider
  //   登记进目录底座；persistence 在装配序上先于本步，依赖已就绪）
  const modelStack = buildModelStack({ paths, logger, config: persistence.runtimeConfig });
  const clock: ClockPort = { now: () => new Date().toISOString(), nowMs: () => Date.now() };
  // ── 装配序步 2-5：任务栈（T1.3，与三 build* 同列）──
  //    任务类型注册表（T2.3 真体）：独立 SkillScanner 实例扫 builtin 层（与
  //    buildSessionStack 的提示装配扫描器同形同源、无共享状态——扫描现拍现
  //    读）；starter（T2.2 TaskOrchestratorService）真体注入前 no-op；恢复扫描
  //    钩子在 registry.initialize 之后触发（§4.4）。kg 节点投影经 workspace 持有者
  //    晚绑读现值（W1 重绑接缝同 kgTools/editDeps 工厂；未绑定 → 空投影）。
  //    task.changed 广播（AF-T1.5.2）与编排服务均晚绑（eventStream/scheduler
  //    在 buildSessionStack 后才存在——broadcastWorkspaceChanged 同款回填模式，
  //    引擎只在运行期触发回调，装配窗口零调用）。──
  const bootCwd = deps.toolCwd ?? process.cwd();
  const taskSkillSource = new SkillScanner({
    userSkillsDir: paths.skillsHome(),
    builtinSkillsDir: deps.builtinSkillsDir ?? builtinSkillsDir(),
    cwd: bootCwd,
  });
  let broadcastTaskChanged: (frame: { jobId: string; changed: "job" | "stage" | "batch"; status?: string }) => void = () => {};
  let orchestratorService: TaskOrchestratorService | undefined;
  /** 调度器晚绑引用（⑤ 链 A：任务栈 instanceStateOf 闭包读现值）。 */
  let schedulerLate: { status(agentId?: string): { state: string }[] } | undefined;
  /** 晚绑 starter 代理（T2.2 真体在 sessionStack 之后构造回填；未回填 = 占位语义）。 */
  const lateStarter: TaskOrchestratorStarterPort = {
    startOrchestrator: (jobId) =>
      orchestratorService === undefined
        ? Promise.resolve()
        : orchestratorService.startOrchestrator(jobId),
    stopOrchestrator: (jobId) =>
      orchestratorService === undefined
        ? Promise.resolve()
        : orchestratorService.stopOrchestrator(jobId),
    // B2 fail-stop：failBatch 超限上浮 → 编排停摆（停驱动 + 摘队排队实例）
    haltJob: (jobId) => {
      if (orchestratorService !== undefined) orchestratorService.haltJob(jobId);
    },
    // 链 A（⑤）：任务 pause/resume → 编排层 parkAll/resumeAll 晚绑透传
    parkAll: (jobId) =>
      orchestratorService === undefined
        ? Promise.resolve()
        : orchestratorService.parkAll(jobId),
    resumeAll: (jobId) =>
      orchestratorService === undefined
        ? Promise.resolve()
        : orchestratorService.resumeAll(jobId),
  };
  const taskStack = await buildTaskStack({
    writeQueue: persistence.writeQueue,
    clock,
    logger,
    starterOverride: lateStarter,
    skillSource: taskSkillSource,
    onTaskChanged: (frame) => broadcastTaskChanged(frame),
    // A 批第四 wake 点：装配完成申报经晚绑闭包接编排服务驱动派发轮
    //（orchestratorService 在本块之后构造回填，构造窗口零调用）
    onAssemblyDone: (jobId, stageSeq, batchCount) => orchestratorService?.notifyAssemblyDone(jobId, stageSeq, batchCount),
    // 链 A（⑤）：批次实例调度态读面（任务页 parked 徽标数据源）——晚绑闭包
    // 读 scheduler 现值（sessionStack 在本块之后建，构造窗口零调用）
    instanceStateOf: (agentId) => schedulerLate?.status(agentId)[0]?.state,
    // 恢复链幽灵实例收口（task-efd68911 事故）：agent_lifecycle 非终态上代
    // 遗留行 → failed/cancelled + agent.failed 补发；events 晚绑 fanout
    //（fanoutPublisher 在本块之后构造，recoverOnStartup 在装配末尾触发，
    // 调用时刻恒晚于声明时刻——同 lateStarter 晚绑模式）
    agentProjections: persistence.repository,
    bootedAtMs,
    events: { publish: (event) => fanoutPublisher.publish(event) },
    // F3.6 级联扩展：任务报告目录（批次报告 md/findings 旁路/summary.md）
    // 随任务同灭——force:true 幂等（目录不存在不炸），库级联成功后调用
    removeTaskReportDir: (jobId) => rm(path.join(paths.home, "reports", `task:${jobId}`), { recursive: true, force: true }),
  });
  // P0① 回填：kg 栈 projectService 的 bootstrapRunning 查询面接任务库现值
  taskStoreForProjectRows = taskStack.orchestratorCore.store;

  // ── fan-out 发布面（先建，服务构造即依赖它；目标归 wireEventFanout 装配） ──
  const fanoutPublisher = new FanoutPublisher(logger);

  // ── 提权申请批：AskService 单例（main executor 与 SubagentLauncher wire
  //    转发两端同持；KV pending 恢复在会话清单就绪后调 restoreFromKv）──
  const askService = new AskService({
    publish: (event) => fanoutPublisher.publish(event),
    kv: persistence.runtimeConfig,
    now: () => clock.nowMs(),
    newId: () => `ask-${crypto.randomUUID().slice(0, 8)}`,
  });

  // ── driven：CDP 浏览器连接（地基；无独立 proxy/HTTP 层，连接内嵌 daemon）──
  // lazy 连接——装配不触网；homeDir 经 paths.ts 单点取（AG-07：adapter 不直接展开主目录）。
  const browserPort: BrowserPort = deps.browserPort;

  // ── mcp 批：MCP 注册表单例（buildSessionStack 前建——catalog/executor 消费；
  //    预热与状态广播接线在 sessionStack/eventStream 就绪后（见下方））。
  //    无条件构造：config 零 server 时空表运行（discoveredTools() → [] 零工具
  //    零副作用），配置页运行期 add 首个 server 依赖空表可增长——条件构造会
  //    让「无配置 daemon」的 mcp 命令族整族失效。──
  const mcpRegistry = new McpRegistry({ logger });

  // ── 三方平台批：CustomProviderService 提前构造（构造无副作用）——provider
  //    族三命令回口（buildDrivingAdapters 下方复用同一实例）与 SubAgent
  //    子进程透传读面（customProvidersOf：launcher HELIX_CUSTOM_PROVIDERS_JSON
  //    的定义来源，launch 时刻经 list() 读现值定格）共用同一读面单源。
  const customProviderService = new CustomProviderService({
    config: persistence.runtimeConfig,
    registry: modelStack.customProviderRegistry,
    auth: modelStack.authStore,
    defaultModel: persistence.defaultModel,
  });

  const sessionStack = await buildSessionStack({
    paths,
    config,
    logger,
    repository: persistence.repository,
    resourceState: persistence.resourceState,
    clock,
    authStore: modelStack.authStore,
    catalog: modelStack.catalog,
    defaultModel: persistence.defaultModel,
    defaultThinking: persistence.defaultThinking, // R7 全局兜底批
    compactionConfig: persistence.compactionConfig, // 压缩参数可配置
    schedulingConfig: persistence.schedulingConfig, // SubAgent 调度预算（运行期可调，config.json 瘦身迁入）
    sandboxConfig: persistence.sandboxConfig, // 沙箱开关（装配期定格读取，沙箱开关批）
    askService, // 提权申请批：permission_request 工具仲裁（沙箱 on 时注册）
    // custom provider 子进程透传批：定义读面单源（CustomProviderService.list
    // ——launcher env 定格透传，详见 SubagentLauncherDeps.customProviders）
    customProvidersOf: () => customProviderService.list(),
    browserPort,
    events: fanoutPublisher,
    publishResourceChanged: (kind) => resourceEvents.publish({ kind }),
    mcpRegistry,
    backfill,
    engineMode: deps.engineMode,
    mainSessionLlmOverride: deps.mainSessionLlmOverride,
    subagentRunnerOverride: deps.subagentRunnerOverride,
    toolCwd: deps.toolCwd,
    // W1F-F1：会话工具沙箱 cwd 动态解析接线（评审缺口修复：此前仅传启动
    // 定格面，生产恒回落启动 cwd）——经 workspace 持有者读现值（boundRoot()
    // 规范形；未绑定回落启动 cwd）；deps.toolCwd 显式注入（测试面）时恒
    // 优先（toolCwdOf 优先级链）。
    resolveToolCwd: () => workspace.boundRoot() ?? process.cwd(),
    // grep 启动定格产物（AF-1，rg 单后端）：rg 定格注入路径；unavailable
    // 定格注入原因清单（门面响亮失败文案用）。
    grep: {
      rgPath: grepFreeze.kind === "rg" ? grepFreeze.rgPath : undefined,
      unavailableReasons: grepFreeze.kind === "unavailable" ? grepFreeze.reasons : undefined,
    },
    // kg 挂点（T3.2 附着接线）：每会话闭合 sessionId（跨通道去重键）——
    // edit 成功路径附着 📎 块（notifyWrite 写后 sync 挂接按 2026-08-29
    // 用户裁决退役，不注入）。W1：经
    // workspace 持有者读现值（重绑后新会话跟随新栈；未绑定 → undefined
    // 无挂点，EditTool 行为不变）。
    editDeps: (sessionId) => {
      const stack = workspace.stack();
      const root = workspace.boundRoot();
      return stack !== null && root !== null
        ? buildEditToolDeps({
            workspaceRoot: root,
            attachment: stack.attachmentService,
            sessionId,
          })
        : undefined;
    },
    // kg 双工具装配面（T3.3）：主会话 executor 注册 kg/kg-update（SubAgent
    // 子进程侧由 ChildMain 本地栈自带）。W1：工厂形态经持有者读现值
    //（重绑后新会话跟随新栈；未绑定 → 不注册）。
    kgTools: () => {
      const stack = workspace.stack();
      const root = workspace.boundRoot();
      return stack !== null && root !== null
        ? {
            query: stack.queryService,
            write: stack.writeService,
            workspaceRoot: root,
            scanProjects: () => scanWorkspaceProjects(root),
            // 批2 WP-C：写入口语义查重闸（向量面在场才挂——可选件纪律）
            ...(stack.dedupService !== undefined ? { dedup: stack.dedupService } : {}),
          }
        : undefined;
    },
    // codegraph 工具装配面（W1-B，R5/R7）：主会话 executor 注册 codegraph
    //（SubAgent 子进程侧由 ChildMain 本地栈自带）。W1 同 kgTools：工厂经
    // 持有者读现值（重绑后新会话跟随；未绑定 → 不注册）。引擎适配器持有
    // 启动定格二进制（buildKnowledgeStack 同源）；二进制不可达时工具仍在，
    // 调用 degraded（EngineUnavailable），不阻断装配。
    codegraphTool: () => {
      const stack = workspace.stack();
      const root = workspace.boundRoot();
      return stack !== null && root !== null
        ? { engine: stack.codegraphEngine, workspaceRoot: root }
        : undefined;
    },
    // codegraph 二进制定格路径（W1-B）：透传 SubAgent 子进程 env（父子一致）
    ...(codegraphResolution.kind === "resolved" ? { codegraphPath: codegraphResolution.path } : {}),
    // rg 二进制定格路径（rg 唯一化）：透传 SubAgent 子进程 env（父子一致；
    // config 级 rg 无此透传则子进程只剩 bundle 级）
    ...(grepFreeze.kind === "rg" ? { rgPath: grepFreeze.rgPath } : {}),
    // task_create 工具装配面（T2.4，AD-7）：主会话 executor 注册 chat 第二
    // 创建入口——与 /project 入口同一 createTask API（TaskEngineService 注入）
    // + 回执读面（TaskQueryService 投影）；SubAgent 子进程本地栈不注入（生效集隔离）
    taskCreate: { engine: taskStack.taskEngine, query: taskStack.query },
    // 可用任务类型段数据源（audience 分类注入，批二）：MainAgent 提示的
    // 任务类型清单 = 任务注册表读面（与 task_create 的类型校验同一事实源）
    taskTypesOf: () => taskStack.orchestratorCore.skills.listTaskTypes(),
    // 项目常驻规则段数据源（global 声明节点触发面索引，U7 去全扫化）：
    // 纯查询面（会话足迹项目集 → 段或 null，足迹求值在 session 栈内）。
    // kg 栈按足迹项目集聚合渲染；空足迹/未绑定/无图谱 → null → 段省略。
    // 栈级快照不含此段，会话级应用点（engineFor/instantiatedSnapshot/
    // toggle 推送/subagentAssemblyFor）应用时刻取现值。
    residentRulesOf: (projectRoots: readonly string[]) =>
      workspace.stack()?.queryService.residentRulesSection(projectRoots) ?? null,
    // 批E：memory_search 检索面现值读口（编码 agent 记忆消费面工具化——
    // 批D 静态段注入退役）。stewardMemory 在下方构造（晚绑闭包——运行期
    // 触发时已就位）；缺席（vec0 不可解析/记忆存储开库失败）→ undefined →
    // engineFor 不注册。记忆未配置（enabled 关/端点悬空）不影响 service
    // 在场——工具注册面恒宽（toggle 推送兑底），广告面按 isAvailable
    // 现值门控（sessionEngineFactory）。scope 项目解析在 session 栈内
    // （writeFacts 足迹单项目归约——singleProjectDirOf 单点，与 progress
    // 写入 scope 同源）。
    memorySearchServiceOf: () => stewardMemory,
    // task_report 工具装配面（D3）：主会话 executor 注册 chat 回流通用报告
    // 查询面——任务读面（TaskQueryService list/detail）+ closure_records 读面
    //（SessionRepositoryPort.queryClosureRecords）+ 报告目录约定（与
    // ClosureRecorder 兜底 reportsDirFor 同源同式 <home>/reports/<sessionId>）；
    // SubAgent 子进程本地栈与编排主 agent 不注入（生效集隔离）
    taskReport: {
      query: taskStack.query,
      closureRecords: (sessionId) => persistence.repository.queryClosureRecords(sessionId),
      reportDirFor: (sessionId) => path.join(paths.home, "reports", sessionId),
    },
    // 主会话 todo 双工具装配面（plan 三工具改名批）：instanceId = sessionId
    // 作用域；写面 = 父进程 LazyWorkLedger 直连 helix.db（同库 WAL 跨进程
    // 安全）；执行成功后装配层广播 session.plan.changed + 快照附 plan 读面
    //（SubAgent 子进程本地栈不受影响——两栈独立）
    mainPlan: {},
    // spawn 派发任务切片注入（F1.3）：任务文本 → 图查询 → digest+指针切片
    // 拼入 task 约束区；注入后 markInjected 入跨通道去重注册表（T3.2 同源）。
    // W1：未绑定 → 空切片（无图查询面，零副作用）。audience（D8 W-R6）：
    // SubAgent spawn 链传 "worker"（协议行 findings 申报措辞），主会话
    // ChatService 链传/缺省 "main"（kg-update 直落措辞）——buildSessionStack 按消费链分叉。
    taskInjector: (sessionId, task, audience, projectRoots) =>
      workspace.stack()?.queryService.injectTaskSlice(sessionId, task, audience, projectRoots) ?? "",
    // findings 落账管道（F3.0，T4.1）：findings 文件 canonical → KgWriteService 唯一
    // 写入口落账（绝不旁路）；目标项目解析 = workspace 全扫描（与 kg-update
    // 工具同口径：显式名命中 / 唯一项目自动 / 多项目不猜）。测试可注入替身。
    // W1：未绑定 → 落账拒绝（KG_E_STATE，不吞声）+ 空扫描。
    findingsSink: deps.findingsSinkOverride ?? {
      write: (projectRoot, op) =>
        workspace.stack()?.writeService.write(projectRoot, op) ?? {
          ok: false,
          error: { code: "KG_E_STATE", message: "未绑定工作空间：findings 落账跳过（请先选择工作空间）" },
        },
      scanProjects: () => {
        const root = workspace.boundRoot();
        return root !== null ? scanWorkspaceProjects(root) : [];
      },
      // 迭代锚回落（缺口修复：findings 缺 iterationId 时回落库内锚——与 kg-update
      // 工具 resolveIterationId 同语义；未绑定返回 null 不报错）
      latestIteration: (projectRoot) => workspace.stack()?.queryService.latestIteration(projectRoot) ?? null,
    },
    builtinSkillsDir: deps.builtinSkillsDir,
    sessionIdleUnloadMs: deps.sessionIdleUnloadMs,
    sessionIdlePollMs: deps.sessionIdlePollMs,
    // T2.2：任务批次实例收口路由——task:* 会话归属 closure 转投编排服务
    //（晚绑闭包：编排服务在本块之后构造回填）
    taskClosureSink: (agentId) => orchestratorService?.handleInstanceClosure(agentId),
  });
  const { resourceService, subagentLauncher, scheduler, eventStream, registry, sessionService, resolveSubagentModelId, toolCwdNow, orchestratorAssembly, orchestratorMcpTools } = sessionStack;

  // ── 语音播报批（V2 TTS + ③层 LLM 摘要）：TTS adapter + BroadcastService
  //    （fanout 目标 voice-broadcast-bridge 的服务体；闸门读面 = eventStream
  //    连接级 voice 订阅表——零订阅连接 = 零 LLM 零合成零花费，播报开关
  //    默认 off 的落地面）──
  const voiceTts = deps.voiceTtsOverride ?? new DashScopeTtsAdapter({
    getApiKey: () => modelStack.authStore.apiKeyOf(DASHSCOPE_TTS_PROVIDER_ID),
    // 模型配置接入 P0：getModel getter 每次调用读现值（KV voice_model_config
    // 运行期即热；空/未配回落默认常量）
    getModel: () => persistence.voiceModelConfig.current().ttsModel,
  });
  // 流式 TTS 批（V3b-2）：单句流式合成服务（连接池复用 adapter；key 读面
  // 与一次性合成同源——每次调用重读 auth.json，换 key 自动跟随；哑帧修复批
  // 注入 voiceTtsStreamOverride 测试缝）
  const ttsStream =
    deps.voiceTtsStreamOverride ??
    new TtsStreamService({
      adapters: [
        new DashScopeStreamingTtsAdapter({
          getApiKey: () => modelStack.authStore.apiKeyOf(DASHSCOPE_TTS_PROVIDER_ID),
          // 模型配置接入 P0：流式 TTS 模型同源配置（ttsStreamModel 槽位）
          getModel: () => persistence.voiceModelConfig.current().ttsStreamModel,
        }),
      ],
      apiKeyOf: (providerId) => modelStack.authStore.apiKeyOf(providerId),
    });

  // ── 文本管家批（V2.5）：StewardService（fanout 目标 steward-feed-bridge
  //    的服务体 + steward.* 命令族回口）。LLM 面复用 provider 体系：
  //    模型目录 = modelStack 合并目录（modelsView），key = auth.json getter
  //    （每次调用重读，换 key 自动跟随）；模型槽位独立配置（RuntimeConfig
  //    steward.model KV，未设置 = flash 级默认）。money gate：开关关 =
  //    steward.ask 直接拒答零 LLM 调用（服务内单点，服务端权威）──
  const stewardLlm = deps.stewardLlmOverride ?? new PiStewardLlmAdapter({
    models: modelStack.catalog.modelsView(),
    modelSlot: () => persistence.runtimeConfig.get(STEWARD_MODEL_KEY),
    defaultModel: STEWARD_DEFAULT_MODEL,
    getApiKey: (provider) => modelStack.authStore.apiKeyOf(provider),
  });

  // ── 管家记忆 B2：embedding 配置域服务体（端点 CRUD + verify + 解析）。
  //    KV embedding_endpoints；apiKey 明文存储对齐 auth.json 同款（不另造
  //    加密）。（分诊判官接入批上提：判官 face 装配在感知服务之前——
  //    原落位于管家记忆 B6 块，依赖面仅 runtimeConfig/modelStack，上提零
  //    行为变化；后续迁移链原位保留。）
  // 判官目录依赖面（pi-ai variant 消费：目录合并视图 + provider key——与
  // PiStewardLlmAdapter 同源；每判调用惰性重读，换 key/换目录零重启跟随）。
  const judgeServices = {
    getModels: () => modelStack.catalog.modelsView(),
    getApiKey: (provider: string) => modelStack.authStore.apiKeyOf(provider),
  };
  const embeddingConfig = new EmbeddingConfigService({
    config: persistence.runtimeConfig,
    createProbe: (cfg) => new OpenAiCompatEmbeddingAdapter({ getConfig: () => cfg }),
    // B4a：classifier 端点 verify 探测面（分类模型注册表分派——variant
    // 区分实现）——与 createProbe 同构（按目标端点现配一次性构造，探测完即弃）
    createJudgeProbe: (cfg) => makeJudgeAdapter(() => cfg, judgeServices),
  });
  embeddingConfigRef = embeddingConfig; // 晚绑闭合（kg 向量面 buildStack 闭包读现值）

  // 分诊器 LLM 面（管家感知批 M0.5 归一）：任务总结子功能专用槽位沿用
  //（summary.task.model，**无默认模型**——未配置 = 分诊面不可用，语音
  // 播报/notify 走极简终态通知）；可用性三条件在 adapter 处收口：管家开
  // ∧ 总结开 ∧ 模型槽位非空 = **启用**（v2.9 D12-⑫：LLM 分诊启用态恒做，
  // 不看激活）；激活判定不在此处（归感知服务单点，投递面判据）。
  // 原③层独立摘要调用（StewardVoiceSummarizerAdapter）已归一退役。
  const stewardDiagnose =
    deps.stewardDiagnoseOverride ??
    new StewardDiagnosisAdapter({
      llm: new PiStewardLlmAdapter({
        models: modelStack.catalog.modelsView(),
        modelSlot: () => readSummaryConfig(persistence.runtimeConfig).task.model ?? undefined,
        defaultModel: "",
        getApiKey: (provider) => modelStack.authStore.apiKeyOf(provider),
      }),
      enabled: () =>
        persistence.runtimeConfig.get(STEWARD_ENABLED_KEY) === "1" &&
        readSummaryConfig(persistence.runtimeConfig).task.enabled,
    });
  // 感知服务（M0.5 + M0.5-R）：ring 沉淀 + 激活判定 + 分诊编排 + notify 限流。
  // 晚绑闭包（voice sink 在下方 voiceBroadcast 构造后回填——构造环：
  // BroadcastService content 源又指向本服务 supplyBroadcastText；
  // reportDialog 汇报面在下方 stewardService 构造后回填——同款晚绑）。
  // 分诊判官判定面（分诊判官接入批，E-199 第四消费面）：steward.triage.*
  // 配置 + noul 判定收口；judge 真体经 makeJudgeAdapter 注册表分派（换
  // 端点/换变体零重启跟随——与管家记忆判官同款接线形态）；感知服务判定
  // 依赖与 steward.set_config {triage} 组读写同源真体。
  const triageJudge = makeTriageJudgeFace({
    config: persistence.runtimeConfig,
    embeddingConfig,
    judge: makeJudgeAdapter(
      () => resolveTriageJudgeRecord(persistence.runtimeConfig, embeddingConfig),
      judgeServices,
    ),
  });
  // ── M3-a：管家意图判别判定面（判官第五消费面——E-199 注册表预言三次
  //    验证：零改 JudgeAdapterFactory 任何一行，仅组合根新增一次
  //    makeJudgeAdapter 调用 + Pick<JudgePort,"noul"> 窄注入）。与分诊
  //    判官共享开关与端点（steward.triage.* 两键 + 端点解析单源闭包——
  //    「判官判定」一个开关管全部管家判官判定，零新增配置面零 UI）。 */
  const intentJudge = makeIntentJudgeFace({
    config: persistence.runtimeConfig,
    embeddingConfig,
    judge: makeJudgeAdapter(
      () => resolveTriageJudgeRecord(persistence.runtimeConfig, embeddingConfig),
      judgeServices,
    ),
  });
  let voiceBroadcastRef: BroadcastService | undefined;
  let stewardServiceRef: StewardService | undefined;
  // ── M3-d1 感知兑现批：管家活动账（一个账本）────────────────────
  //    ring 六类条目沉淀 + notify 记账 → 统一条目 {at,domain,attribution,text}
  //    （白话铁律）→ 三出口：落盘回看/清理（时间线查询面）+ ask 投影
  //    （StewardService recentActivity）+ 实时帧（broadcastStewardActivity）。
  //    存储形态（AG-06/TR-20 调研裁决）：steward_memory.db 第三连接行式存储
  //    （steward_activity 表——管家域单库聚合 B6 先例；避免 helix.db
  //    runtime_config kv 高频整包重写污染会话/任务热库）；开库失败降级纯
  //    内存（记录不丢、回看降级——对话存储同构兑底）。
  let activityLedgerStore: SqliteActivityLedgerStore | undefined;
  try {
    activityLedgerStore = new SqliteActivityLedgerStore(paths.stewardMemoryDbPath());
  } catch (err) {
    logger.warn(`管家活动账落盘降级（纯内存，重启即失）：${(err as Error).message}`);
  }
  const stewardActivity = new StewardActivityService({
    ...(activityLedgerStore !== undefined ? { store: activityLedgerStore } : {}),
    emit: (payload) => eventStream.broadcastStewardActivity(payload),
    logger,
  });
  const stewardPerception =
    deps.stewardPerceptionOverride ??
    new StewardPerceptionService({
      diagnose: stewardDiagnose,
      triageJudge,
      feedGate: eventStream, // hasStewardSubscribers 窄接口（激活信号①；M0 surface 后升级）
      // progress 薄条目写面（stewardMemory 在下方构造——晚绑闭包；缺席/未装配 = 静默 false）
      memory: {
        recordSessionProgress: (sessionId, text) =>
          stewardMemory !== undefined
            ? stewardMemory.recordSessionProgress(sessionId, text)
            : Promise.resolve(false),
      },
      // M3-d1：notify 发出即旁挂记账（只记不触发——通知链行为零改动）
      emitNotify: (payload) => {
        eventStream.broadcastStewardNotify(payload);
        stewardActivity.recordNotify({ title: payload.title, body: payload.body });
      },
      // M3-d1：ring 六类条目沉淀活动账（既有索引的落盘投影——零新采集面）
      onRingEntry: (entry) => stewardActivity.recordRingEntry(entry),
      // 对话内主动汇报面（M0.5-R：激活态投递面——工作记忆 assistant 记录，
      // 对话回放与 LLM 记忆同源）
      reportDialog: (report) => {
        void stewardServiceRef?.reportProactive(report).catch((err) => {
          logger.warn(`管家对话内主动汇报写入失败（${report.title}）：${(err as Error).message}`);
        });
      },
      voice: {
        enqueueDiagnosed: (item) => voiceBroadcastRef?.enqueueDiagnosed(item),
      },
      // 修复①：回合终态分诊读回复正文（尾投影取末条 assistant——与管家
      // read_session 工具同数据源，单条 300 码点护栏在出口处）
      readReply: async (sessionId) => {
        // 尾深 8（≈2400 字级——用户反馈「总结要详：白话逐项」：6×300 在 600 字逐项下原料偏紧）
        const tail = await persistence.repository.readSessionTail(sessionId, 8);
        if (tail === undefined) return undefined;
        for (let i = tail.length - 1; i >= 0; i -= 1) {
          if (tail[i]!.role === "assistant" && tail[i]!.text.trim() !== "") return tail[i]!.text;
        }
        return undefined;
      },
      // 修复②：投递关注持久化（runtime_config kv 单键快照——跨重启恢复）
      kv: persistence.runtimeConfig,
      logger,
    });
  const voiceBroadcast = new BroadcastService({
    tts: voiceTts,
    gate: eventStream, // hasVoiceSubscribers/voicePreference 窄接口（EventStream 实现 BroadcastGate）
    emit: (payload) => eventStream.broadcastVoice(payload),
    logger,
  });
  voiceBroadcastRef = voiceBroadcast; // 晚绑闭合（感知服务 voice sink 回填）
  // ── 管家记忆 B2：embedding 配置域服务体已在上方构造（分诊判官接入批
  //    上提）；两条一次性迁移链（批B 两级链式，幂等可重跑）：① 旧
  //    steward.memory.* 三键 → memory.* 通用记忆配置域（清旧键，新域已有
  //    值不覆盖）；② 旧 steward.memory.embedding（B1 三字段）→ 首条端点 +
  //    memory.endpointId 指向 + 清旧键（新域非空零动作）。先键位后端点：
  //    B1 老用户的旧 endpointId 指向悬空时，② 产出的新条目 id 优先，防迁移
  //    产物互相覆盖。
  void migrateLegacyStewardMemoryKeys(persistence.runtimeConfig)
    .then((migratedKeys) => {
      if (migratedKeys) logger.info("管家记忆迁移：steward.memory.* 三键已迁入 memory.* 通用记忆配置域（旧键已清）");
      return embeddingConfig.migrateLegacyStewardEndpoint(STEWARD_MEMORY_EMBEDDING_KEY, MEMORY_ENDPOINT_ID_KEY);
    })
    .then((migrated) => {
      if (migrated !== null) logger.info(`管家记忆迁移：旧端点配置已收编为 embedding 配置域首条端点（${migrated}）`);
      // 批1：memory.endpointId 退役迁移（序在键位/端点两级之后——② 产出的
      // memory.endpointId 也要被收编为全局默认端点）；幂等，二次启动零改写
      return migrateMemoryEndpointToDefault(persistence.runtimeConfig, embeddingConfig, (m) => logger.warn(m));
    })
    .then((outcome) => {
      if (outcome === "migrated") logger.info("默认 embedding 端点迁移：memory.endpointId 已收编为 embedding.defaultEndpointId（旧键已清）");
    })
    .catch((err) => logger.warn(`管家记忆迁移失败（旧配置保留，可重试）：${(err as Error).message}`));
  // 总结配置域迁移（一次性幂等；topic_config JSON + steward.sessionmemory.* +
  // steward.summary.* → summary.*，旧键清理——判官 classifyEndpointId 随
  // 判官退役丢弃）。与记忆迁移链并列同款 fire-and-forget（失败旧键保留可重试）。
  void migrateLegacySummaryKeys(persistence.runtimeConfig)
    .then((migrated) => {
      if (migrated) logger.info("总结配置迁移：topic_config/steward.sessionmemory.* /steward.summary.* 已迁入 summary.* 通用域（旧键已清）");
    })
    .catch((err) => logger.warn(`总结配置迁移失败（旧配置保留，可重试）：${(err as Error).message}`));

  // ── 管家记忆 B6：短期记忆消息落盘（steward_memory.db 行式 steward_messages
  //    替代 helix.db runtime_config 整包 KV——append 单行写/可查询/水位独立，
  //    与长期记忆同库不同表）；开库失败降级纯内存（对话照常，重启即失）；
  //    A1 旧 KV 一次性拆行迁移（幂等墓碑）。
  let dialog: StewardDialogMemory | undefined;
  try {
    const dialogStore = new SqliteStewardDialogStore(paths.stewardMemoryDbPath());
    if (migrateStewardDialogKv(dialogStore, persistence.runtimeConfig)) {
      logger.info("管家对话迁移：A1 KV 整包已拆行导入 steward_messages（旧键墓碑）");
    }
    dialog = new StewardDialogMemory(dialogStore);
    logger.info(`管家对话存储就绪：${paths.stewardMemoryDbPath()}`);
  } catch (err) {
    logger.warn(`管家对话存储降级（纯内存，重启即失）：${(err as Error).message}`);
  }

  // 管家记忆 B1：长期记忆编排面装配（全部失败面降级为未装配/缺席——
  // 对话主链路零影响）：vec0 扩展路径二级解析（① 壳 env HELIX_VEC_PATH
  // 注入——AG-08 例外面同 HELIX_RG_PATH 收束本域；② dev 形态 node_modules
  // 平台包 getLoadablePath()，编译单文件形态解析失败靠 ① 级兜底）→
  // better-sqlite3 开库（构造抛错 = 扩展加载失败 → 捕获降级）。
  const stewardMemory: StewardMemoryService | undefined = (() => {
      const vec0Resolution = resolveVec0Path({
        bundlePath: vec0BundlePath,
        nodeModulesPath: (() => {
          try {
            // dev 形态：sqlite-vec npm 包按平台解析 vec0.dylib/.so/.dll
            // （编译单文件形态 import.meta.resolve 失败 → undefined）。
            return sqliteVecLoadablePath();
          } catch {
            return undefined;
          }
        })(),
        probe: (p) => existsSync(p),
      });
      if (vec0Resolution.kind !== "resolved") {
        logger.info(`管家记忆降级（vec0 扩展不可解析）：${vec0Resolution.reasons.join("；")}`);
        return undefined;
      }
      let store: SqliteVecMemoryStore;
      try {
        store = new SqliteVecMemoryStore(paths.stewardMemoryDbPath(), vec0Resolution.path);
        logger.info(`管家记忆存储就绪（source=${vec0Resolution.source}）：${paths.stewardMemoryDbPath()}`);
      } catch (err) {
        logger.warn(`管家记忆降级（vec0 扩展加载失败）：${(err as Error).message}`);
        return undefined;
      }
      const embedding = new OpenAiCompatEmbeddingAdapter({
        // B2：端点配置经 EmbeddingConfigService 解析（endpointId → 条目——
        // 换端点零重建，下一次调用自动跟随）
        getConfig: () => {
          // 批1：向量端点取用改走全局默认端点单点（embedding.defaultEndpointId
          //  ——resolveDefault 全消费面唯一取用；悬空/未设 → null → embed 抛错
          //  降级，与旧 endpointId 引用同款失败语义）
          return embeddingConfig.resolveDefault();
        },
      });
      return new StewardMemoryService({
        config: persistence.runtimeConfig,
        embedding,
        embeddingConfig,
        store,
        // 项目隔离批：progress 写时项目解析——会话写足迹（writeFacts）单项目
        // 归约 → workspace 一级目录名；多项目/无足迹 → undefined（回落
        // global）。总结器/感知两 progress 入口共用（入库点收口，调用面零
        // 签名变化）。批E：memory_search scope 同口径（singleProjectDirOf
        // 单点——复用不复制）。
        resolveSessionProject: (sessionId) =>
          singleProjectDirOf(sessionStack.writeFacts.projectFootprint(sessionId)),
        // B4a 判官真体（分类模型注册表分派，variant 区分实现）：
        // judgeEndpointId 惰性解析 + kind 校验（误指 embedding 端点 →
        // null → noul 抛错降级——判官与召回端点不串用）；judge 挂在
        // 同一 service 上语义正确：vec0 缺席时判了也存不了，不如不判。
        judge: makeJudgeAdapter(() => {
          const judgeEndpointId = persistence.runtimeConfig.get(MEMORY_JUDGE_ENDPOINT_ID_KEY);
          if (judgeEndpointId === undefined || judgeEndpointId === "") return null;
          const record = embeddingConfig.resolveRecord(judgeEndpointId);
          if (record === null || record.kind !== "classifier") return null;
          return record;
        }, judgeServices),
        logger: { warn: (message) => logger.warn(message) },
      });
  })();
  // 记忆 GC 定时器：批 0 起收编 stewardComponents 登记表统一启动（下方
  //  for-of component.start()——60s 首跑 + 24h 周期；TR-152 定时器纪律不变）。
  // 管家引擎模型解析（与 PiStewardLlmAdapter 同一链：steward.model KV →
  // 目录解析 → 缺省 STEWARD_DEFAULT_MODEL——同轨单点）
  const resolveStewardEngineModel = (): ReturnType<typeof resolveModel> =>
    resolveModel(
      modelStack.catalog.modelsView(),
      persistence.runtimeConfig.get(STEWARD_MODEL_KEY) ?? STEWARD_DEFAULT_MODEL,
    );
  // ── surface 批（M0 表面协议地基）：SurfaceRegistry（组合根）——
  //    注册/observe 归一/act 路由/回执销账；sendAction 定向发帧（与广播面
  //    正交），emitLegacyNavigate = 兼容期双发镜像（D8 ③——**M1 前检查点
  //    删除点**，本行是旧帧广播的唯一非 EventStream 接线）。
  const surfaceRegistry = new SurfaceRegistry({
    sendAction: (key, action) => eventStream.sendSurfaceAction(key as FrameSender, action),
    emitLegacyNavigate: (args) => eventStream.broadcastStewardNavigate(args),
  });
  // ── browser adapter 感知批（M1）：BrowserSurfaceAdapter（CDP 事件 →
  //    SurfaceRegistry 归一 surfaceId=`browser:<targetId>` → 感知 ring）。
  //    感知开关 surface.awareness KV（D1 默认 off：off = 零注入零上报）；
  //    第三源接线 = Registry 观察者订阅（D10「生产者不直喂」——管家订阅
  //    总线形态）；FocusState 前台 tab 读面在 adapter（后续消费面接）。
  //    setAwarenessSink 晚绑（CdpConnectionManager 在入口处先构造）。
  const browserSurfaceAdapter = new BrowserSurfaceAdapter({
    registry: surfaceRegistry,
    awarenessOn: () => persistence.runtimeConfig.get(SURFACE_AWARENESS_KEY) === "1",
    // M2 act 执行面：CDP 操作面窄接口（BrowserPort 结构性子集）
    browser: browserPort,
    logger,
  });
  // M2：browser 表面动作执行面注册（SurfaceRegistry act 路由 → adapter.act
  //  ——同一动作管道，D8 不另开通道；回声窗口在 adapter 执行面内开关）。
  surfaceRegistry.registerLocal(browserSurfaceAdapter);
  // M2：管家消费面四泛型工具执行体（surface_list/snapshot/read/act）
  const surfaceActionService = new SurfaceActionService({
    registry: surfaceRegistry,
    browser: browserSurfaceAdapter,
  });
  surfaceRegistry.addObserver((event) => stewardPerception.onSurfaceEvent(event));
  if (browserPort instanceof CdpConnectionManager) {
    browserPort.setAwarenessSink(browserSurfaceAdapter);
  }
  const stewardService = new StewardService({
    llm: stewardLlm,
    ...(dialog !== undefined ? { dialog } : {}),
    memory: stewardMemory,
    triageJudge,
    intentJudge,
    // 项目隔离批：当前项目口径解析（workspace 绑定根 + 一级目录扫描，
    // 与 codegraph/kg 的 projectPath 同源口径；kg 缺省范围批起双消费：记忆
    // 召回 + kg_search/kg_get 缺省范围——resolveKgScope 直接取本口径，不另
    // 造判定）；单项目 → 该项目，多项目/未绑定 → undefined（召回只 global /
    // kg 缺省聚合兑底）。每次 ask/kg 工具调用现扫（毫秒级，重绑跟随）。
    memoryProject: () => {
      const root = workspace.boundRoot();
      if (root === null) return undefined;
      const entries = scanProjectEntries(root);
      return entries.length === 1 ? entries[0]!.name : undefined;
    },
    // 段B翻转：pi 引擎唯一配方装配（driven/steward buildStewardEngine——
    // 生产与测试共用；模型槽位与管家 LLM 同一解析链：steward.model KV →
    // 目录解析 → 缺省 STEWARD_DEFAULT_MODEL）
    createEngine: (opts) =>
      buildStewardEngine({
        systemPrompt: opts.systemPrompt,
        model: resolveStewardEngineModel(),
        apiKeys: () => {
          const table: Record<string, string> = {};
          for (const m of modelStack.catalog.modelsView().getModels()) {
            const key = modelStack.authStore.apiKeyOf(m.provider);
            if (key !== undefined) table[m.provider] = key;
          }
          return table;
        },
        models: modelStack.catalog.modelsView(),
        tools: opts.tools,
        gatedTools: opts.gatedTools,
        persistentListener: opts.persistentListener,
        ...(opts.initialMessages.length > 0 ? { initialMessages: opts.initialMessages } : {}),
        ...(opts.compaction !== undefined
          ? {
              compaction: {
                enabled: true,
                trigger: "request" as const,
                // pi 预留语义映射管家阈值：contextWindow - reserve = threshold
                reserveTokens: Math.max(
                  1024,
                  resolveStewardEngineModel().contextWindow - opts.compaction.thresholdTokens,
                ),
                keepRecentTokens: opts.compaction.keepRecent * 512,
                ...(opts.compaction.summarizeInstructions !== undefined
                  ? { customInstructions: opts.compaction.summarizeInstructions }
                  : {}),
                ...(opts.compaction.summarize !== undefined ? { summarize: opts.compaction.summarize } : {}),
              },
            }
          : {}),
      }),
    // 引擎事件 → domain_events 投影（追踪可见性——instanceId=steward，里程碑
    // 子集；广播面 default→null 不接，防自激语义保持）+ 工具调用监控入账
    //（kind='steward'：__system__ 会话无状态投影，直书口经 SessionRepository
    // → WriteQueue 单写链 __system__ 仓）
    emitEngineEvent: stewardEngineTraceBridge({
      publish: (event) => fanoutPublisher.publish(event),
      nowIso: () => clock.now(),
      recordToolCall: (sessionId, record) => void persistence.repository.recordToolCall(sessionId, record),
    }),
    orchestration: scheduler, // status 只读 + send 写注入（agent_send 等价 steer 通道）
    tasks: taskStack.query, // 任务清单只读面（TaskQueryService.listTasks）
    config: persistence.runtimeConfig, // steward.enabled / steward.model KV 持久化
    feedGate: eventStream, // hasStewardSubscribers 窄接口（连接级订阅闸门）
    // 管家感知批（M0.5）：ask 即激活信号②——感知服务衰减窗点亮（一问即
    // 入激活，响应环点亮主动环，D12-⑪）
    onUserActivity: () => stewardPerception.noteUserActivity(),
    // M3-d1：ask 对话投影——最近活动白话行注入 context_snapshot 活动段
    recentActivity: () => stewardActivity.recent(SNAPSHOT_ACTIVITY_MAX_ENTRIES),
    // 回合终态感知批：投递成功注册关注——目标会话回合结束命中分诊锚
    onDelivered: (sessionId, text) => stewardPerception.noteDelivered(sessionId, text),
    emitFeed: (payload) => eventStream.broadcastStewardFeed(payload),
    // 管家可靠性根修批：确认卡 TTL 作废的 action.completed 广播（与 feed 同
    // 订阅闸——多窗卡栈同步收口）+ 用户提醒帧出口（挂起恢复/确认可达性/TTL
    // 作废三提醒）
    emitActionCompleted: (payload) => eventStream.broadcastStewardActionCompleted(payload),
    // M3-d1：notify 发出即旁挂记账（可靠性提醒同入账——只记不触发）
    emitNotify: (payload) => {
      eventStream.broadcastStewardNotify(payload);
      stewardActivity.recordNotify({ title: payload.title, body: payload.body });
    },
    // 光球健康角标批：子系统健康上报（同态去重/seq 在 EventStream 出口把门）
    emitHealth: (component, status, reason) => eventStream.reportStewardHealth(component, status, reason),
    // M3-a（CAND-601 闭环）：对话内主动汇报实时帧出口（reportProactive 双写
    // ——开着的面板实时冒条目；与 feed/notify 同订阅闸）
    emitProactive: (payload) => eventStream.broadcastStewardProactive(payload),
    // B4a 自动沉淀提案帧出口（与 feed 同订阅闸——判官判定后轮外投递确认卡）
    emitMemoryWritten: (payload) => eventStream.broadcastStewardMemoryWritten(payload),
    // M0 表面协议地基批（D8 navigate 收编）：emitNavigate 域出口改经
    // SurfaceRegistry.act 路由 surface.action {verb:"navigate"}（域工具执行
    // 体不再直接广播页面指令帧）；旧 steward.navigate 由 Registry 兼容镜像
    // 双发（M1 前检查点删除）。risk=write——D3 挂动作（呈现面用户点按闸）。
    emitNavigate: (payload) => surfaceRegistry.act("navigate", { sessionId: payload.sessionId }, { risk: "write" }),
    // M2 表面消费面（四泛型工具执行体——act 经确认闸后走同一动作管道）
    surfaces: surfaceActionService,
    // A2：L1 感知面（快照 + query_recent_work 读面 + create_session 执行面
    // ——与 shell 新建会话同一 startDraftSession 服务路径；entryCount additive）。
    sessions: {
      listSessionMetadata: async () =>
        (await persistence.repository.listSessionMetadata()).map((r) => ({
          sessionId: r.sessionId,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          // L1 投影修复批：显式标题列透传（此前在此断链——repo 已返回、
          // 管家投影拿不到，标题会话全部显示「（无主题）」）；动态主题批：
          // 演进主题 topic 同步透传（displayTitle 管家侧组装 title > topic > firstUserText）。
          ...(r.title != null ? { title: r.title } : {}),
          ...(r.topic != null ? { topic: r.topic } : {}),
          firstUserText: r.firstUserText,
          entryCount: r.entryCount ?? null,
        })),
      startDraftSession: (text, mode) => registry.startDraftSession(text, undefined, undefined, mode),
      // 修复批① 死锁链：createSession 执行体改调同轨专用入口——零消息零引擎，
      // 显式建立即 INSERT（title 进 meta 列）
      createTitledSession: (title) => registry.createTitledSession(title),
      // 驾驶舱批：session 存在性 + session 级投递执行面——投递走目标会话
      // ChatService.sendMessage（内部自动分流：运行中 → steer 队列（复用主
      // 会话 steer 机制）、空闲 → 新轮次——与用户在该会话页直接输入同语义）。
      // 冷会话经 registry.get 懒加载（不存在抛 SessionNotFoundError → 引导式
      // detail）；chatRouter 不在此处接（构建序在其后，且 registry 即同一路由源）。
      // B1 两段式（设计稿 §3.4）：source="steward"（投递与手动输入可辨）+
      // fireAndForget 受理即回（对齐手动 chat.send handler void 模式——idle
      // 全轮不再阻塞确认链；同步拒绝段照常抛错经 action.completed 交代，
      // 轮次内失败走会话事件面）。
      sessionExists: (sessionId) => registry.sessionExists(sessionId),
      // 语音闭环批 ④：轻量单会话标题查询（提案短名/在途摘要数据源——repo 点读
      // 不拉全表；title > topic > firstUserText）
      sessionTitleOf: (sessionId) => persistence.repository.readSessionTitle(sessionId),
      // progress 批 M3：尾部消息投影透传（repo 单行点读，单条已截 300）
      readSessionTail: (sessionId, tailEntries) => persistence.repository.readSessionTail(sessionId, tailEntries),
      deliverToSession: async (sessionId, text) => {
        try {
          const runtime = registry.peek(sessionId) ?? (await registry.get(sessionId));
          const outcome = await runtime.chatService.sendMessage(text, undefined, "steward", { fireAndForget: true });
          // 语音闭环批 ④：回执带目标会话短标题（查表直拼零 LLM——不念
          // sessionId；标题缺失回退现文案）
          const title = await persistence.repository.readSessionTitle(sessionId);
          return {
            delivered: true,
            detail:
              outcome.mode === "steered"
                ? formatDeliverReceipt(title, "steered", sessionId)
                : formatDeliverReceipt(title, "new", sessionId),
          };
        } catch (err) {
          return { delivered: false, detail: (err as Error).message };
        }
      },
    },
    // A2：kg 项目解析面（workspace 持有者读现值——重绑跟随新栈；未绑定 →
    //  resolve undefined / hasIndex false，引导式引导用户先绑 workspace）。
    projects: {
      resolve: (project) => workspace.stack()?.projectService.resolve(project),
      hasIndex: (projectRoot) => workspace.stack()?.projectService.hasIndex(projectRoot) ?? false,
    },
    // 批A：kg 只读检索面（管家开放 kg_search/kg_get——只挂 query 面零写，
    // 与 CoreToolExecutor 同先例；渲染语义复用 createKgTool；workspace 重绑
    // 跟随——读口惰性取现值，未绑定 = 引导式降级）。
    kg: createStewardKgSource({
      queryOf: () => workspace.stack()?.queryService,
      kgProjects: () =>
        workspace
          .stack()
          ?.projectService.listProjects()
          .filter((row) => row.status !== "absent")
          .map((row) => row.path) ?? [],
    }),
    // A2：任务创建面（task_create 同款引擎通道——paramsSchema 校验在引擎，
    //  TaskError message 原样透传；createdBy 词表封闭 "page"|"chat"，管家
    //  归 chat 宿主语义）。code-review 前置 git 仓判定（fs 注入——application
    //  零直接 IO）。
    taskEngine: taskStack.taskEngine,
    // .git 存在性（目录或文件——worktree 形态 .git 是文件）均算 git 仓
    hasGitRepo: (projectRoot) => existsSync(path.join(projectRoot, ".git")),
    logger,
  });
  stewardServiceRef = stewardService; // 晚绑闭合（感知服务对话内主动汇报面回填）
  // ── 批 0（DDD 重构）生命周期登记表：管家域服务统一启停（原两处手工挂
  //    点——reliability 定时器/GC 定时器——收编一处；后续新增管家域服务
  //    实现 StewardComponent 登记即入，不再各自挂 shutdown，排查 #11 根修）──
  const stewardComponents: readonly StewardComponent[] = [
    stewardService,
    ...(stewardMemory !== undefined ? [stewardMemory] : []),
  ];
  for (const component of stewardComponents) component.start();
  // 确认链路修复批④：daemon 启动清场广播——此刻内存 pending 必空集（不持久
  //  化），对启动时已在册的订阅连接撤旧卡（通常零连接；主清场路径 =
  //  steward.subscribe 受理回发快照对账——跨重启 shell 重连即收）。
  eventStream.broadcastStewardPendingSnapshot({ actionIds: stewardService.pendingSnapshot() });

  // U2 观测态晚绑闭合：trace 面板 main displayState 的会话运行态读口
  // 接 registry（此前冷会话 idle 兑底）
  traceSessionRunOf.of = (sessionId) => registry.sessionRunStateOf(sessionId);
  schedulerLate = scheduler; // 链 A 晚绑闭合：instanceStateOf 读面接调度器现值

  // ── T2.2 晚绑闭合：task.changed 广播单点 + 编排服务真体回填──
  //    AF-T1.5.2：引擎出站钩子经同一 EventStream.broadcastTaskChanged 通路
  //（生命周期三命令在 handler 层已接——不双发）；编排服务（M29 切片，
  // assembly/buildTaskOrchestrator）消费 scheduler（批次 spawn 占预算/收口
  // 读面/kill）+ 任务域依赖面（buildTaskStack 同源）。
  broadcastTaskChanged = (frame) => eventStream.broadcastTaskChanged(frame);
  orchestratorService = buildTaskOrchestrator({
    stewardPerception, // 管家感知批（M0.5）：job 终态回调第二消费者（任务级完成锚，title 机械字段 M0.5-R）
    // D2 kg-bootstrap 硬闸（批1）：任务开工检查默认 embedding 端点（resolveDefault 单点）
    hasDefaultEmbeddingEndpoint: () => embeddingConfig.resolveDefault() !== null,
    orchestratorCore: taskStack.orchestratorCore,
    scheduler,
    resolveSubagentModelId,
    orchestratorAssembly,
    orchestratorMcpTools,
    resourceService: sessionStack.resourceService,
    persistence,
    modelStack,
    workspace,
    grep: {
      rgPath: grepFreeze.kind === "rg" ? grepFreeze.rgPath : undefined,
      unavailableReasons: grepFreeze.kind === "unavailable" ? grepFreeze.reasons : undefined,
    },
    clock,
    logger,
    paths,
    toolCwdNow,
    eventStream,
    llmOverride: deps.orchestratorLlmOverride,
  });

  // ── W1 晚绑闭合：workspace 广播与活跃 agent 判定接 eventStream/registry
  //    现值（构造序：WorkspaceService 先于 buildSessionStack 建立以驱动
  //    restore，回调面在此闭合——与 wsServer 同款回填模式）。──
  broadcastWorkspaceChanged = (root) => eventStream.broadcastWorkspaceChanged({ root });
  hasActiveAgentNow = () =>
    // 热会话运行态（主实例）或调度器存活实例（SubAgent）任一命中即拒
    registry.hotRuntimes().some((r) => r.chatService.agentState !== "idle") ||
    registry.hotRuntimes().some((r) => scheduler.hasActiveInstances(r.sessionId));
  unloadSessionsOnRebind = () => registry.unloadAll();

  // ── resources.changed 订阅（§4.2.3：refreshAssembly 先定义、订阅注册后置——
  //    结构保证取代注释保证；发布方 ResourceService 经 deps 函数字段注入） ──
  resourceEvents.subscribe((event) => sessionStack.refreshAssembly(event.kind));

  // ── web 族（契约 v0.7）：CDP 连接状态变更 → web.status.changed 全连接
  //    广播（SYSTEM_SESSION_ID；DTO 组装与 web.status 查询回执同源 =
  //    handlers/web.ts webStatusPayloadOf——getStatus + listTabs）。退订归
  //    shutdown（先退订再 stop——stop 自身触发的 idle 变更不再广播）。──
  const unsubscribeBrowserStatus = browserPort.onStatusChange(() =>
    void webStatusPayloadOf(browserPort).then((payload) => eventStream.broadcastWebStatusChanged(payload)),
  );

  // ── mcp 批：MCP 注册表单例 + 启动异步预热（到位即推，不阻塞启动）──
  //    ① config.mcpServers → 逐 server addServer（独立 try——单 server 失败
  //       降级 error 状态不阻塞其它）；
  //    ② 状态订阅双消费：running/error/stopped → mcp.status.changed 全连接
  //       广播（设置页徽标数据源）；**running 时同步刷新装配三 kind**
  //       （main-session + subagent-worker + orchestrator）→ refreshAssembly 重算
  //       catalog（新工具名进生效集）+ 活跃会话 appendTools + setTools 直改
  //       （下一 turn 生效）；stopped（remove）同样刷新（工具面收缩）。
  //       orchestrator 虽零活跃直改（会话短生命周期），快照重算让下一编排
  //       会话拿到 MCP 工具名——F4 修复前漏接此 kind，orchestrator 的 MCP
  //       工具经 orchestratorMcpTools 注册而快照永不到达（注册而不可达）。
  //    预热 fire-and-forget：daemon 服务先起，MCP 工具陆续到位。──
  let mcpShutdown: (() => void) | undefined; // shutdown 钩子（buildDrivingAdapters deps 消费）；mcpRegistry 无条件构造（上方），此块非条件形态
  {
    const unsubscribeMcpStatus = mcpRegistry.onStatusChange((status) => {
      eventStream.broadcastMcpStatusChanged({ server: status });
      if (status.state === "running" || status.state === "stopped") {
        // catch 兑底：shutdown 窗口的迟到刷新（关库后 status 事件才回流）
        // 静默降级——unhandled rejection 会击穿测试进程（mcp-ws ③ 实证）
        sessionStack.refreshAssembly("main-session").catch(() => {});
        sessionStack.refreshAssembly("subagent-worker").catch(() => {});
        sessionStack.refreshAssembly("orchestrator").catch(() => {});
      }
    });
    for (const serverConfig of persistence.mcpConfig.listConfigs()) {
      void mcpRegistry.addServer(serverConfig).catch(() => {
        // addServer 内部已降级（error 状态 + lastError）——此处兑底不可达路径
      });
    }
    mcpShutdown = () => {
      unsubscribeMcpStatus();
      mcpRegistry.stopAll();
    };
  }

  // ── 旧格式迁移第二批（M5 切片迁 assembly/bootPrelude；一次性幂等，模型栈
  //    就绪后）：config.json 含 model/apiKeys → auth.json / SQLite 默认表 +
  //    config.json 重写瘦身形态。──
  await migrateLegacyModelConfig({ legacy, persistence, paths, config, logger, modelStack });

  // ── driving 接线阶段一（M29 切片，assembly/buildDrivingAdapters）：
  //    chatRouter + stdout 发布器 + CLI——须在 wireEventFanout 之前
  //   （stdoutPublisher 是 fan-out 六目标之一），全部惰性闭包。──
  const { chat: chatRouter, stdoutPublisher, cli } = buildCliDriving({
    registry,
    sessionService,
    cliInput: deps.cliInput,
    cliOutput: deps.cliOutput,
    // M3-d1：CLI 对话行 → 用户在场信号 + cli: 域会话登记（当前会话即 CLI
    // 会话——chatRouter sendMessage 同一解析口径）
    onCliInput: () => {
      stewardPerception.noteUserActivity();
      stewardActivity.noteCliSession(registry.currentSessionId());
    },
  });

  // ── 会话总结器批①：SessionSummaryService（fanout 目标 session-summary-bridge
  //    的服务体）。配置面 = summary.* 通用域（SummaryConfigStore 五键——键位/
  //    解析/迁移单源 application/summary/summaryConfig.ts，运行期即热）；
  //    生成面复用管家 LLM 适配器形态（独立实例——模型槽位 = summary.model →
  //    adapter 默认 flash，显式配才产进展+记忆点）；同一锚点一次调用三产物
  //    （topic/progress/记忆点），记忆点入库走 remember 两段查重闸（E-214，
  //    source=session-summary）+ 显式 remember 防双写闸；烂输出整体丢弃下
  //    锚点幂等重试。判官（漂移判定）随「只出标题」降级形态评估退役——
  //    「保持」哨兵在 topic 字段内自带判别（findings：TR-234 supersede）。──
  const summaryConfig = new SummaryConfigStore(persistence.runtimeConfig);
  // ── 知识库配置组（批2 WP-C「知识库」配置组：config.get/set_kg 回口——
  //    查重阈值 kg.similarityWarn/kg.similarityDup；KV 单源 + 读面裁决单点
  //    application/services/kg/kgConfig.ts，运行期即热；**后续 kg 新增可配置
  //    项归宿同组**（D4））。──
  const kgConfig = new KgConfigStore(persistence.runtimeConfig);
  kgConfigRef = kgConfig;
  const sessionSummaryService =
    deps.sessionSummaryOverride ??
    new SessionSummaryService({
      readConfig: () => summaryConfig.current(),
      llm: new PiStewardLlmAdapter({
        models: modelStack.catalog.modelsView(),
        // 槽位回落链（批①收编后单源）：summary.model → adapter 默认 flash
        modelSlot: () => readSummaryConfig(persistence.runtimeConfig).model ?? undefined,
        defaultModel: STEWARD_DEFAULT_MODEL,
        getApiKey: (provider) => modelStack.authStore.apiKeyOf(provider),
      }),
      resolveTarget: (sessionId) => {
        const runtime = registry.peekHotRuntime(sessionId);
        if (runtime === undefined) return undefined;
        const view = runtime.chatService.sessionView;
        const entries = view.entryList();
        const firstUser = entries.find((e): e is (typeof e) & { role?: string; text?: string } => "role" in e && e.role === "user");
        const firstAssistant = entries.find((e): e is (typeof e) & { role?: string; text?: string } => "role" in e && e.role === "assistant");
        return {
          title: view.title,
          topic: view.currentTopic(),
          turnCount: view.turnCount,
          recentUserTexts: recentUserTextsOf(entries, 10),
          // 总结素材：轮次对投影（user + 同轮末条 assistant = 最终结论）
          recentTurnPairs: recentTurnPairsOf(entries, 6),
          ...(firstAssistant !== undefined && typeof firstAssistant.text === "string"
            ? { firstAssistantText: [...firstAssistant.text].slice(0, 500).join("") }
            : {}),
          firstUserText: firstUser?.text ?? null,
          updateTopic: (topic, previous, anchorTurn) => runtime.chatService.updateTopic(topic, previous, anchorTurn),
        };
      },
      // progress/记忆点写面（stewardMemory 缺席 = 降级不产——总结器 deps 可选语义）
      ...(stewardMemory !== undefined
        ? {
            progressStore: {
              recordSessionProgress: (sessionId: string, text: string) =>
                stewardMemory.recordSessionProgress(sessionId, text),
            },
            memoryPointsStore: {
              rememberMemoryPoint: (point: { text: string; kind: "fact" | "preference"; domain: "habit" | "general" | "project" }, sessionId: string) =>
                stewardMemory.rememberSessionMemoryPoint(point.text, point.kind, point.domain, sessionId),
              explicitRememberedSince: (since: number) => stewardMemory.explicitRememberedSince(since),
            },
          }
        : {}),
      // 记忆落盘通知（memory_written 通知卡链——自动沉淀换轨后沿用 B5 契约）
      emitMemoryWritten: (payload) => eventStream.broadcastStewardMemoryWritten(payload),
      announceTopicChanged: (sessionId) => registry.announceTopicChanged(sessionId),
      logger: { warn: (message) => logger.warn(message) },
    });

  // ── fan-out 六目标装配（装配序步 5；带名注册表序 = 语义唯一权威，§4.2.4） ──
  wireEventFanout(fanoutPublisher, {
    registry,
    sessionService,
    eventStream,
    writeQueue: persistence.writeQueue,
    stdoutPublisher,
    // U4：占用协调桥（turn 轮末对账 + 实例终态摘除）
    coordination: sessionStack.coordination,
    // 语音播报批（V2 TTS）：终态三事件 → 粗筛/模板/合成/广播桥
    // 文本管家批（V2.5）：生命周期事件 → 粗筛/模板文本行/feed 帧桥
    steward: stewardService,
    // 管家感知批（M0.5）：agent 终态 + 周期进展 → ring 沉淀 + 分诊锚桥
    perception: stewardPerception,
    // 会话总结器批①：主实例完成轮 → 三产物总结桥（末位旁路面）
    sessionSummary: sessionSummaryService,
  });

  // ── 装配序步 6：typed 回填面闭合（§4.2.5——scheduler↔registry 构造环
  //    走 backfill；闭合先于 initialize，两步间无任何回调触发点） ──
  // 契约 v0.3 §1 规则②：spawn 时刻锚计算。扫描面与快照路径同源
  // （SnapshotMapper.toSnapshotDto merged 段同语义）：domain entries + toolCall
  // 记录按时间升序合并后扫——tool 执行不落 domain Entry（独立 toolCalls 集合），
  // 只扫 entries 会把锚落在 agent_spawn 工具调用之前（实时卡片位置 bug）。
  // lastMainAnchorId 只用数组序不掺 ts 排序——合并后须先排好再扫；并列稳定
  // （entries 组内原序在前，与快照路径 .sort 稳定语义一致）。
  // 冷会话理论不可达——spawn 必经热会话门面，防御 null 流首。
  backfill.computeSpawnAnchor = (sessionId: string) => {
    const runtime = registry.peek(sessionId);
    if (runtime === undefined) return null;
    const mainId = runtime.chatService.sessionView.mainInstanceId;
    // kind 判别归一（T10a）：锚扫描基元（projection 单源）的 "main 归属" 判定
    // 按缺省=main 语义工作——主实例归属条目（会话主 id / legacy "main"）
    // 归一为缺省后扫描，语义与快照路径（DTO 省略编码）一致
    const anchorOf = (list: readonly AnchorScanEntry[]): string | null =>
      lastMainAnchorId(
        list.map((e) => ({ ...e, instanceId: isMainInstanceId(e.instanceId, mainId) ? undefined : e.instanceId })),
      );
    const entries = runtime.chatService.sessionView.toSnapshot().entries;
    const toolCalls = runtime.chatService.toolCallData;
    // 无 tool 调用记录：防御路径与旧语义一致（聚合 entries 数组序直扫）
    if (toolCalls.length === 0) return anchorOf(entries);
    const merged: AnchorScanEntry[] = [
      ...entries.map((entry) => ({ key: Date.parse(entry.createdAt), entry: entry as AnchorScanEntry })),
      ...toolCalls.map((record) => ({
        // toolCallEntryDto 同源 ts 口径：startedAt → endedAt → 0
        key:
          record.startedAt !== undefined
            ? Date.parse(record.startedAt)
            : record.endedAt !== undefined
              ? Date.parse(record.endedAt)
              : 0,
        // id = toolCallId（toolCallEntryDto 同）；instanceId 缺省 = main 天然是锚候选
        entry: { id: record.id, instanceId: record.instanceId } satisfies AnchorScanEntry,
      })),
    ]
      .sort((a, b) => a.key - b.key)
      .map((item) => item.entry);
    return anchorOf(merged);
  };
  // T10a kind 判别读面闭合：EventStream（engine.error 抑制/条目归属编码）
  // 查会话主实例 id；冷会话理论不可达（事件只自热运行时发布）
  backfill.mainInstanceIdFor = (sessionId: string) =>
    registry.peek(sessionId)?.chatService.sessionView.mainInstanceId;
  // AD-3 两级链（T12）：spawn 会话快照模型源退役——SubAgent 模型只认自身
  // profile 链（resolveSubagentModelId 单点供给 spawn 透传/快照），不继承会话选择。

  // ── 装配序步 7：启动恢复（全量元数据 + 懒加载）：全部会话元数据可见
  //    （session.list 读面），当前会话（最近活动）显式热加载（同步读面/CLI
  //    兼容）；首启无持久化 → 新建空会话。 ──
  // initialize 仍在 fan-out 目标装配**之后**（惯例保持——起 createFresh
  // 不再发布 instantiated，但转正 promoteDraft / created 补广播等运行期事件
  // 同样依赖目标已装配；中间构造块 sessionService/chatRouter/cli 均为惰性闭包）。
  await registry.initialize();

  // ── 任务引擎启动恢复扫描（§4.4/F2.3，T1.3 钩子）：running/pending 任务断点
  //    续跑（in-flight 批次 failed 收口走自动重试；幂等种子集合双防护）；
  //    paused 不自动续（恢复归显式 task.resume）。──
  const taskRecovery = await taskStack.taskEngine.recoverOnStartup();
  if (taskRecovery.resumedJobIds.length > 0) {
    logger.info(`任务恢复扫描：${taskRecovery.resumedJobIds.length} 个任务续跑（编排重开）`);
  }

  // ── kg 族命令回口解析器群（M29/M30 切片，assembly/buildKgResolverGroup）：
  //    四解析器同接缝——workspace 现值 stack + 任务栈组装，memoizedByStack
  //    按 stack 记忆化（重绑原子换栈自动跟随；未绑定 → undefined 防御契约）。──
  const kgResolvers = buildKgResolverGroup({
    stack: () => workspace.stack(),
    taskEngine: taskStack.taskEngine,
    taskStore: taskStack.orchestratorCore.store,
    skills: taskStack.orchestratorCore.skills,
  });

  // ── driving 接线阶段二（M29 切片，assembly/buildDrivingAdapters）：
  //    system 门面 + dev token/静态产物 + 编排/模型门面 + WS 服务——
  //    initialize 与任务恢复扫描之后（端口绑定时刻不变）；running/wsServer
  //    可变态与 shutdown 序列封装在切片内。──
  const { system, ws, devToken, orchestration: currentOrchestration, model: modelService } = buildWsDriving({
    portConfig, // config.get/set_port 回口（effectivePort 晚绑 ws.port）
    sandboxConfig: persistence.sandboxConfig, // config.get/set_sandbox 回口（沙箱开关批）
    summaryConfig, // config.get/set_summary 回口（总结配置组；同容器单例，与 SessionSummaryService 同源）
    kgConfig, // config.get/set_kg 回口（知识库配置组；批2 查重闸——同容器单例）
    askService, // ask.answer 命令回口（提权申请批；同容器单例，与工具装配同源）
    registry,
    scheduler,
    resolveSubagentModelId,
    chat: chatRouter,
    persistence,
    modelStack,
    taskStack,
    // T3 diff.get 命令回口（轮次 diff 查询面——sessionStack 透传）
    diff: sessionStack.diff,
    // U1 manifest 去抖收尾（shutdown flush——测试 tmpdir 复活竞态免疫）
    manifestStore: sessionStack.manifestStore,
    kgResolvers,
    resourceService,
    // skill-content 批：skill 正文读面——任务栈扫描器同形同源复用（scan
    // 现拍同名命中 + 读文件；未知名/读取失败 → undefined，handler 回
    // invalid_payload）。user/project 层技能可编辑，故每次现拍现读
    skillContentOf: async (name) => {
      const hit = (await taskSkillSource.scan()).skills.find((s) => s.name === name);
      if (hit === undefined) return undefined;
      try {
        return { filePath: hit.filePath, content: await readFile(hit.filePath, "utf8") };
      } catch {
        return undefined;
      }
    },
    // skills 添加批：用户级技能创建写面——同一扫描器实例承担（权威校验
    // + 落盘 <skillsHome>/<name>/SKILL.md；applied 后下次 scan 即见）
    skillCreateOf: (content: string) => taskSkillSource.createSkill(content),
    subagentLauncher,
    eventStream,
    browserPort,
    // 语音播报批 V2：voice 族三命令回口（TTS 与 BroadcastService 同源 adapter）
    voice: {
      tts: voiceTts,
      stream: eventStream,
      ttsStream,
    },
    // 文本管家批 V2.5：steward 族六命令回口（StewardService + feed 订阅面）
    steward: {
      service: stewardService,
      stream: eventStream,
      // M3-d1：活动账查询/清理回口（时间线页数据源；未装配 = handler 降级
      // 空清单——零 unimplemented）
      activity: stewardActivity,
    },
    // surface 批（M0 表面协议地基）：surface 族四命令回口（SurfaceRegistry
    // ——注册/事件上行/回执只转发不决策）
    surface: {
      registry: surfaceRegistry,
    },
    // 管家记忆 B2：embedding 配置域回口（EmbeddingConfigService——端点
    // CRUD + 连通测试；只转发不决策）
    embedding: {
      service: embeddingConfig,
    },
    // 三方平台批：provider 族三命令回口（CustomProviderService——自定义
    // OpenAI 兼容平台 CRUD + 活目录同步；key/verify 走既有 auth 族）。
    // 实例在 sessionStack 前提前构造（SubAgent 透传读面同源，见上方）。
    provider: {
      service: customProviderService,
    },
    // mcp 批：mcp 族六命令依赖面——registry 单例 + 配置窄写面闭包
    //（整段替换 config.mcpServers → writeConfig 全字段序列化；readonly →
    //  可变规范化在此单点，handler 面零类型噪音。config 对象是启动
    // loadConfig 产物，旧迁移路径同一对象写回——同源无分叉）。
    mcp: {
      registry: mcpRegistry,
      saveServers: async (servers) => {
        // config 瘦身批：整段替换落 mcp_server 表（WriteQueue 单写通道；
        // 序列化/规范化在 McpConfigStore——config.json 不再承载 MCP 声明面）
        await persistence.mcpConfig.replaceAll(
          servers.length > 0
            ? servers.map((s) => ({
                name: s.name,
                command: s.command,
                ...(s.args !== undefined ? { args: [...s.args] } : {}),
                ...(s.env !== undefined ? { env: { ...s.env } } : {}),
                ...(s.cwd !== undefined ? { cwd: s.cwd } : {}),
                ...(s.enabled !== undefined ? { enabled: s.enabled } : {}),
                ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
              }))
            : [],
        );
      },
    },
    workspace,
    config,
    paths,
    lock,
    logger,
    unsubscribeBrowserStatus,
    ...(mcpShutdown !== undefined ? { stopMcp: mcpShutdown } : {}),
    // 批 0（DDD 重构）生命周期登记表停面：管家域全部服务统一 stop
    // （原 stopStewardMemoryGc + stopStewardReliabilityTimers 两挂点收编）
    stopStewardComponents: () => {
      for (const component of stewardComponents) component.stop();
    },
    port: resolvedPort, // 完整解析链（argv > KV > 7333）已定格
    // stale-indicator 批：welcome daemonFreshness 比对基准（进程启动时刻单源）
    daemonStartedAtMs: bootedAtMs,
    staticDir: deps.staticDir,
    tailSize: deps.tailSize,
  });

  // config.get_port 回口晚绑回填：实际监听端口（0=随机时 ws.port 为分配值）
  bindEffectivePort(ws.port);

  logger.info(`daemon 启动：home=${paths.home} 默认模型=${persistence.defaultModel.current()}（模型位已迁 SQLite 默认表 + auth.json，config.json 瘦身）`);

  return {
    paths,
    config,
    chat: chatRouter,
    session: sessionService,
    system,
    logger,
    ws,
    devToken,
    subagentLauncher,
    orchestration: currentOrchestration,
    model: modelService,
    resource: resourceService,
    directory: registry,
    task: taskStack.taskEngine,
    taskQuery: taskStack.query,
    browser: browserPort,
    registry,
    writeFacts: sessionStack.writeFacts,
    workspace,
    toolCwdNow,
    fanoutTargets: fanoutPublisher.targets,
    resourceEvents,
    runCli: () => cli.run(),
    shutdown: system.shutdown,
  };
}

// singleProjectDirOf 批E 迁至 ./assembly/singleProjectDir（双消费共享：
// progress 写入 scope + memory_search scope；口径不变）
