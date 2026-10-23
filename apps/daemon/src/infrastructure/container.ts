import path from "node:path";
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
import { webStatusPayloadOf } from "../adapters/driving/ws-server/handlers/web";
import type { InstanceState } from "../domain/agent/AgentInstance";
import type { JobStatus } from "../domain/task/types";
import { SubagentLauncher } from "../adapters/driven/subagent/SubagentLauncher";
import { CdpConnectionManager } from "../adapters/driven/cdp/CdpConnectionManager";
import { createPaths, osHomeDir, builtinSkillsDir, type HelixPaths } from "./paths";
import { ensureConfigTemplate, loadConfig, type DaemonConfig, type LegacyModelConfig } from "./config";
import { McpRegistry } from "../adapters/driven/mcp/McpRegistry";
import { createOrchestratorSessionFactory } from "./assembly/orchestrator-runtime";
import { TaskOrchestratorService } from "../application/services/task/TaskOrchestratorService";
import type { TaskOrchestratorStarterPort } from "../application/ports/outbound/TaskOrchestratorStarterPort";

/** W2-D R13 job 终态同步提示文案随编排服务切片迁 assembly/buildTaskOrchestrator（M29）。 */
import type { ClosureFindingsSink } from "../application/services/scheduler/ClosureRecorder";
import { rm, readFile } from "node:fs/promises";
import { createFileLogger, type Logger } from "./logging";
import { acquireSingletonLock, installCrashLogging, type SingletonLock } from "./lifecycle";
import { buildPersistence } from "./assembly/buildPersistence";
import { installProxyFetch } from "../adapters/driven/network/proxy-fetch";
import { buildStewardStack } from "./assembly/buildStewardStack";
import { buildWorkspaceStack } from "./assembly/buildWorkspaceStack";
import { startWorkspaceTmpSweeper } from "./workspaceTmpSweeper";
import { wireMcpWarmup } from "./assembly/mcpWarmup";
import { computeSpawnAnchorOf, mainInstanceIdForOf } from "./assembly/spawnAnchor";
import { wireSessionStack } from "./assembly/wireSessionStack";
import { buildSummaryStack } from "./assembly/buildSummaryStack";
import { AskService } from "../application/services/AskService";
import type { SessionRunStateLike } from "../domain/agent/ObservabilityState";
import { buildModelStack } from "./assembly/buildModelStack";
import { buildTaskStack } from "./assembly/buildTaskStack";
import { buildKgResolverGroup } from "./assembly/buildKgResolverGroup";
import { buildTaskOrchestrator } from "./assembly/buildTaskOrchestrator";
import { buildCliDriving, buildWsDriving } from "./assembly/buildDrivingAdapters";
import { freezeSearchBackends, migrateLegacyModelConfig, migrateLegacyRuntimeConfig, resolveWsPort } from "./assembly/bootPrelude";
import { KgTriageAutoTrigger } from "../application/services/kg/KgTriageAutoTrigger";
import type { AssemblyBackfill, EngineAssemblyMode, MainSessionLlmOverride } from "./assembly/buildSessionStack";
import { SkillScanner } from "../adapters/driven/pi-engine/SkillScanner";
import { FanoutPublisher, wireEventFanout, type NamedFanoutTarget } from "./assembly/wireEventFanout";
import { TtsStreamService } from "../application/tts/TtsStreamService";
import type { DomainEvent } from "../domain/events/DomainEvent";
import { CustomProviderService } from "../application/services/CustomProviderService";
import type { StewardLlmPort } from "../application/ports/outbound/StewardLlmPort";
import type { StewardDiagnosisPort } from "../application/ports/outbound/StewardDiagnosisPort";
import { StewardPerceptionService } from "../application/steward/StewardPerceptionService";
import type { TtsPort } from "../application/ports/outbound/TtsPort";
import { createResourceEventBus, type ResourceEventBus } from "./assembly/resource-events";
import type { WorkspaceService } from "../application/services/workspace/WorkspaceService";

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
 * P5 切片（体量门）：按域分组把接线密集段迁 assembly——会话栈依赖面组装
 * （wireSessionStack）/ 管家域全栈（buildStewardStack）/ 总结与配置组
 * （buildSummaryStack）/ workspace 绑定面（buildWorkspaceStack）/ MCP 预热
 * （mcpWarmup）/ 回填面锚计算（spawnAnchor）；本文件保留容器骨架、装配序
 * 编排与返回值。切片判据与晚绑回填处置见各切片头注释。
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
  // 锁释放兜底（评审 low #30）：拿到锁后到装配成功之前任何抛错（loadConfig
  // 配置损坏/assembleDaemon 中途失败）都必须释放 daemon.lock——否则遗留锁
  // 下次启动被当陈锁接管并误报「上次非正常退出」（previousCrash 假信号）。
  let assembled: Daemon;
  try {
    // 配置：首次创建模板（0600，AG-09）+ 加载（瘦身：纯运行参数；旧
    // 格式 model/apiKeys 读入 legacy 由装配核心迁移落新位）
    ensureConfigTemplate(paths.configPath());
    const loaded = loadConfig(paths.configPath());
    assembled = await assembleDaemon({
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
  } catch (err) {
    lock?.release(); // 幂等
    throw err;
  }
  return assembled;
}

/**
 * 共享装配核心（组合根接缝， §4.3）：生产 createDaemon 与测试工厂
 * createTestDaemon 的公共装配序——启动序前置产物由入口传入（deps），
 * 本函数只做装配不做形态决断（async：重启恢复需读盘）。
 */
export async function assembleDaemon(deps: AssembleDaemonDeps): Promise<Daemon> {
  let restoreProxyFetch = () => {};
  try {
    return await assembleDaemonCore(deps, (restore) => { restoreProxyFetch = restore; });
  } catch (error) {
    restoreProxyFetch(); // 启动中途失败也释放进程级包装，不保留已关库的 getter。
    throw error;
  }
}

async function assembleDaemonCore(
  deps: AssembleDaemonDeps,
  onProxyInstalled: (restore: () => void) => void,
): Promise<Daemon> {
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

  // ── 网络代理批（进程级 globalThis.fetch 单点代理包装）：必须紧跟
  //    buildPersistence（ProxyConfigStore 就绪）且先于任何 adapter 构造
  //    （STT/TTS/embedding/model-catalog 构造期捕获 globalThis.fetch 值
  //    ——晚于此处安装则拿到未包装引用）。运行期即热：每次请求读
  //    store 现值；loopback/非法配置直连。生命周期结束必须卸载。──
  const stopProxyFetch = installProxyFetch(() => persistence.proxyConfig.current());
  onProxyInstalled(stopProxyFetch);

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
  // ── workspace 绑定面（W1 绑定闭环，P5 体量门拆分迁 assembly/
  //    buildWorkspaceStack）：绑定状态机唯一事实源 + 绑定 kg 栈持有者
  //    （重绑接缝）。物化时机不变：unbound boot 零扫描零同步零开库——栈只在
  //    restore 成功/open 成功/初始绑定后建。四类晚绑引用（任务库/embedding
  //    配置域/kg 配置域/kg-triage 触发器）随切片内聚并经 assign 回填；广播/
  //    活跃 agent 判定/会话卸载宿主闭包在切片内读现值（eventStream/registry
  //    在 buildSessionStack 后才存在——同款回填模式）。──
  const workspaceAssembly = await buildWorkspaceStack({
    persistence,
    codegraphResolution,
    logger,
    hosts: {
      broadcast: (root) => broadcastWorkspaceChanged(root),
      hasActiveAgent: () => hasActiveAgentNow(),
      unloadSessions: () => unloadSessionsOnRebind(),
    },
    initialRoot: deps.kgWorkspaceRoot,
  });
  const workspace = workspaceAssembly.workspace;

  // 清理纪律批机械面（TR-301）：绑定 workspace 的 .helix/tmp 定时清仓——
  //  60s 首轮 / 24h 节奏 / 7d 过龄，未绑定空转（unbound 零扫描）；rebind 经
  //  boundRoot 现值天然跟随。shutdown 停面经 buildWsDriving deps
  // （stopStewardComponents 同模式，可选字段）。
  const tmpSweeper = startWorkspaceTmpSweeper({
    currentRoot: () => workspace.boundRoot(),
    logger,
  });

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
  let broadcastTaskChanged: (frame: { jobId: string; changed: "job" | "stage" | "batch"; status?: JobStatus }) => void = () => {};
  let orchestratorService: TaskOrchestratorService | undefined;
  /** 调度器晚绑引用（⑤ 链 A：任务栈 instanceStateOf 闭包读现值）。 */
  let schedulerLate: { status(agentId?: string): { state: InstanceState }[] } | undefined;
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
  workspaceAssembly.assign.taskStore(taskStack.orchestratorCore.store);

  // ── fan-out 发布面（先建，服务构造即依赖它；目标归 wireEventFanout 装配） ──
  const fanoutPublisher = new FanoutPublisher(logger);

  // ── 提权申请批：AskService 单例（main executor 与 SubagentLauncher wire
  //    转发两端同持；KV pending 恢复在会话清单就绪后调 restoreFromKv）──
  const askService = new AskService({
    publish: (event) => fanoutPublisher.publish(event),
    kv: persistence.runtimeConfig,
    now: () => clock.nowMs(),
    newId: () => `ask-${crypto.randomUUID().slice(0, 8)}`,
    // 提权自动通过（autoApprove 配置）：每次申请现值判定（运行期即热）——
    // 勾选后立即生效，与沙箱开关装配期定格不同（TR-175：透传参显式书写）
    autoApprove: () => persistence.sandboxConfig.current().autoApprove,
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

  // ── 装配序步 2-4 会话/运行面接线（P5 体量门拆分，迁
  //    assembly/wireSessionStack）：依赖面组装片——持久化族/模型域/任务栈/
  //    workspace 持有者/启动定格产物 + 晚绑闭包（memory_search 读 stewardMemory
  //    现值、批次收口转投编排服务）在此闭合，构造仍归 buildSessionStack。──
  const sessionStack = await wireSessionStack({
    paths,
    config,
    logger,
    clock,
    persistence,
    modelStack,
    taskStack,
    workspace,
    askService,
    customProvidersOf: () => customProviderService.list(),
    browserPort,
    fanoutPublisher,
    resourceEvents,
    mcpRegistry,
    backfill,
    grepFreeze,
    codegraphResolution,
    engineMode: deps.engineMode,
    mainSessionLlmOverride: deps.mainSessionLlmOverride,
    subagentRunnerOverride: deps.subagentRunnerOverride,
    toolCwd: deps.toolCwd,
    builtinSkillsDir: deps.builtinSkillsDir,
    sessionIdleUnloadMs: deps.sessionIdleUnloadMs,
    sessionIdlePollMs: deps.sessionIdlePollMs,
    findingsSinkOverride: deps.findingsSinkOverride,
    stewardMemoryOf: () => stewardMemory,
    onInstanceClosure: (agentId) => orchestratorService?.handleInstanceClosure(agentId),
  });

  const { resourceService, subagentLauncher, scheduler, eventStream, registry, sessionService, resolveSubagentModelId, toolCwdNow, orchestratorAssembly, orchestratorMcpTools } = sessionStack;

  // ── 装配序步 3：管家域（P5 体量门拆分，迁 assembly/buildStewardStack）：
  //    语音播报（TTS + BroadcastService）/ 管家 LLM 面 / 记忆 B1+B2+B6 /
  //    感知分诊（M0.5）/ 活动账 / surface 表面协议 / StewardService +
  //    生命周期登记表——整域按原构造序迁出（AG-02④ 豁免面），本处原位
  //    调用，晚绑回填物（voiceBroadcastRef/stewardServiceRef）在切片内闭合。
  //    本域三服务是 fan-out 目标服务体，故仍在 wireEventFanout 之前。──
  const stewardStack = buildStewardStack({
    paths,
    logger,
    clock,
    persistence,
    modelStack,
    taskStack,
    eventStream,
    scheduler,
    registry,
    workspace,
    writeFacts: sessionStack.writeFacts,
    browserPort,
    fanoutPublisher,
    vec0BundlePath,
    voiceTtsOverride: deps.voiceTtsOverride,
    voiceTtsStreamOverride: deps.voiceTtsStreamOverride,
    stewardDiagnoseOverride: deps.stewardDiagnoseOverride,
    stewardPerceptionOverride: deps.stewardPerceptionOverride,
    stewardLlmOverride: deps.stewardLlmOverride,
  });
  const {
    voiceTts,
    ttsStream,
    embeddingConfig,
    stewardActivity,
    stewardPerception,
    stewardService,
    stewardMemory,
    surfaceRegistry,
    stewardComponents,
  } = stewardStack;
  workspaceAssembly.assign.embeddingConfig(embeddingConfig); // 晚绑闭合（kg 向量面 buildStack 闭包读现值）


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

  // ── mcp 批：MCP 启动预热 + 状态帧接线（P5 体量门拆分，迁
  //    assembly/mcpWarmup——逐 server 预热 + running/stopped 同步刷新装配
  //    三 kind 的语义见切片头注释；fire-and-forget 不阻塞启动）。──
  const mcpShutdown = wireMcpWarmup({
    mcpRegistry,
    mcpConfig: persistence.mcpConfig,
    eventStream,
    refreshAssembly: (kind) => sessionStack.refreshAssembly(kind),
  });


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

  // ── 会话总结器 + 配置组（P5 体量门拆分，迁 assembly/buildSummaryStack）：
  //    summary.* 配置域 + kg.* 配置域 + SessionSummaryService（fan-out 目标
  //    session-summary-bridge 服务体）——原位调用，构造序语义不变。──
  const summaryStack = buildSummaryStack({
    persistence,
    modelStack,
    registry,
    eventStream,
    stewardMemory,
    logger,
    sessionSummaryOverride: deps.sessionSummaryOverride,
  });
  const { summaryConfig, kgConfig, sessionSummaryService } = summaryStack;
  workspaceAssembly.assign.kgConfig(kgConfig); // 晚绑闭合（kg 向量面 buildStack 闭包读现值）


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
  //    走 backfill；闭合先于 initialize，两步间无任何回调触发点）。两字段
  //    装配随 P5 体量门拆分迁 assembly/spawnAnchor（spawn 锚计算 + 主实例 id
  //    读面；扫描面/合并序语义与快照路径同源的推导见切片头注释）。──
  backfill.computeSpawnAnchor = computeSpawnAnchorOf(registry);
  backfill.mainInstanceIdFor = mainInstanceIdForOf(registry);

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

  // ── kg-triage 静默点自动触发（B批，docs/temp/kg-auto-adjudication-design.md
  //    红线修订：全自动→静默点自动）：水位（pending ≥20 或最老 ≥48h）+
  //    静默门（无 pending/running 任务 + 无 active 写租约）+ 6h 冷却，双通道
  //    评估（写入口候选通知防抖 + 30min sweep 兜底）；发起走 KgTriageService
  //    .create 准入复用（createdBy="auto" 审计可溯），启动即扫一遍存量。──
  const kgTriageAutoTrigger = new KgTriageAutoTrigger({
    triage: kgResolvers.kgTriageResolver,
    stack: () => workspace.stack(),
    listJobs: () => taskStack.orchestratorCore.store.listJobs(),
    leases: () => sessionStack.coordination.leases(),
    logger,
  });
  workspaceAssembly.assign.triageTrigger(kgTriageAutoTrigger);
  kgTriageAutoTrigger.start();
  kgTriageAutoTrigger.sweep();

  // ── driving 接线阶段二（M29 切片，assembly/buildDrivingAdapters）：
  //    system 门面 + dev token/静态产物 + 编排/模型门面 + WS 服务——
  //    initialize 与任务恢复扫描之后（端口绑定时刻不变）；running/wsServer
  //    可变态与 shutdown 序列封装在切片内。──
  const { system, ws, devToken, orchestration: currentOrchestration, model: modelService } = buildWsDriving({
    portConfig, // config.get/set_port 回口（effectivePort 晚绑 ws.port）
    sandboxConfig: persistence.sandboxConfig, // config.get/set_sandbox 回口（沙箱开关批）
    proxyConfig: persistence.proxyConfig, // 与 fetch 包装共用配置单源
    stopProxyFetch,
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
                // deferred（懒加载开关）必须同序列化：漏此行则 update 全量
                // 覆盖语义下该位恒回落缺省 true（全量急发经 WS 不可达）
                ...(s.deferred !== undefined ? { deferred: s.deferred } : {}),
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
    stopTmpSweeper: tmpSweeper.stop,
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
