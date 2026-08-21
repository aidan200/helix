import type { ChatPort, SessionChatPort, SendOutcome } from "../application/ports/inbound/ChatPort";
import type { SessionPort } from "../application/ports/inbound/SessionPort";
import type { SystemPort, DaemonStatus } from "../application/ports/inbound/SystemPort";
import type { AgentOrchestrationPort } from "../application/ports/inbound/AgentOrchestrationPort";
import type { SessionDirectoryPort } from "../application/ports/inbound/SessionDirectoryPort";
import type { AgentEnginePort } from "../application/ports/outbound/AgentEnginePort";
import type { SessionRepositoryPort } from "../application/ports/outbound/SessionRepositoryPort";
import type { EventPublisherPort } from "../application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../application/ports/outbound/ClockPort";
import { ChatService } from "../application/services/ChatService";
import { SessionService } from "../application/services/SessionService";
import { RestoreService } from "../application/services/RestoreService";
import { SchedulerService } from "../application/services/scheduler/SchedulerService";
import { SessionProjection } from "../application/services/SessionProjection";
import { SessionRegistry, type SessionRuntime } from "../application/services/SessionRegistry";
import type { InstanceRunner } from "../application/services/InstanceRunner";
import { SchedulingPolicy, DEFAULT_SCHEDULING } from "../domain/agent/SchedulingPolicy";
// MAIN_INSTANCE_ID 改引协议导出（v0.2 OI 收口，F-2⑬；domain 定义保留 AG-02 例外）
import { MAIN_INSTANCE_ID } from "@helix/protocol";
import path from "node:path";
import { CliAdapter, StdoutEventPublisher } from "../adapters/driving/cli/CliAdapter";
import { WsServerAdapter } from "../adapters/driving/ws-server/WsServerAdapter";
import { EventStream } from "../adapters/driving/ws-server/EventStream";
import { webStatusPayloadOf } from "../adapters/driving/ws-server/handlers/web";
import { lastMainAnchorId } from "../adapters/driving/ws-server/DtoMapper";
import { StaticServe } from "../adapters/driven/static-serve/StaticServe";
import { PiAgentEngineAdapter } from "../adapters/driven/pi-engine/PiAgentEngineAdapter";
import { MainSessionProfile, MAIN_SESSION_SYSTEM_PROMPT } from "../adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SubAgentProfile, SUBAGENT_SYSTEM_PROMPT } from "../adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { DEFAULT_MODEL_ID, resolveConfigModel } from "../adapters/driven/pi-engine/model-provider";
import { ModelCatalog } from "../adapters/driven/pi-engine/model-catalog";
import { DefaultModelStore } from "../adapters/driven/sqlite-session/DefaultModelStore";
import { ResourceStateStore } from "../adapters/driven/sqlite-session/ResourceStateStore";
import { SkillScanner } from "../adapters/driven/pi-engine/SkillScanner";
import { ResourceService } from "../application/services/ResourceService";
import { SystemPromptAssembler } from "../application/services/SystemPromptAssembler";
import { TOOL_PROMPT_SNIPPETS } from "../adapters/driven/tools/ToolPromptSnippets";
import type { ProfileKind } from "../application/ports/outbound/ResourceStatePort";
import { AuthStore } from "./auth-store";
import { ModelService } from "../application/services/ModelService";
import type { ModelPort } from "../application/ports/inbound/ModelPort";
import { SubagentLauncher } from "../adapters/driven/subagent/SubagentLauncher";
import { CoreToolExecutor } from "../adapters/driven/tools/CoreToolExecutor";
import { WriteQueue, MAIN_AGENT_KIND } from "../adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../adapters/driven/sqlite-session/SqliteSessionRepository";
import { SqliteTraceQueryAdapter } from "../adapters/driven/sqlite-session/SqliteTraceQueryAdapter";
import type { TraceQueryPort } from "../domain/trace/TraceQueryPort";
import type { ProfileSnapshotData } from "../domain/events/DomainEvent";
import { createPaths, builtinSkillsDir, osHomeDir, type HelixPaths } from "./paths";
import { ensureConfigTemplate, loadConfig, writeConfig, type DaemonConfig } from "./config";
import { ensureDevToken } from "./dev-token";
import { createFileLogger, type Logger } from "./logging";
import { acquireSingletonLock, type SingletonLock } from "./lifecycle";
import type { BrowserPort } from "../application/ports/outbound/BrowserPort";
import { CdpConnectionManager } from "../adapters/driven/cdp/CdpConnectionManager";

/**
 * 组合根（architecture.md §3.6）：整个 daemon 唯一允许 new 具体实现的地方。
 * 依赖图在这里闭合：driven adapter → service → driving adapter 接线，
 * 四层内部只见接口。
 *
 * T2.2（AD-4）组合根工厂化：会话相关件（Session 聚合 + ChatService 族 +
 * 会话投影 + 会话绑定引擎/工具）经 SessionRegistry 按需创建/卸载（本文件
 * 的 buildRuntime/engineFor 工厂是唯一 new 面）；会话无关全局件（调度器/
 * 事件总线/存储/WS 服务器/静态服务）保持单例——调度预算 daemon 全局一份
 * 不随会话数分裂（TR-AD-11/16）。ChatService:Session 1:1 与 write-through
 * 机制不变（AD-4 取代边界）。
 *
 * 事件接线：fan-out publisher 先建（ChatService/SchedulerService 依赖它构造），
 * 目标（CLI stdout publisher、SessionService 订阅回灌、WS 事件流、WriteQueue
 * 持久化目标、会话投影路由、清单运行态桥）装配后追加——无需构造后回写依赖。
 *
 * injectClosure（T2.2 会话反向查找）：调度器收口回调按实例归属会话寻址
 * 目标 ChatService（原单线闭包指向唯一 ChatService 的形态废弃）；注册表
 * 在调度器之后装配（收口只发生在 spawn 之后，装配窗口内不会被调）。
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
  /** CLI 主循环（阻塞至 /exit/EOF/二次 Ctrl-C）。 */
  runCli(): Promise<void>;
  /** 优雅关闭：停 WS、停输入、释放锁。 */
  shutdown(): Promise<void>;
}

/**
 * 组装 daemon（async：重启恢复需读盘）。主进程/测试均 await。
 */
export async function createDaemon(options: DaemonOptions = {}): Promise<Daemon> {
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

  // ── 持久化（T1.8）：SQLite WAL + 单写队列（AG-06 唯一写通道；T2.2 分仓） ──
  const writeQueue = new WriteQueue(paths.dbPath(), {
    onError: (error, job) => logger.error(`落盘失败（${job.kind}）：${(error as Error).message}`),
  });
  const repository: SessionRepositoryPort = new SqliteSessionRepository(writeQueue);
  // T2.1（CL-5/F5.6，architecture.md §3.5b）：trace 读面 port 手工装配（AF-3：
  // 仓内无 container.bind，同式命名常量）；同库同表只读面，不经单写队列。
  const traceQuery: TraceQueryPort = new SqliteTraceQueryAdapter(writeQueue);
  const clock: ClockPort = { now: () => new Date().toISOString(), nowMs: () => Date.now() };

  // ── AD-2 模型模块地基：auth.json / 默认模型表 / 合并目录 ──────────
  const authStore = new AuthStore(paths.authPath());
  const defaultModel = new DefaultModelStore(writeQueue, DEFAULT_MODEL_ID);
  const catalog = new ModelCatalog({ storePath: paths.modelsStorePath() });

  // ── M6 T1 资源数据域：resource_state 差异行 + 三层技能扫描 + 合取服务 ──
  // tools 全集从两 profile 声明面构建注入（AG-02：application 不得反向
  // import driven 层 profiles——组合根单向传映射表）；project 层技能根
  // 与 toolCwd 同款工作区型判定（启动时定格，不做监听）；builtin 层 =
  // daemon 随仓 resources/skills（T5 第三源，paths 单点派生）。
  const toolCwd = options.toolCwd ?? process.cwd();
  const resourceState = new ResourceStateStore(writeQueue);
  const skillScanner = new SkillScanner({
    userSkillsDir: paths.skillsHome(),
    projectSkillsDir: path.join(toolCwd, ".helix", "skills"),
    builtinSkillsDir: options.builtinSkillsDir ?? builtinSkillsDir(),
    cwd: toolCwd,
  });
  const resourceService = new ResourceService({
    store: resourceState,
    skills: skillScanner,
    toolsCatalog: {
      "main-session": MainSessionProfile.tools,
      "subagent-worker": SubAgentProfile.tools,
    } satisfies Record<ProfileKind, readonly string[]>,
    // M6 T4：list 读面 snippet 透传（SystemPromptAssembler 同源注册表单点）
    toolSnippets: TOOL_PROMPT_SNIPPETS,
    // M6 T2 生效链：toggle applied → 重算该 kind 组装快照 + 刷新活跃 runtime
    // （main 直改 systemPrompt/tools；subagent 只更新快照缓存，spawn 时刻消费）。
    // refreshAssembly 在下方定义（闭包晚绑——toggle 只发生在运行期，TDZ 安全）。
    onApplied: (kind) => refreshAssembly(kind),
  });

  // ── M6 T2 提示组装：三段组装器 + 两 kind 组装快照（启动时定格，toggle 刷新） ──
  // base = 瘦身后 profile 常量（无工具清单，消双源）；工具段从生效集（resolveTools
  // 产物同源）派生；技能段从扫描生效集派生。main 快照供 engineFor（新会话装配
  // 读现值）+ 活跃 runtime 直改推送；subagent 快照供 SubagentLauncher spawn 定格
  // （launch 同步秒回——技能扫描异步，故缓存式：启动与 toggle applied 时重算；
  // resource_state 读面同步读不受此限——已知边界：无 toggle 的技能文件增删要
  // 下次 toggle/重启才进提示，M6 §六「profile 全集变更不触发运行期刷新」同族）。
  const promptAssembler = new SystemPromptAssembler({ toolSnippets: TOOL_PROMPT_SNIPPETS });
  const assemblyBase = (kind: ProfileKind): string =>
    kind === "main-session" ? MAIN_SESSION_SYSTEM_PROMPT : SUBAGENT_SYSTEM_PROMPT;
  const computeAssembly = async (
    kind: ProfileKind,
  ): Promise<{ readonly tools: readonly string[]; readonly systemPrompt: string }> => {
    const tools = resourceService.getEffectiveTools(kind);
    const skills = await resourceService.getEffectiveSkills(kind);
    return {
      tools,
      systemPrompt: promptAssembler.assemble({ basePrompt: assemblyBase(kind), toolNames: tools, skills }),
    };
  };
  let mainAssembly = await computeAssembly("main-session");
  let subagentAssembly = await computeAssembly("subagent-worker");
  /** toggle applied 后的重算入口（T3 WS 命令复用面：命令只调 toggle，刷新单点在此）。 */
  const refreshAssembly = async (kind: ProfileKind): Promise<void> => {
    const next = await computeAssembly(kind);
    if (kind === "main-session") {
      mainAssembly = next;
      // 活跃 runtime 直改（setModel 同构）：systemPrompt 重算 + tools 重 resolve，
      // 下一 turn 生效（in-flight 不变）。model 槽位不在此链（读面生效，见 engineFor）。
      for (const runtime of registry.hotRuntimes()) {
        runtime.chatService.setSystemPrompt(next.systemPrompt);
        runtime.chatService.setTools(next.tools);
      }
    } else {
      subagentAssembly = next; // 已 spawn 实例 env 已定格（代际生效，零刷新）
    }
  };

  // ── 旧格式迁移（T2.3，一次性，幂等）：config.json 含 model/apiKeys →
  //    写新位（auth.json / SQLite 默认表）+ config.json 重写瘦身形态 ──
  if (!options.skipConfig && (loaded.legacy.model !== undefined || loaded.legacy.apiKeys !== undefined)) {
    const legacy = loaded.legacy;
    for (const [providerId, apiKey] of Object.entries(legacy.apiKeys ?? {})) {
      await authStore.setKey(providerId, apiKey);
    }
    if (legacy.model !== undefined) await defaultModel.set(legacy.model);
    writeConfig(paths.configPath(), config);
    logger.info(
      `已迁移旧配置：model → SQLite 默认模型表（${legacy.model ?? "无"}）；` +
        `apiKeys → ${paths.authPath()}（${Object.keys(legacy.apiKeys ?? {}).length} 项）；config.json 已重写瘦身形态`,
    );
  }

  // ── 事件 fan-out（先建目标容器，服务构造即依赖它） ──────────────
  const publisherTargets: EventPublisherPort[] = [];
  const fanout: EventPublisherPort = {
    publish: (event) => {
      for (const target of publisherTargets) target.publish(event);
    },
    publishDelta: (delta) => {
      for (const target of publisherTargets) target.publishDelta(delta);
    },
  };

  // ── driven：SubAgent 子进程运行器（T2.2：SubagentLauncher 真体，O-7 候选 A）──
  // T2.3（AD-2）装配判定重定义：生产模式 = 未注入 engine（options.engine
  // 缺省）——真子进程 runner + SQLite 默认模型源 + auth.json key 源；
  // 测试注入 engine（Fake 形态）→ 不装真体，退回占位告警替身。
  // options.subagentRunner 为测试注入口（优先级最高）。
  const subagentLauncher =
    options.engine === undefined
      ? new SubagentLauncher({
          profile: SubAgentProfile,
          // 三级链第三级（AD-3）：全局兜底现值解析（set_default 后新子进程跟随）
          model: () => resolveConfigModel(defaultModel.current(), catalog.modelsView()),
          // profile.model 槽位解析目录（AD-3 第一级声明时启用；生产未声明）
          models: catalog.modelsView(),
          // M6 T2 模型槽位（三级链第一级 UI 化）：resource_state kind 槽位现值
          // （launch 时刻读取定格；未设 → 后续档）
          uiModelSlot: () => {
            const slot = resourceService.modelSlot("subagent-worker");
            return slot === undefined ? undefined : resolveConfigModel(slot, catalog.modelsView());
          },
          // M6 T2 spawn 快照：组装产物缓存（启动/toggle 后重算，launch 读现值定格）
          spawnSnapshot: () => subagentAssembly,
          // 注入源切换（T2.3）：auth.json 现值快照（换 key 后新子进程跟随）
          apiKeys: () => authStore.apiKeysSnapshot(),
          toolCwd,
        })
      : undefined;
  const subagentRunner: InstanceRunner = options.subagentRunner ?? subagentLauncher ?? {
    launch: (instance) =>
      logger.warn(
        `SubAgent 实例 ${instance.instanceId} 的子进程 runner 未装配（测试 Fake 引擎形态），任务未执行`,
      ),
    setCallbacks: () => undefined,
  };

  // ── driven：CDP 浏览器连接（T2 地基；无独立 proxy/HTTP 层，连接内嵌 daemon）──
  // lazy 连接——装配不触网；homeDir 经 paths.ts 单点取（AG-07：adapter 不直接展开主目录）。
  const browserPort: BrowserPort = options.browser ?? new CdpConnectionManager({ homeDir: osHomeDir() });

  // ── service：SubAgent 调度编排（T2.2 多会话共用：构造期绑死 sessionId 废弃；
  //    实例归属经 spawn 入参/AgentInstanceData.sessionId；全局预算不分裂） ──
  const restoreService = new RestoreService({ repository, clock });
  const scheduler = new SchedulerService({
    policy: new SchedulingPolicy({
      maxConcurrent: config.maxConcurrent,
      maxQueued: config.maxQueued,
    }),
    runner: subagentRunner,
    events: fanout,
    repository,
    clock,
    // O-5：<home>/reports/<session>/<agentId>.md——按实例归属会话解析
    reportsDirFor: (sessionId) => path.join(paths.home, "reports", sessionId),
    // T2.1 契约 v0.3 §1 规则②：spawn 时刻锚（聚合视图读面；内存携带不落盘）
    spawnAnchorFor: (sessionId) => computeSpawnAnchor(sessionId),
    // T2.1（F5.7/AD-5，契约 v0.4 §2）：Sub instantiated 快照供给——profile
    // 常量全文 + model 三级链解析 id 形态（profile 槽位 ?? spawn 会话快照 ??
    // 全局兜底；与该实例 launch 实际用模同源同时点——launch 侧 resolveModelFor
    // 同序同值，仅 id → Model 对象的解析在 launcher，AD-3 联动）。
    subagentSnapshotFor: (spawnModel): ProfileSnapshotData => ({
      // M6 T3：快照供给改读组装缓存（消观测漂移——与 launch 实际注入同源
      // 同时点）；model 链与 launcher resolveModelFor 同序：profile 槽位 ??
      // kind 槽位（uiModelSlot）?? spawn 快照 ?? 全局兑底
      systemPrompt: subagentAssembly.systemPrompt,
      tools: [...subagentAssembly.tools],
      model:
        SubAgentProfile.model ??
        resourceService.modelSlot("subagent-worker") ??
        spawnModel ??
        defaultModel.current(),
      hooks: SubAgentProfile.hooks.map((h) => h.name),
    }),
    // T2 CDP 地基：agent 终态 → 回收其全部 managed tabs（idle sweep 兼底）
    onInstanceTerminal: (agentId) => void browserPort.reclaimOwner(agentId),
    // closure 注入主线（AD-8 双通道；T2.2 会话反向查找：实例归属会话 → 注册表
    // 寻址目标 ChatService）。热会话同步直达（收口链时序不变）；冷会话（理论
    // 不可达——活跃实例的会话不会卸载）异步恢复后补投。注册表在下方装配
    //（收口只发生在 spawn 之后，装配窗口内不会被调）。
    injectClosure: (agentId, message) => {
      const sessionId = scheduler.instance(agentId)?.sessionId;
      if (sessionId === undefined) return;
      const hot = registry.peek(sessionId);
      if (hot !== undefined) {
        hot.chatService.injectClosure(message);
        return;
      }
      void registry
        .get(sessionId)
        .then((runtime) => runtime.chatService.injectClosure(message))
        .catch(() => undefined); // 会话已删等竞态：静默丢弃
    },
  });

  // AD-3（F1.3）三级链第二级晚绑：launcher 先于 scheduler 构造（scheduler 依赖
  // runner），scheduler 就绪后一行绑定 spawn 会话快照读取通道（手工装配先例
  // :167/:498-504；解析逻辑收束 launcher 单点，不进 domain）。快照 id → 完整
  // Model 经 resolveConfigModel 解析（F-14 解析单点同源）。
  subagentLauncher?.bindSpawnModelSource((id) => {
    const snapshot = scheduler.spawnModelOf(id);
    return snapshot === undefined ? undefined : resolveConfigModel(snapshot, catalog.modelsView());
  });

  // ── driving：WS 事件流（EventPublisherPort 实现，fan-out 目标之一——
  //    WS 推送显式消费者：统一信封章印 + 按 sessionId 路由，T2.1 AD-3） ──
  const eventStream = new EventStream({
    // T2.1 契约 v0.3 §1：agent.spawned 帧锚点 enrichment（调度器内存携带面值）
    spawnAnchorFor: (instanceId) => scheduler.spawnAnchorOf(instanceId),
  });

  // ── T4 web 族（契约 v0.7）：CDP 连接状态变更 → web.status.changed 全连接
  //    广播（SYSTEM_SESSION_ID；DTO 组装与 web.status 查询回执同源 =
  //    handlers/web.ts webStatusPayloadOf——getStatus + listTabs）。退订归
  //    shutdown（先退订再 stop——stop 自身触发的 idle 变更不再广播）。──
  const unsubscribeBrowserStatus = browserPort.onStatusChange(() =>
    eventStream.broadcastWebStatusChanged(webStatusPayloadOf(browserPort)),
  );

  // ── service：多会话容器（T2.2 AD-4 主承载） ─────────────────────
  // 会话绑定引擎工厂：测试注入实例 = 全部会话共享（单会话测试形态）；
  // 工厂 = 每会话独立；生产路径 = 真引擎 + 会话绑定工具执行器（编排三工具
  // 回口携带会话归属——agent_spawn 经此路由到目标会话的调度入参）。
  // T2.3（AD-2）+ M6 T2：新会话模型 = 构建期解析 kind 槽位 ?? 当前默认
  //（set_default/槽位 set 后新建会话跟随新值；既有会话不跟随——per-session
  // 覆盖链不变）；apiKey 经 getter 读 auth.json 现值（换 key 下一请求生效）；
  // resolveModelById = 目录活解析面（运行期换模 overlay 模型可达）。
  // currentModelOf：spawn 时透传当前模型（AgentInstanceDto.model 填充链）
  // ——注册表装配后回填（引擎闭包调用发生在运行时，回填前安全缺省）。
  let currentModelOf: (sessionId: string) => string | undefined = () => undefined;
  // computeSpawnAnchor：spawn 时刻锚计算（T2.1 契约 v0.3 §1 规则②）——读目标
  // 会话聚合 entries（数组序最后一条 main/compaction entry；无 → null 流首）。
  // 与 currentModelOf 同式回填（注册表装配后；回填前安全缺省 null 流首）。
  let computeSpawnAnchor: (sessionId: string) => string | null = () => null;
  const engineFor =
    typeof options.engine === "function"
      ? options.engine
      : options.engine !== undefined
        ? () => options.engine as AgentEnginePort
        : (sessionId: string): AgentEnginePort => {
            const sessionOrchestration: AgentOrchestrationPort = {
              spawn: (task, profileKind) =>
                scheduler.spawn(sessionId, task, profileKind, currentModelOf(sessionId)),
              send: (agentId, message) => scheduler.send(agentId, message),
              status: (agentId) => scheduler.status(agentId),
              kill: (agentId) => scheduler.kill(agentId),
            };
            const toolExecutor = new CoreToolExecutor({
              cwd: toolCwd,
              orchestration: sessionOrchestration,
              // T3r 动态族：单 browser 工具注册（ownerId 缺省 "main"——主会话
              // tab 归属）；ChildMain 子进程装配不传 browser（P0-1 决策）
              browser: browserPort,
            });
            // M6 T2：新会话装配读组装快照现值（瘦身后 base + 生效工具清单 +
            // 生效技能段；toggle 后新会话/重建会话跟随）；model 四级链读面——
            // kind 槽位 > default_model（per-session 覆盖 = 既有 setModel 直改链）。
            // 活跃 runtime 不随槽位变更强推模型（下一装配生效——实现取舍见任务 report）。
            return new PiAgentEngineAdapter({
              profile: {
                ...MainSessionProfile,
                systemPrompt: mainAssembly.systemPrompt,
                tools: mainAssembly.tools,
              },
              model: resolveConfigModel(
                resourceService.modelSlot("main-session") ?? defaultModel.current(),
                catalog.modelsView(),
              ),
              apiKeys: () => authStore.apiKeysSnapshot(),
              models: catalog.modelsView(),
              resolveModelById: (modelId) => resolveConfigModel(modelId, catalog.modelsView()),
              resolveTools: (names) => toolExecutor.resolveTools(names),
            });
          };

  const registry = new SessionRegistry({
    repository,
    clock,
    scheduler,
    restore: (sessionId) => restoreService.restore(sessionId),
    // 会话运行时工厂（组合根唯一 new 面）：Session + ChatService 族 + 投影绑定
    buildRuntime: (material): SessionRuntime => {
      const engine = engineFor(material.session.id);
      const chatService = new ChatService({
        engine,
        events: fanout,
        clock,
        session: material.session,
        restoredToolCalls: material.toolCalls,
        // T2.3（契约 v0.3 §3.2）：定向 steer 转投面——AgentOrchestrationPort.send
        // 同链路（目标状态前置判定归调度侧既有 send 链，编排泄零入 driving）
        sendToInstance: (agentId, message) => scheduler.send(agentId, message),
        // T2.1（F5.9/AD-6）：model.changed 的 from 兜底（引擎未暴露观测值时
        // 回退全局默认，与 ModelService previous 口径一致）
        modelFallback: () => defaultModel.current(),
        // T2.1（F5.7/AD-5）：主实例 instantiated 快照供给——M6 T3 改读组装
        // 缓存（与 engineFor 实际装配同源，消观测漂移；模型仍取创建时引擎
        // 观测值 ?? 全局默认）；T4 起发布触发在注册表 promoteDraft（转正：
        // 首个用户条目；恢复路径不重发）。
        instantiatedSnapshot: (): ProfileSnapshotData => ({
          systemPrompt: mainAssembly.systemPrompt,
          tools: [...mainAssembly.tools],
          model: engine.currentModel?.() ?? defaultModel.current(),
          ...(MainSessionProfile.compaction !== undefined
            ? { compaction: MainSessionProfile.compaction }
            : {}),
          hooks: MainSessionProfile.hooks.map((h) => h.name),
        }),
        // T4 转正单点触发面：零条目草稿首个用户条目落聚合 → 注册表
        // promoteDraft（恰好一次 instantiated + 补 created；闭包引用 registry
        // 在注册表装配后才被调用——createFresh 发生在 initialize/运行期，TDZ 安全）
        onFirstUserEntry: () => registry.promoteDraft(material.session.id),
      });
      // 会话投影消费者（T2.1 AD-3 §3.2②；T2.2 多会话 = 按 sessionId 分实例化，
      // architecture-feedback #20 建议采纳）：SubAgent Entry 落聚合 + 账本入账
      // + write-through（fan-out 投影路由按事件 sessionId 分发到本投影）。
      const projection = new SessionProjection({
        repository,
        getSession: () => chatService.sessionView,
        getMainState: () => ({ agentState: chatService.agentState, toolCalls: chatService.toolCallData }),
        initialUsage: material.usage,
      });
      return { sessionId: material.session.id, chatService, projection };
    },
    onListChanged: (change) => eventStream.broadcastListChanged(change),
    idleUnloadMs: options.sessionIdleUnloadMs,
    idlePollMs: options.sessionIdlePollMs,
    logger,
  });

  // ── services：会话状态入口（当前会话读面，经注册表组装） ──────────
  const sessionService = new SessionService({
    getView: () => registry.currentView(),
    getAgentState: () => registry.currentRuntime().chatService.agentState,
  });

  // ── 会话路由对话入口（T2.2）：CLI / WS 共用——sessionId 缺省 = 当前会话 ──
  const chatRouter: SessionChatPort = {
    sendMessage: async (text: string, sessionId?: string): Promise<SendOutcome> => {
      const target = sessionId ?? registry.currentSessionId();
      const runtime = registry.peek(target) ?? (await registry.get(target));
      return runtime.chatService.sendMessage(text);
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

  // fan-out 目标装配（序：CLI stdout → CLI 事件回灌（当前会话过滤）→ WS 事件流
  // → 写队列持久化（事件行，行级 session_id 分仓路由）→ 会话投影路由（先事件行
  // 后状态行，同会话仓内 FIFO 保序）→ 清单运行态桥（活动标记 + state_changed）。
  // SubAgent 实例事件（instanceId ≠ main）落行 agent_kind=subagent（四维可查口径）。
  publisherTargets.push(
    stdoutPublisher,
    {
      // CLI 单会话 UX：只回灌当前会话事件（多会话事件经 WS 按订阅分发）
      publish: (event) => {
        if (event.sessionId === registry.currentSessionId()) sessionService.notify(event);
      },
      publishDelta: (delta) => {
        if ((delta.sessionId ?? registry.currentSessionId()) === registry.currentSessionId()) {
          sessionService.notify(delta);
        }
      },
    },
    eventStream,
    {
      // 事件行持久化：行级四维落位（session_id 列 = 事件携带 sessionId——
      // WriteQueue 分仓路由位；agent_kind 按实例维判 main/subagent）
      publish: (event) => {
        void writeQueue.appendEvent(
          event,
          event.instanceId !== undefined && event.instanceId !== MAIN_INSTANCE_ID
            ? "subagent"
            : MAIN_AGENT_KIND,
        );
      },
      publishDelta: () => undefined,
    },
    // 会话投影路由（T2.1 AD-3 + T2.2 多会话）：事件 → 归属会话运行时的投影
    // 消费者（SubAgent Entry 落聚合 + 账本入账 + write-through；卸载会话无
    // 投影——零动作）
    {
      publish: (event) => registry.projectEvent(event),
      publishDelta: () => undefined,
    },
    // 清单运行态桥（T2.2）：活动标记（卸载计时/当前会话轮换）+ runState 变化
    // 推 session.list_changed{state_changed}（注册表内去重）
    {
      publish: (event) => registry.onDomainEvent(event),
      publishDelta: (delta) => registry.touchActivity(delta.sessionId),
    },
  );

  // ── 启动恢复（T2.2 全量元数据 + 懒加载）：全部会话元数据可见（session.list
  //    读面），当前会话（最近活动）显式热加载（同步读面/CLI 兼容）；restoreLatest
  //    ids.at(-1) 单会话末位语义废弃。首启无持久化 → 新建空会话。 ──
  // T4：initialize 仍在 fan-out 目标装配**之后**（惯例保持——T4 起 createFresh
  // 不再发布 instantiated，但转正 promoteDraft / created 补广播等运行期事件
  // 同样依赖目标已装配；中间构造块 sessionService/chatRouter/cli 均为惰性闭包）。
  await registry.initialize();

  // T2.3：currentModelOf 回填（spawn 透传链——注册表装配完成，热会话可观测）
  currentModelOf = (sessionId: string) => registry.peek(sessionId)?.chatService.currentModel;
  // T2.1：spawn 锚计算回填（规则②读面——目标会话聚合 entries 数组序扫描；
  // 冷会话理论不可达（spawn 必经热会话门面），防御 null 流首）
  computeSpawnAnchor = (sessionId: string) => {
    const runtime = registry.peek(sessionId);
    if (runtime === undefined) return null;
    return lastMainAnchorId(runtime.chatService.sessionView.toSnapshot().entries);
  };

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
        model: registry.peek(sessionId)?.chatService.currentModel ?? defaultModel.current(),
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
      await writeQueue.close(); // 优雅退出：drain 全部仓位后关连接（lifecycle 挂点）
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
        currentModelOf(registry.currentSessionId()),
      ),
    send: (agentId, message) => scheduler.send(agentId, message),
    status: (agentId) => scheduler.status(agentId),
    kill: (agentId) => scheduler.kill(agentId),
  };
  // 模型/认证管理门面（T2.3 AD-2）：WS model.*/auth.* 命令族回口；
  // model.changed 经 EventStream 广播（channel=model，订阅路由）
  const modelService = new ModelService({
    registry,
    catalog,
    auth: authStore,
    defaultModel,
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
    hasModel: (id) => catalog.hasModel(id), // M6 T3：model 型 set 前置校验
    traceQuery, // T2.1（CL-5/F5.6）：trace.query 命令回口（只读面）
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

  logger.info(`daemon 启动：home=${paths.home} 默认模型=${defaultModel.current()}（模型位已迁 SQLite 默认表 + auth.json，config.json 瘦身）`);

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
    runCli: () => cli.run(),
    shutdown: system.shutdown,
  };
}
