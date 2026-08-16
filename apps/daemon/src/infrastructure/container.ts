import type { ChatPort } from "../application/ports/inbound/ChatPort";
import type { SessionPort } from "../application/ports/inbound/SessionPort";
import type { SystemPort, DaemonStatus } from "../application/ports/inbound/SystemPort";
import type { AgentOrchestrationPort } from "../application/ports/inbound/AgentOrchestrationPort";
import type { AgentEnginePort } from "../application/ports/outbound/AgentEnginePort";
import type { SessionRepositoryPort } from "../application/ports/outbound/SessionRepositoryPort";
import type { EventPublisherPort } from "../application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../application/ports/outbound/ClockPort";
import { ChatService } from "../application/services/ChatService";
import { SessionService } from "../application/services/SessionService";
import { RestoreService } from "../application/services/RestoreService";
import { SchedulerService } from "../application/services/SchedulerService";
import type { InstanceRunner } from "../application/services/InstanceRunner";
import { SchedulingPolicy, DEFAULT_SCHEDULING } from "../domain/agent/SchedulingPolicy";
import { MAIN_INSTANCE_ID } from "../domain/agent/AgentInstance";
import type { InstanceSnapshotEntry } from "../application/ports/inbound/SessionPort";
import type { SessionUsageSummary } from "../domain/session/SessionSnapshot";
import { Session } from "../domain/session/Session";
import path from "node:path";
import { CliAdapter, StdoutEventPublisher } from "../adapters/driving/cli/CliAdapter";
import { WsServerAdapter } from "../adapters/driving/ws-server/WsServerAdapter";
import { EventStream } from "../adapters/driving/ws-server/EventStream";
import { StaticServe } from "../adapters/driven/static-serve/StaticServe";
import { PiAgentEngineAdapter } from "../adapters/driven/pi-engine/PiAgentEngineAdapter";
import { MainSessionProfile } from "../adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SubAgentProfile } from "../adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { resolveConfigModel } from "../adapters/driven/pi-engine/model-provider";
import { SubagentLauncher } from "../adapters/driven/subagent/SubagentLauncher";
import { CoreToolExecutor } from "../adapters/driven/tools/CoreToolExecutor";
import { WriteQueue, MAIN_AGENT_KIND } from "../adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../adapters/driven/sqlite-session/SqliteSessionRepository";
import { createPaths, type HelixPaths } from "./paths";
import { ensureConfigTemplate, loadConfig, type DaemonConfig } from "./config";
import { ensureDevToken } from "./dev-token";
import { createFileLogger, type Logger } from "./logging";
import { acquireSingletonLock, type SingletonLock } from "./lifecycle";

/**
 * 组合根（architecture.md §3.6）：整个 daemon 唯一允许 new 具体实现的地方。
 * 依赖图在这里闭合：driven adapter → service → driving adapter 接线，
 * 四层内部只见接口。
 *
 * 事件接线：fan-out publisher 先建（ChatService/SchedulerService 依赖它构造），
 * 目标（CLI stdout publisher、SessionService 订阅回灌、WS 事件流、WriteQueue
 * 持久化目标）装配后追加——无需构造后回写依赖。
 *
 * 构造序（T2.3 重排）：持久化 → 恢复/会话聚合 → fan-out → SubAgent runner
 * → SchedulerService → 工具执行器（编排三工具经 AgentOrchestrationPort 持
 * 调度器引用）→ 引擎 → ChatService。调度器先于工具执行器是闭环要求：
 * agent_spawn 等工具回口编排，而调度器需要会话 id（聚合已先建）。
 * injectClosure 闭包解引用 ChatService（收口只发生在 spawn 之后，装配窗口
 * 内不会被调）。
 *
 * 持久化（T1.8）：SQLite WAL `<home>/helix.db`；WriteQueue 是 daemon 内唯一
 * SQLite 写通道（AG-06）；启动时 RestoreService 读盘重建聚合（首启无持久化
 * 则新建）；shutdown 先 drain 写队列再释放锁（优雅退出）。
 *
 * 测试注入口（不进生产路径）：engine（FakeAgentEngine）、subagentRunner
 * （T2.3：integration 驱动收口时序）、CLI 输入输出流（PassThrough）、
 * skipLock/skipConfig（单测并行与 Fake 演示）。
 */
export interface DaemonOptions {
  /** 显式 home（main.ts 已解析 --home；测试指向 tmp 目录）。 */
  readonly home?: string;
  /** 引擎覆盖（测试注入 FakeAgentEngine；缺省装配真 pi 引擎）。 */
  readonly engine?: AgentEnginePort;
  /** CLI 输入/输出流覆盖（测试注入 PassThrough）。 */
  readonly cliInput?: NodeJS.ReadableStream;
  readonly cliOutput?: NodeJS.WritableStream;
  /** WS 监听端口覆盖（0 = 随机；测试用；缺省取 config.port）。 */
  readonly port?: number;
  /** 前端静态产物目录覆盖（测试注入 fixture；缺省取 config.staticDir）。 */
  readonly staticDir?: string;
  /** 跳过单例锁（单测并行用；生产不得关闭）。 */
  readonly skipLock?: boolean;
  /** 跳过 config 加载（FakeAgentEngine 演示不需要真实模型配置）。 */
  readonly skipConfig?: boolean;
  /** 工具沙箱 cwd 覆盖（测试指向 tmp；缺省为进程工作区）。 */
  readonly toolCwd?: string;
  /**
   * SubAgent runner 覆盖（T2.3 测试注入口：integration 注入 fake runner 驱动
   * 收口时序；缺省装配 SubagentLauncher 真体 / skipConfig 占位替身）。
   */
  readonly subagentRunner?: InstanceRunner;
}

export interface Daemon {
  readonly paths: HelixPaths;
  readonly config: DaemonConfig;
  readonly chat: ChatPort;
  readonly session: SessionPort;
  readonly system: SystemPort;
  readonly logger: Logger;
  /** WS 服务（127.0.0.1；实际监听端口/地址可观测，TP-CL6-1）。 */
  readonly ws: WsServerAdapter;
  /** SubAgent 子进程运行器（T2.2；skipConfig 无 model 配置时不装配）。 */
  readonly subagentLauncher: SubagentLauncher | undefined;
  /** 编排入口（T2.3：spawn/send/status/kill；三工具与 WS 命令的公共回口）。 */
  readonly orchestration: AgentOrchestrationPort;
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

  // 配置：首次创建模板（0600，AG-09）+ 加载（fail-fast）
  ensureConfigTemplate(paths.configPath());
  const config = options.skipConfig
    ? { port: 7333, maxConcurrent: DEFAULT_SCHEDULING.maxConcurrent, maxQueued: DEFAULT_SCHEDULING.maxQueued }
    : loadConfig(paths.configPath());

  // ── 持久化（T1.8）：SQLite WAL + 单写队列（AG-06 唯一写通道） ────
  const writeQueue = new WriteQueue(paths.dbPath(), {
    onError: (error, job) => logger.error(`落盘失败（${job.kind}）：${(error as Error).message}`),
  });
  const repository: SessionRepositoryPort = new SqliteSessionRepository(writeQueue);

  // ── 重启恢复（F(8).2）：读盘重建聚合；首启无持久化 → 新建会话 ──────
  // 会话聚合在此显式创建/恢复（T2.3 构造序：调度器需要 sessionId，先于引擎装配）
  const clock: ClockPort = { now: () => new Date().toISOString() };
  const restored = await new RestoreService({ repository, clock }).restoreLatest();
  const session = restored?.session ?? Session.create();
  if (restored) {
    logger.info(
      `已恢复会话 ${restored.session.id}（entries=${restored.session.entryList().length}，` +
        `工具记录=${restored.toolCalls.length}，实例=${restored.instances.length}（其中重启收口见 agent_lifecycle），` +
        `停机前 agentState=${restored.agentState}）`,
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
  // 生产路径（config.model 必填）装配子进程真体（F-14 同一解析单点经 env
  // 透传子进程）；skipConfig（测试 Fake 模式）无 model 配置 → 退回占位替身
  // （launch 告警不执行，与 T2.1 行为一致）；options.subagentRunner 为测试
  // 注入口（T2.3：integration 驱动收口时序，优先于真体/替身）。
  const subagentLauncher =
    config.model !== undefined
      ? new SubagentLauncher({
          profile: SubAgentProfile,
          model: resolveConfigModel(config.model), // 同一解析单点（F-14）
          apiKeys: config.apiKeys ?? {},
          toolCwd: options.toolCwd ?? process.cwd(),
        })
      : undefined;
  const subagentRunner: InstanceRunner = options.subagentRunner ?? subagentLauncher ?? {
    launch: (instance) =>
      logger.warn(
        `SubAgent 实例 ${instance.instanceId} 的子进程 runner 未装配（skipConfig 无 model 配置），任务未执行`,
      ),
    setCallbacks: () => undefined,
  };

  // ── service：SubAgent 调度编排（T2.1/T2.3；先于工具执行器——编排三工具经
  // AgentOrchestrationPort 持本实例引用，TR-AD-9 编排收敛） ─────────────
  const scheduler = new SchedulerService({
    policy: new SchedulingPolicy({
      maxConcurrent: config.maxConcurrent,
      maxQueued: config.maxQueued,
    }),
    runner: subagentRunner,
    events: fanout,
    repository,
    clock,
    sessionId: session.id,
    reportsDir: path.join(paths.home, "reports", session.id), // O-5：<home>/reports/<session>/<agentId>.md
    // closure 注入主线（AD-8 双通道）：闭包解引用 ChatService——收口只发生
    // 在 spawn 之后（装配窗口内不会被调）
    injectClosure: (agentId, message) => chatService.injectClosure(message),
  });
  // T2.4 重启恢复：实例注册表/闭包/任务/序号基线注入调度器（终态与快照态
  // 原样登记；running/queued 已由 RestoreService 收口落盘——此处零 spawn/零事件）
  scheduler.restoreInstances(restored?.instances ?? []);

  // ── driven：工具执行器（八工具注册表：四内置 + grep + 编排三工具） ──
  const toolExecutor = new CoreToolExecutor({
    cwd: options.toolCwd ?? process.cwd(),
    orchestration: scheduler, // T2.3：agent_spawn/agent_send/agent_status 经 port 回调度
  });

  // ── driven：agent 引擎（pi 防腐墙后；测试可注入 Fake） ──────────
  // F-14 单点：config.model 字符串在此解析为完整 Model 对象，此后全链路
  // （主引擎/SubAgent 子进程）只透传对象，不散落读字符串。
  const engine: AgentEnginePort =
    options.engine ??
    new PiAgentEngineAdapter({
      profile: MainSessionProfile,
      model: resolveConfigModel(config.model), // 缺 model 配置 → fail-fast（中文指引）
      apiKeys: config.apiKeys ?? {},
      resolveTools: (names) => toolExecutor.resolveTools(names),
    });

  // ── services：对话编排 + 会话状态（共享同一聚合访问器） ──────────
  const chatService = new ChatService({
    engine,
    repository,
    events: fanout,
    clock,
    session,
    restoredToolCalls: restored?.toolCalls,
  });
  const sessionService = new SessionService({
    getSession: () => chatService.sessionView,
    getAgentState: () => chatService.agentState,
    getToolCalls: () => chatService.toolCallData, // D-1：快照取数面扩展（工具记录随快照恢复）
    // T2.4 快照组装面：主实例条目（常驻，窗口永不终态）+ 调度器注册表观测
    getInstances: () => [
      {
        instanceId: MAIN_INSTANCE_ID,
        kind: "main",
        profileKind: "main-session",
        sessionId: session.id,
        state: "running",
        createdAt: session.createdAt,
      },
      ...scheduler.snapshotInstances(),
    ] satisfies InstanceSnapshotEntry[],
    // T2.4 占位装配：T3.2 入账链路（usage ledger）落地后由真值替换
    getUsage: () => ZERO_USAGE_SUMMARY,
  });

  // ── driving：CLI（stdout 事件发布器由组合根构造并注入两侧） ─────
  const stdoutPublisher = new StdoutEventPublisher(options.cliOutput ?? process.stdout);
  const cli = new CliAdapter({
    chat: chatService,
    session: sessionService,
    events: stdoutPublisher,
    input: options.cliInput,
    output: options.cliOutput,
  });

  // ── driving：WS 事件流（EventPublisherPort 实现，fan-out 目标之一）──
  const eventStream = new EventStream();

  // fan-out 目标装配：CLI stdout + SessionService 订阅者回灌 + WS 事件流
  // + 写队列持久化目标（领域事件行入同一 FIFO 队列；流式 delta 不落盘，
  // publishDelta 无入队动作——AD-16 §5.3）。SubAgent 实例事件
  // （instanceId ≠ main）落行 agent_kind=subagent（四维可查口径）。
  publisherTargets.push(
    stdoutPublisher,
    {
      publish: (event) => sessionService.notify(event),
      publishDelta: (delta) => sessionService.notify(delta),
    },
    eventStream,
    {
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
  );

  let running = true;
  let wsServer: WsServerAdapter | undefined;
  const system: SystemPort = {
    getStatus(): DaemonStatus {
      return {
        running,
        locked: lock !== undefined,
        home: paths.home,
        sessionId: chatService.sessionId,
        agentState: chatService.agentState,
        model: config.model,
      };
    },
    async shutdown(): Promise<void> {
      running = false;
      wsServer?.stop(); // 先停 WS（不再接受新连接/命令），再收尾业务
      scheduler.stop(); // T2.1：停 stalled 监视定时器（否则活跃 interval 阻止进程退出）
      await subagentLauncher?.dispose(); // T2.2：O-6 序列回收全部存活子进程（零孤儿）
      chatService.stop(); // stopped 里程碑 write-through 落盘
      await writeQueue.close(); // 优雅退出：drain 单写队列后关连接（lifecycle 挂点）
      lock?.release();
      logger.info("daemon 已关闭");
    },
  };

  // ── driving：WS 服务（CL-6：127.0.0.1 + hello 握手 + 命令路由 + 事件推送）──
  // dev token 每次启动重写（<home>/dev-token，0600）；静态产物缺失不影响启动
  const token = ensureDevToken(paths.devTokenPath());
  const staticServe = new StaticServe(options.staticDir ?? config.staticDir);
  const ws = new WsServerAdapter({
    chat: chatService,
    session: sessionService,
    system,
    orchestration: scheduler, // T2.3：agent.kill 命令链回调度
    events: eventStream,
    token,
    port: options.port ?? config.port,
    staticHandler: (req) => staticServe.handle(req),
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

  logger.info(`daemon 启动：home=${paths.home} model=${config.model ?? "(未配置)"}`);

  return {
    paths,
    config,
    chat: chatService,
    session: sessionService,
    system,
    logger,
    ws,
    subagentLauncher,
    orchestration: scheduler,
    runCli: () => cli.run(),
    shutdown: system.shutdown,
  };
}

/** T2.4 占位空账面（七字段全 0；T3.2 usage ledger 落地后移除）。 */
const ZERO_USAGE_SUMMARY: SessionUsageSummary = {
  total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 },
  compaction: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 },
};
