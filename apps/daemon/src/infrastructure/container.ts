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
import { ResourceService } from "../application/services/ResourceService";
import { WsServerAdapter } from "../adapters/driving/ws-server/WsServerAdapter";
import { webStatusPayloadOf } from "../adapters/driving/ws-server/handlers/web";
import { lastMainAnchorId, type AnchorScanEntry } from "@helix/protocol"; // 锚扫描基元单源 projection
import { isMainInstanceId } from "../domain/agent/AgentInstance";
import { SubagentLauncher } from "../adapters/driven/subagent/SubagentLauncher";
import { CdpConnectionManager } from "../adapters/driven/cdp/CdpConnectionManager";
import { createPaths, osHomeDir, builtinSkillsDir, type HelixPaths } from "./paths";
import { ensureConfigTemplate, loadConfig, writeConfig, type DaemonConfig, type LegacyModelConfig } from "./config";
import { resolveRgPath } from "../adapters/driven/tools/grep/resolve-rg";
import { resolveCodegraphPath } from "../adapters/driven/codegraph-engine/resolve-codegraph";
import { buildEditToolDeps, buildKnowledgeStack } from "./assembly/buildKnowledgeStack";
import { createOrchestratorSessionFactory } from "./assembly/orchestrator-runtime";
import { TaskOrchestratorService } from "../application/services/task/TaskOrchestratorService";
import type { TaskOrchestratorStarterPort } from "../application/ports/outbound/TaskOrchestratorStarterPort";

/** W2-D R13 job 终态同步提示文案随编排服务切片迁 assembly/buildTaskOrchestrator（M29）。 */
import { scanWorkspaceProjects, existingKgProjects } from "../adapters/driven/workspace-scan";
import type { ClosureFindingsSink } from "../application/services/scheduler/ClosureRecorder";
import { freezeGrepBackend, probeRgVersion, RG_PROBE_TIMEOUT_MS } from "../adapters/driven/tools/grep/freeze-backend";
import { accessSync, constants as fsConstants } from "node:fs";
import { rm } from "node:fs/promises";
import { createFileLogger, type Logger } from "./logging";
import { acquireSingletonLock, type SingletonLock } from "./lifecycle";
import { buildPersistence } from "./assembly/buildPersistence";
import { buildModelStack } from "./assembly/buildModelStack";
import { buildTaskStack } from "./assembly/buildTaskStack";
import { buildKgResolverGroup } from "./assembly/buildKgResolverGroup";
import { buildTaskOrchestrator } from "./assembly/buildTaskOrchestrator";
import { buildCliDriving, buildWsDriving } from "./assembly/buildDrivingAdapters";
import { hasActiveJob } from "../application/services/kg/job-activity";
import type { TaskStorePort } from "../application/ports/outbound/TaskStorePort";
import { buildSessionStack, type AssemblyBackfill, type EngineAssemblyMode, type MainSessionLlmOverride } from "./assembly/buildSessionStack";
import { SkillScanner } from "../adapters/driven/pi-engine/SkillScanner";
import { FanoutPublisher, wireEventFanout, type NamedFanoutTarget } from "./assembly/wireEventFanout";
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
 * （ws-server / cli）→ 返回句柄。演进史见 docs/decisions/ADR-composition-root.md。
 * M29 切片：kg 解析器群（buildKgResolverGroup）/ 任务编排服务
 * （buildTaskOrchestrator）/ driving 接线两阶段（buildDrivingAdapters）
 * 均归 infrastructure/assembly（AG-02④ 豁免面），装配顺序语义不变。
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
  /** WS 监听端口覆盖（0 = 随机；缺省取 config.port——真实启动面）。 */
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
 * rg 可执行探测（resolve-rg 的 probe 注入面，装配层唯一实现）：存在且可执行。
 * 抛错（ENOENT/EACCES 等）一律视为不可用——与 resolve-rg 的保守降级语义同调。
 */
function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 共享装配核心（组合根接缝， §4.3）：生产 createDaemon 与测试工厂
 * createTestDaemon 的公共装配序——启动序前置产物由入口传入（deps），
 * 本函数只做装配不做形态决断（async：重启恢复需读盘）。
 */
export async function assembleDaemon(deps: AssembleDaemonDeps): Promise<Daemon> {
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
  const config = deps.config;
  const legacy = deps.legacy;

  // ── grep 后端启动定格（AD-2/F3.1/F3.2，AF-1 权威语义：装配层一次性──
  //    resolve-rg 二级解析（bundle → config；无 PATH 级——版本不可控与──
  //    pin 确定性相悖）+ rg --version 探针（2s 超时/退出码 0），结果内存──
  //    定格——进程生命周期内不重新解析、不升级）──
  // HELIX_RG_PATH 的 process.env 读取收束于本组合根（AG-08 唯一例外面，
  // 壳注入的资源定位参数，非配置源）；resolve-rg.ts 本体零 env/fs 依赖。
  // 定格产物经 buildSessionStack → CoreToolExecutor 注入 grep 门面（rg 单
  // 后端：unavailable 定格时工具响亮失败，无 TS 兜底）。
  const rgResolution = resolveRgPath({
    bundlePath: process.env.HELIX_RG_PATH,
    configPath: config.rgPath,
    probe: isExecutableFile,
  });
  const rgProbe =
    rgResolution.kind === "resolved"
      ? await probeRgVersion(rgResolution.path, RG_PROBE_TIMEOUT_MS)
      : undefined;
  const grepFreeze = freezeGrepBackend(rgResolution, rgProbe);
  if (grepFreeze.kind === "rg") {
    logger.info(`grep 后端定格 rg（source=${grepFreeze.source}）：${grepFreeze.rgPath}`);
  } else {
    logger.warn(`grep 后端定格 unavailable（工具将响亮失败）：${grepFreeze.reasons.join("；")}`);
  }

  // ── codegraph 引擎二级解析定格（T2.1/AF-2，TR-AD-32 同模式）──────
  //    HELIX_CODEGRAPH_PATH 的 process.env 读取收束于本组合根
  //    （AG-08 唯一例外面，壳注入的资源定位参数，非配置源）；
  //    resolve-codegraph.ts 本体零 env/fs 依赖。二级全 miss ≠ 装配失败：
  //    引擎面定格不可用（binaryPath=null），构建面 degraded（AF-2）。──
  const codegraphResolution = resolveCodegraphPath({
    bundlePath: process.env.HELIX_CODEGRAPH_PATH,
    configPath: config.codegraphPath,
    probe: isExecutableFile,
  });
  if (codegraphResolution.kind === "resolved") {
    logger.info(`codegraph 引擎定格（source=${codegraphResolution.source}）：${codegraphResolution.path}`);
  } else {
    logger.info(`codegraph 引擎不可用（构建面 degraded，AF-2）：${codegraphResolution.reasons.join("；")}`);
  }

  // ── 装配序步 2-4：持久化族 → 模型域 → 会话/运行面（architecture §4.2.2） ──
  const persistence = buildPersistence({ paths, logger });

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
  const modelStack = buildModelStack({ paths, logger });
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
    projectSkillsDir: path.join(bootCwd, ".helix", "skills"),
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
    // 链 A（⑤）：批次实例调度态读面（任务页 parked 徽标数据源）——晚绑闭包
    // 读 scheduler 现值（sessionStack 在本块之后建，构造窗口零调用）
    instanceStateOf: (agentId) => schedulerLate?.status(agentId)[0]?.state,
    // F3.6 级联扩展：任务报告目录（批次报告 md/findings 旁路/summary.md）
    // 随任务同灭——force:true 幂等（目录不存在不炸），库级联成功后调用
    removeTaskReportDir: (jobId) => rm(path.join(paths.home, "reports", `task:${jobId}`), { recursive: true, force: true }),
  });
  // P0① 回填：kg 栈 projectService 的 bootstrapRunning 查询面接任务库现值
  taskStoreForProjectRows = taskStack.orchestratorCore.store;

  // ── fan-out 发布面（先建，服务构造即依赖它；目标归 wireEventFanout 装配） ──
  const fanoutPublisher = new FanoutPublisher(logger);

  // ── driven：CDP 浏览器连接（地基；无独立 proxy/HTTP 层，连接内嵌 daemon）──
  // lazy 连接——装配不触网；homeDir 经 paths.ts 单点取（AG-07：adapter 不直接展开主目录）。
  const browserPort: BrowserPort = deps.browserPort;

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
    browserPort,
    events: fanoutPublisher,
    publishResourceChanged: (kind) => resourceEvents.publish({ kind }),
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
    // 主会话 plan 三工具装配面（main-session plan 批）：instanceId = sessionId
    // 作用域；写面 = 父进程 LazyWorkLedger 直连 helix.db（同库 WAL 跨进程
    // 安全）；执行成功后装配层广播 session.plan.changed + 快照附 plan 读面
    //（SubAgent 子进程本地栈不受影响——两栈独立）
    mainPlan: {},
    // spawn 派发任务切片注入（F1.3）：任务文本 → 图查询 → digest+指针切片
    // 拼入 task 约束区；注入后 markInjected 入跨通道去重注册表（T3.2 同源）。
    // W1：未绑定 → 空切片（无图查询面，零副作用）。audience（D8 W-R6）：
    // SubAgent spawn 链传 "worker"（协议行 findings 申报措辞），主会话
    // ChatService 链传/缺省 "main"（kg-update 直落措辞）——buildSessionStack 按消费链分叉。
    taskInjector: (sessionId, task, audience) =>
      workspace.stack()?.queryService.injectTaskSlice(sessionId, task, audience) ?? "",
    // findings 落账管道（F3.0，T4.1）：closure findings → KgWriteService 唯一
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
  const { resourceService, subagentLauncher, scheduler, eventStream, registry, sessionService, resolveSubagentModelId, toolCwdNow, orchestratorAssembly } = sessionStack;
  schedulerLate = scheduler; // 链 A 晚绑闭合：instanceStateOf 读面接调度器现值

  // ── T2.2 晚绑闭合：task.changed 广播单点 + 编排服务真体回填──
  //    AF-T1.5.2：引擎出站钩子经同一 EventStream.broadcastTaskChanged 通路
  //（生命周期三命令在 handler 层已接——不双发）；编排服务（M29 切片，
  // assembly/buildTaskOrchestrator）消费 scheduler（批次 spawn 占预算/收口
  // 读面/kill）+ 任务域依赖面（buildTaskStack 同源）。
  broadcastTaskChanged = (frame) => eventStream.broadcastTaskChanged(frame);
  orchestratorService = buildTaskOrchestrator({
    orchestratorCore: taskStack.orchestratorCore,
    scheduler,
    resolveSubagentModelId,
    orchestratorAssembly,
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

  // ── 旧格式迁移（一次性，幂等）：config.json 含 model/apiKeys →
  //    写新位（auth.json / SQLite 默认表）+ config.json 重写瘦身形态 ──
  if (legacy.model !== undefined || legacy.apiKeys !== undefined) {
    for (const [providerId, apiKey] of Object.entries(legacy.apiKeys ?? {})) {
      await modelStack.authStore.setKey(providerId, apiKey);
    }
    if (legacy.model !== undefined) await persistence.defaultModel.set(legacy.model);
    writeConfig(paths.configPath(), config);
    logger.info(
      `已迁移旧配置：model → SQLite 默认模型表（${legacy.model ?? "无"}）；` +
        `apiKeys → ${paths.authPath()}（${Object.keys(legacy.apiKeys ?? {}).length} 项）；config.json 已重写瘦身形态`,
    );
  }

  // ── driving 接线阶段一（M29 切片，assembly/buildDrivingAdapters）：
  //    chatRouter + stdout 发布器 + CLI——须在 wireEventFanout 之前
  //   （stdoutPublisher 是 fan-out 六目标之一），全部惰性闭包。──
  const { chat: chatRouter, stdoutPublisher, cli } = buildCliDriving({
    registry,
    sessionService,
    cliInput: deps.cliInput,
    cliOutput: deps.cliOutput,
  });

  // ── fan-out 六目标装配（装配序步 5；带名注册表序 = 语义唯一权威，§4.2.4） ──
  wireEventFanout(fanoutPublisher, {
    registry,
    sessionService,
    eventStream,
    writeQueue: persistence.writeQueue,
    stdoutPublisher,
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
    registry,
    scheduler,
    resolveSubagentModelId,
    chat: chatRouter,
    persistence,
    modelStack,
    taskStack,
    kgResolvers,
    resourceService,
    subagentLauncher,
    eventStream,
    browserPort,
    workspace,
    config,
    paths,
    lock,
    logger,
    unsubscribeBrowserStatus,
    port: deps.port,
    staticDir: deps.staticDir,
    tailSize: deps.tailSize,
  });

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
    workspace,
    toolCwdNow,
    fanoutTargets: fanoutPublisher.targets,
    resourceEvents,
    runCli: () => cli.run(),
    shutdown: system.shutdown,
  };
}
