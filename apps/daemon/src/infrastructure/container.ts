import type { SessionChatPort, SendOutcome } from "../application/ports/inbound/ChatPort";
import type { SessionPort } from "../application/ports/inbound/SessionPort";
import type { SystemPort, DaemonStatus } from "../application/ports/inbound/SystemPort";
import type { AgentOrchestrationPort } from "../application/ports/inbound/AgentOrchestrationPort";
import type { SessionDirectoryPort } from "../application/ports/inbound/SessionDirectoryPort";
import type { AgentEnginePort } from "../application/ports/outbound/AgentEnginePort";
import type { ClockPort } from "../application/ports/outbound/ClockPort";
import type { BrowserPort } from "../application/ports/outbound/BrowserPort";
import type { ModelPort } from "../application/ports/inbound/ModelPort";
import type { InstanceRunner } from "../application/services/InstanceRunner";
import { ModelService } from "../application/services/ModelService";
import { SessionRegistry } from "../application/services/SessionRegistry";
import { ResourceService } from "../application/services/ResourceService";
import { DEFAULT_SCHEDULING } from "../domain/agent/SchedulingPolicy";
import { CliAdapter, StdoutEventPublisher } from "../adapters/driving/cli/CliAdapter";
import { WsServerAdapter } from "../adapters/driving/ws-server/WsServerAdapter";
import { webStatusPayloadOf } from "../adapters/driving/ws-server/handlers/web";
import { lastMainAnchorId } from "../adapters/driving/ws-server/DtoMapper";
import { resolveConfigModel } from "../adapters/driven/pi-engine/model-provider";
import { StaticServe } from "../adapters/driven/static-serve/StaticServe";
import { SubagentLauncher } from "../adapters/driven/subagent/SubagentLauncher";
import { CdpConnectionManager } from "../adapters/driven/cdp/CdpConnectionManager";
import { createPaths, osHomeDir, type HelixPaths } from "./paths";
import { ensureConfigTemplate, loadConfig, writeConfig, type DaemonConfig } from "./config";
import { ensureDevToken } from "./dev-token";
import { createFileLogger, type Logger } from "./logging";
import { acquireSingletonLock, type SingletonLock } from "./lifecycle";
import { buildPersistence } from "./assembly/buildPersistence";
import { buildModelStack } from "./assembly/buildModelStack";
import { buildSessionStack, type AssemblyBackfill } from "./assembly/buildSessionStack";
import { FanoutPublisher, wireEventFanout, type NamedFanoutTarget } from "./assembly/wireEventFanout";
import { createResourceEventBus, type ResourceEventBus } from "./assembly/resource-events";

/**
 * 组合根（architecture.md §3.6）：整个 daemon 唯一允许 new 具体实现的地方
 * （AG-02④ 豁免面 = 本文件 + infrastructure/assembly/**——组合根锚面从
 * 单文件扩为目录，语义不变）。依赖图在这里闭合：driven adapter → service →
 * driving adapter 接线，四层内部只见接口。
 *
 * T2.2（AD-4）组合根工厂化：会话相关件（Session 聚合 + ChatService 族 +
 * 会话投影 + 会话绑定引擎/工具）经 SessionRegistry 按需创建/卸载
 * （buildSessionStack 的 buildRuntime/engineFor 工厂是唯一 new 面）；
 * 会话无关全局件（调度器/事件总线/存储/WS 服务器/静态服务）保持单例
 * ——调度预算 daemon 全局一份不随会话数分裂（TR-AD-11/16）。
 *
 * 装配序（T2.2 无容器版重构，architecture §4.2.2）：启动序前置（目录/锁/
 * config）→ 四命名装配函数（buildPersistence → buildModelStack →
 * buildSessionStack）→ wireEventFanout → 晚绑回填闭合 → registry.initialize
 * → driving 接线（ws-server / cli）→ 返回句柄。
 *
 * 持久化（T1.8 + T2.2 分仓）：SQLite WAL `<home>/helix.db`；WriteQueue 是
 * daemon 内唯一 SQLite 写通道（AG-06），每会话独立仓位按 session_id 路由；
 * shutdown 先 drain 写队列再释放锁（优雅退出）。
 *
 * 测试注入口（不进生产路径）：engine（FakeAgentEngine 单实例或按会话工厂）、
 * subagentRunner（integration 驱动收口时序）、CLI 输入输出流（PassThrough）、
 * skipLock/skipConfig（单测并行与 Fake 演示）、sessionTailSize /
 * sessionIdleUnloadMs（G-1/G-5 测试注入面）。
 */
export interface DaemonOptions {
  /** 显式 home（main.ts 已解析 --home；测试指向 tmp 目录）。 */
  readonly home?: string;
  /**
   * 引擎覆盖（测试注入 FakeAgentEngine；缺省装配真 pi 引擎）。
   * T2.2 多会话：传实例 = 全部会话共享（单会话既有测试形态）；传工厂 =
   * 每会话独立引擎（多会话并行测试形态——引擎持有单 run 状态不可并发共享）。
   */
  readonly engine?: AgentEnginePort | ((sessionId: string) => AgentEnginePort);
  /** CLI 输入/输出流覆盖（测试注入 PassThrough）。 */
  readonly cliInput?: NodeJS.ReadableStream;
  readonly cliOutput?: NodeJS.WritableStream;
  /** WS 监听端口覆盖（0 = 随机；测试用；缺省取 config.port）。 */
  readonly port?: number;
  /** 前端静态产物目录覆盖（测试注入 fixture；缺省取 config.staticDir）。 */
  readonly staticDir?: string;
  /** 跳过单例锁（单测并行用；生产不得关闭）。 */
  readonly skipLock?: boolean;
  /**
   * 跳过 config 加载与旧格式迁移（FakeAgentEngine 演示/单测注入；生产不得
   * 关闭）。T2.3（AD-2）判定重定义：本开关只管 config 文件读面；「真引擎
   * 模式」（SubagentLauncher 真体装配）改由 options.engine 是否注入判定
   * ——注入 = 测试 Fake 形态（无子进程），缺省 = 生产（真引擎 + SQLite
   * 默认模型 + auth.json key 源）。
   */
  readonly skipConfig?: boolean;
  /** 工具沙箱 cwd 覆盖（测试指向 tmp；缺省为进程工作区）。 */
  readonly toolCwd?: string;
  /**
   * builtin 层技能目录覆盖（T5 测试注入口：integration 注入空 tmp 目录隔离
   * 恰等断言；缺省 = paths.builtinSkillsDir() 随仓真目录——目录缺失静默跳过）。
   */
  readonly builtinSkillsDir?: string;
  /**
   * SubAgent runner 覆盖（T2.3 测试注入口：integration 注入 fake runner 驱动
   * 收口时序；缺省装配 SubagentLauncher 真体 / skipConfig 占位替身）。
   */
  readonly subagentRunner?: InstanceRunner;
  /**
   * BrowserPort 覆盖（T4 测试注入口：integration 注入 fake BrowserPort 驱动
   * web 族命令/广播断言；缺省装配 CdpConnectionManager 真体——lazy 连接零触网）。
   */
  readonly browser?: BrowserPort;
  /** 主时间轴尾窗大小（G-1：缺省 30；测试注入面）。 */
  readonly sessionTailSize?: number;
  /** 空闲卸载窗口 ms（G-5：缺省 30min；测试注入缩短到秒级）。 */
  readonly sessionIdleUnloadMs?: number;
  /** 空闲卸载轮询间隔 ms（测试注入面；缺省 min(60s, 窗口/10)）。 */
  readonly sessionIdlePollMs?: number;
}

export interface Daemon {
  readonly paths: HelixPaths;
  readonly config: DaemonConfig;
  /** 会话路由对话入口（chatRouter 本体；SessionChatPort = ChatPort 超集）。 */
  readonly chat: SessionChatPort;
  readonly session: SessionPort;
  readonly system: SystemPort;
  readonly logger: Logger;
  /** WS 服务（127.0.0.1；实际监听端口/地址可观测，TP-CL6-1）。 */
  readonly ws: WsServerAdapter;
  /** SubAgent 子进程运行器（T2.2；skipConfig 无 model 配置时不装配）。 */
  readonly subagentLauncher: SubagentLauncher | undefined;
  /** 编排入口（T2.3：spawn/send/status/kill；三工具与 WS 命令的公共回口）。 */
  readonly orchestration: AgentOrchestrationPort;
  /** 模型/认证管理入口（T2.3 AD-2：model 族与 auth 族命令公共回口）。 */
  readonly model: ModelPort;
  /** 资源配置入口（M6 T1：kind 维工具/技能启停 + model 槽位的数据与合取计算面）。 */
  readonly resource: ResourceService;
  /** 会话目录入口（T2.2 AD-4：list/loadHistory/delete/草稿/懒加载取数面）。 */
  readonly directory: SessionDirectoryPort;
  /**
   * 浏览器连接入口（T2 CDP 地基，BrowserPort）：lazy 连接，T3r browser 工具
   * 与 T4 状态协议的消费面；生命周期 = daemon 生命周期（shutdown 挂 stop()）。
   */
  readonly browser: BrowserPort;
  /** 多会话容器（T2.2：生命周期编排观测面——测试断言懒加载/卸载用）。 */
  readonly registry: SessionRegistry;
  /** fan-out 带名注册表（T2.2 §4.2.4：序 = 语义唯一权威——测试断言语义序用）。 */
  readonly fanoutTargets: readonly NamedFanoutTarget[];
  /** 装配级资源事件总线（T2.2 §4.2.3：resources.changed 观测面——不进 WS/不落盘/不进 fan-out）。 */
  readonly resourceEvents: ResourceEventBus;
  /** CLI 主循环（阻塞至 /exit/EOF/二次 Ctrl-C）。 */
  runCli(): Promise<void>;
  /** 优雅关闭：停 WS、停输入、释放锁。 */
  shutdown(): Promise<void>;
}

/**
 * 组装 daemon（async：重启恢复需读盘）。主进程/测试均 await。
 */
export async function createDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  // ── 装配序步 1：装配级事件总线（零依赖 pub/sub，最先构造——循环边解耦锚点，
  //    architecture §4.2.2/§4.2.3）：resources.changed 的唯一通道，
  //    不进 WS/不落盘/不进 fan-out（TP-2.2c 负断言面）。──
  const resourceEvents = createResourceEventBus();
  /** typed 回填面（§4.2.5）：构造早期声明、initialize 前闭合。 */
  const backfill: AssemblyBackfill = {};

  // ── 启动序前置（TR-AD-6/AG-09） ─────────────────────────────
  const paths = createPaths(options.home);
  // 首启序：目录补建必须先于锁获取（daemon.lock 是首个写盘动作，
  // 目录不存在则 ENOENT）——ensureHome 是 home 目录创建的单点（TR-AD-6）。
  paths.ensureHome();
  const lock: SingletonLock | undefined = options.skipLock ? undefined : acquireSingletonLock(paths.lockPath());
  const logger = createFileLogger(paths.logsDir());

  // 配置：首次创建模板（0600，AG-09）+ 加载（T2.3 瘦身：纯运行参数；旧
  // 格式 model/apiKeys 读入 legacy 由下方迁移落新位）
  ensureConfigTemplate(paths.configPath());
  const loaded = options.skipConfig
    ? {
        config: { port: 7333, maxConcurrent: DEFAULT_SCHEDULING.maxConcurrent, maxQueued: DEFAULT_SCHEDULING.maxQueued },
        legacy: {},
      }
    : loadConfig(paths.configPath());
  const config = loaded.config;

  // ── 装配序步 2-4：持久化族 → 模型域 → 会话/运行面（architecture §4.2.2） ──
  const persistence = buildPersistence({ paths, logger });
  const modelStack = buildModelStack({ paths, logger });
  const clock: ClockPort = { now: () => new Date().toISOString(), nowMs: () => Date.now() };

  // ── fan-out 发布面（先建，服务构造即依赖它；目标归 wireEventFanout 装配） ──
  const fanoutPublisher = new FanoutPublisher();

  // ── driven：CDP 浏览器连接（T2 地基；无独立 proxy/HTTP 层，连接内嵌 daemon）──
  // lazy 连接——装配不触网；homeDir 经 paths.ts 单点取（AG-07：adapter 不直接展开主目录）。
  const browserPort: BrowserPort = options.browser ?? new CdpConnectionManager({ homeDir: osHomeDir() });

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
    browserPort,
    events: fanoutPublisher,
    publishResourceChanged: (kind) => resourceEvents.publish({ kind }),
    backfill,
    engine: options.engine,
    subagentRunnerOverride: options.subagentRunner,
    toolCwd: options.toolCwd,
    builtinSkillsDir: options.builtinSkillsDir,
    sessionIdleUnloadMs: options.sessionIdleUnloadMs,
    sessionIdlePollMs: options.sessionIdlePollMs,
  });
  const { resourceService, subagentLauncher, scheduler, eventStream, registry, sessionService } = sessionStack;

  // ── resources.changed 订阅（§4.2.3：refreshAssembly 先定义、订阅注册后置——
  //    结构保证取代注释保证；发布方 ResourceService 经 deps 函数字段注入） ──
  resourceEvents.subscribe((event) => sessionStack.refreshAssembly(event.kind));

  // ── T4 web 族（契约 v0.7）：CDP 连接状态变更 → web.status.changed 全连接
  //    广播（SYSTEM_SESSION_ID；DTO 组装与 web.status 查询回执同源 =
  //    handlers/web.ts webStatusPayloadOf——getStatus + listTabs）。退订归
  //    shutdown（先退订再 stop——stop 自身触发的 idle 变更不再广播）。──
  const unsubscribeBrowserStatus = browserPort.onStatusChange(() =>
    eventStream.broadcastWebStatusChanged(webStatusPayloadOf(browserPort)),
  );

  // ── 旧格式迁移（T2.3，一次性，幂等）：config.json 含 model/apiKeys →
  //    写新位（auth.json / SQLite 默认表）+ config.json 重写瘦身形态 ──
  if (!options.skipConfig && (loaded.legacy.model !== undefined || loaded.legacy.apiKeys !== undefined)) {
    const legacy = loaded.legacy;
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

  // ── 会话路由对话入口（T2.2）：CLI / WS 共用——sessionId 缺省 = 当前会话 ──
  const chatRouter: SessionChatPort = {
    sendMessage: async (text: string, sessionId?: string, images?: readonly string[]): Promise<SendOutcome> => {
      const target = sessionId ?? registry.currentSessionId();
      const runtime = registry.peek(target) ?? (await registry.get(target));
      return runtime.chatService.sendMessage(text, images);
    },
    steer: async (text: string, sessionId?: string, instanceId?: string): Promise<{ entryId: string }> => {
      const target = sessionId ?? registry.currentSessionId();
      const runtime = registry.peek(target) ?? (await registry.get(target));
      // T2.3（契约 v0.3 §3.2）：instanceId 透传——定向/主实例分流判定归 ChatService
      return runtime.chatService.steer(text, instanceId);
    },
    abort: (sessionId?: string): void => {
      // 冷会话无在飞 run（卸载前置条件 = idle）——热会话直接中断
      const target = sessionId ?? registry.currentSessionId();
      registry.peek(target)?.chatService.abort();
    },
  };

  // ── driving：CLI（stdout 事件发布器由组合根构造并注入两侧） ─────
  const stdoutPublisher = new StdoutEventPublisher(options.cliOutput ?? process.stdout);
  const cli = new CliAdapter({
    chat: chatRouter,
    session: sessionService,
    events: stdoutPublisher,
    input: options.cliInput,
    output: options.cliOutput,
  });

  // ── fan-out 六目标装配（装配序步 5；带名注册表序 = 语义唯一权威，§4.2.4） ──
  wireEventFanout(fanoutPublisher, {
    registry,
    sessionService,
    eventStream,
    writeQueue: persistence.writeQueue,
    stdoutPublisher,
  });

  // ── 装配序步 6：typed 回填面闭合（§4.2.5——scheduler↔registry 构造环四面
  //    统一走 backfill；闭合先于 initialize，两步间无任何回调触发点） ──
  // T2.3：spawn 透传当前模型（注册表就绪，热会话可观测）
  backfill.currentModelOf = (sessionId: string) => registry.peek(sessionId)?.chatService.currentModel;
  // T2.1 契约 v0.3 §1 规则②：spawn 时刻锚计算（目标会话聚合 entries 数组序
  // 扫描；冷会话理论不可达——spawn 必经热会话门面，防御 null 流首）
  backfill.computeSpawnAnchor = (sessionId: string) => {
    const runtime = registry.peek(sessionId);
    if (runtime === undefined) return null;
    return lastMainAnchorId(runtime.chatService.sessionView.toSnapshot().entries);
  };
  // AD-3（F1.3）三级链第二级：spawn 会话快照模型源（快照 id → 完整 Model
  // 经 resolveConfigModel 解析，F-14 解析单点同源）
  backfill.spawnModelSource = (instanceId: string) => {
    const snapshot = scheduler.spawnModelOf(instanceId);
    return snapshot === undefined ? undefined : resolveConfigModel(snapshot, modelStack.catalog.modelsView());
  };

  // ── 装配序步 7：启动恢复（T2.2 全量元数据 + 懒加载）：全部会话元数据可见
  //    （session.list 读面），当前会话（最近活动）显式热加载（同步读面/CLI
  //    兼容）；首启无持久化 → 新建空会话。 ──
  // T4：initialize 仍在 fan-out 目标装配**之后**（惯例保持——T4 起 createFresh
  // 不再发布 instantiated，但转正 promoteDraft / created 补广播等运行期事件
  // 同样依赖目标已装配；中间构造块 sessionService/chatRouter/cli 均为惰性闭包）。
  await registry.initialize();

  let running = true;
  let wsServer: WsServerAdapter | undefined;
  // T2.3（AD-2）：model 位数据源改会话级（AD-3 model 族）——当前会话
  // 引擎观测值；冷会话/引擎未暴露 → 全局默认（SQLite 读面 + builtin 兑底）
  const system: SystemPort = {
    // T5.1：getStatus() 是系统级/「当前会话」（注册表最近活跃）读面——仅用于
    // welcome 单会话握手等自洽场景；per-session 帧（session.subscribe / draft
    // 建会话快照）禁止用它盖章（多会话下 current ≠ 目标会话 → 串台，RCA
    // debug/session-switch-state-overwrite-root-cause.md；per-session 帧章
    // 改由 SessionStateView.agentState/model 随视图同源组装）。
    getStatus(): DaemonStatus {
      const sessionId = registry.currentSessionId();
      return {
        running,
        locked: lock !== undefined,
        home: paths.home,
        sessionId,
        // 冷当前会话（被空闲卸载）无执行载体 → idle
        agentState: registry.peek(sessionId)?.chatService.agentState ?? "idle",
        model: registry.peek(sessionId)?.chatService.currentModel ?? persistence.defaultModel.current(),
      };
    },
    async shutdown(): Promise<void> {
      running = false;
      wsServer?.stop(); // 先停 WS（不再接受新连接/命令），再收尾业务
      registry.stop(); // T2.2：停空闲卸载监视定时器
      scheduler.stop(); // T2.1：停 stalled 监视定时器
      registry.sealAll(); // T2.2：全部热会话封口（stopped 里程碑 write-through 落盘）
      await subagentLauncher?.dispose(); // T2.2：O-6 序列回收全部存活子进程（零孤儿）
      unsubscribeBrowserStatus(); // T4：web.status.changed 广播订阅退订（先退订再 stop）
      await browserPort.stop(); // T2：关全部 managed tabs → 断 CDP WS（浏览器侧零残留）
      await persistence.writeQueue.close(); // 优雅退出：drain 全部仓位后关连接（lifecycle 挂点）
      lock?.release();
      logger.info("daemon 已关闭");
    },
  };

  // ── driving：WS 服务（CL-6：127.0.0.1 + hello 握手 + 命令路由 + 事件推送）──
  // dev token 每次启动重写（<home>/dev-token，0600）；静态产物缺失不影响启动
  const token = ensureDevToken(paths.devTokenPath());
  const staticServe = new StaticServe(options.staticDir ?? config.staticDir);
  // 当前会话绑定编排门面（T2.2）：Daemon.orchestration / WS 编排命令共用——
  // spawn 携带当前会话归属 + 当前模型透传（T2.3 AgentInstanceDto.model
  // 填充链）；kill/send/status 按 agentId 全局寻址
  const currentOrchestration: AgentOrchestrationPort = {
    spawn: (task, profileKind) =>
      scheduler.spawn(
        registry.currentSessionId(),
        task,
        profileKind,
        backfill.currentModelOf?.(registry.currentSessionId()),
      ),
    send: (agentId, message) => scheduler.send(agentId, message),
    status: (agentId) => scheduler.status(agentId),
    kill: (agentId) => scheduler.kill(agentId),
  };
  // 模型/认证管理门面（T2.3 AD-2）：WS model.*/auth.* 命令族回口；
  // model.changed 经 EventStream 广播（channel=model，订阅路由）
  const modelService = new ModelService({
    registry,
    catalog: modelStack.catalog,
    auth: modelStack.authStore,
    defaultModel: persistence.defaultModel,
    onModelChanged: (payload) => eventStream.broadcastModelChanged(payload),
  });
  const ws = new WsServerAdapter({
    chat: chatRouter,
    directory: registry,
    system,
    orchestration: currentOrchestration, // T2.3：agent.kill 命令链回调度
    model: modelService, // T2.3（AD-2）：model.*/auth.* 命令族回口
    resource: resourceService, // M6 T3（契约 v0.6）：agent.config 命令族回口
    browser: browserPort, // T4（契约 v0.7）：web 族命令族回口
    hasModel: (id) => modelStack.catalog.hasModel(id), // M6 T3：model 型 set 前置校验
    traceQuery: persistence.traceQuery, // T2.1（CL-5/F5.6）：trace.query 命令回口（只读面）
    events: eventStream,
    token,
    port: options.port ?? config.port,
    staticHandler: (req) => staticServe.handle(req),
    tailSize: options.sessionTailSize,
  });
  wsServer = ws;
  if (!staticServe.active) {
    logger.info(
      `static-serve 未激活（staticDir=${options.staticDir ?? config.staticDir ?? "未配置"}）——前端产物缺失不影响 daemon（T1.7 前属正常）`,
    );
  }
  logger.info(
    `WS 服务监听 ${ws.url}` +
      `；dev token 已写入 ${paths.devTokenPath()}（浏览器侧获取：GET http://127.0.0.1:${ws.port}/helix-dev-token）`,
  );

  logger.info(`daemon 启动：home=${paths.home} 默认模型=${persistence.defaultModel.current()}（模型位已迁 SQLite 默认表 + auth.json，config.json 瘦身）`);

  return {
    paths,
    config,
    chat: chatRouter,
    session: sessionService,
    system,
    logger,
    ws,
    subagentLauncher,
    orchestration: currentOrchestration,
    model: modelService,
    resource: resourceService,
    directory: registry,
    browser: browserPort,
    registry,
    fanoutTargets: fanoutPublisher.targets,
    resourceEvents,
    runCli: () => cli.run(),
    shutdown: system.shutdown,
  };
}
