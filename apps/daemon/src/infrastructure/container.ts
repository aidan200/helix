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
import { SchedulerService } from "../application/services/SchedulerService";
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
  /** 跳过 config 加载（FakeAgentEngine 演示不需要真实模型配置）。 */
  readonly skipConfig?: boolean;
  /** 工具沙箱 cwd 覆盖（测试指向 tmp；缺省为进程工作区）。 */
  readonly toolCwd?: string;
  /**
   * SubAgent runner 覆盖（T2.3 测试注入口：integration 注入 fake runner 驱动
   * 收口时序；缺省装配 SubagentLauncher 真体 / skipConfig 占位替身）。
   */
  readonly subagentRunner?: InstanceRunner;
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
  /** 会话目录入口（T2.2 AD-4：list/loadHistory/delete/草稿/懒加载取数面）。 */
  readonly directory: SessionDirectoryPort;
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

  // 配置：首次创建模板（0600，AG-09）+ 加载（fail-fast）
  ensureConfigTemplate(paths.configPath());
  const config = options.skipConfig
    ? { port: 7333, maxConcurrent: DEFAULT_SCHEDULING.maxConcurrent, maxQueued: DEFAULT_SCHEDULING.maxQueued }
    : loadConfig(paths.configPath());

  // ── 持久化（T1.8）：SQLite WAL + 单写队列（AG-06 唯一写通道；T2.2 分仓） ──
  const writeQueue = new WriteQueue(paths.dbPath(), {
    onError: (error, job) => logger.error(`落盘失败（${job.kind}）：${(error as Error).message}`),
  });
  const repository: SessionRepositoryPort = new SqliteSessionRepository(writeQueue);
  const clock: ClockPort = { now: () => new Date().toISOString(), nowMs: () => Date.now() };

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
  // （launch 告警不执行）；options.subagentRunner 为测试注入口。
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

  // ── driving：WS 事件流（EventPublisherPort 实现，fan-out 目标之一——
  //    WS 推送显式消费者：统一信封章印 + 按 sessionId 路由，T2.1 AD-3） ──
  const eventStream = new EventStream();

  // ── service：多会话容器（T2.2 AD-4 主承载） ─────────────────────
  // 会话绑定引擎工厂：测试注入实例 = 全部会话共享（单会话测试形态）；
  // 工厂 = 每会话独立；生产路径 = 真引擎 + 会话绑定工具执行器（编排三工具
  // 回口携带会话归属——agent_spawn 经此路由到目标会话的调度入参）。
  const engineFor =
    typeof options.engine === "function"
      ? options.engine
      : options.engine !== undefined
        ? () => options.engine as AgentEnginePort
        : (sessionId: string): AgentEnginePort => {
            const sessionOrchestration: AgentOrchestrationPort = {
              spawn: (task, profileKind) => scheduler.spawn(sessionId, task, profileKind),
              send: (agentId, message) => scheduler.send(agentId, message),
              status: (agentId) => scheduler.status(agentId),
              kill: (agentId) => scheduler.kill(agentId),
            };
            const toolExecutor = new CoreToolExecutor({
              cwd: options.toolCwd ?? process.cwd(),
              orchestration: sessionOrchestration,
            });
            // F-14 单点：config.model 在此解析为完整 Model 对象（缺配置 fail-fast）
            return new PiAgentEngineAdapter({
              profile: MainSessionProfile,
              model: resolveConfigModel(config.model),
              apiKeys: config.apiKeys ?? {},
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

  // ── 启动恢复（T2.2 全量元数据 + 懒加载）：全部会话元数据可见（session.list
  //    读面），当前会话（最近活动）显式热加载（同步读面/CLI 兼容）；restoreLatest
  //    ids.at(-1) 单会话末位语义废弃。首启无持久化 → 新建空会话。 ──
  await registry.initialize();

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
    steer: async (text: string, sessionId?: string): Promise<{ entryId: string }> => {
      const target = sessionId ?? registry.currentSessionId();
      const runtime = registry.peek(target) ?? (await registry.get(target));
      return runtime.chatService.steer(text);
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

  let running = true;
  let wsServer: WsServerAdapter | undefined;
  const system: SystemPort = {
    getStatus(): DaemonStatus {
      const sessionId = registry.currentSessionId();
      return {
        running,
        locked: lock !== undefined,
        home: paths.home,
        sessionId,
        // 冷当前会话（被空闲卸载）无执行载体 → idle
        agentState: registry.peek(sessionId)?.chatService.agentState ?? "idle",
        model: config.model,
      };
    },
    async shutdown(): Promise<void> {
      running = false;
      wsServer?.stop(); // 先停 WS（不再接受新连接/命令），再收尾业务
      registry.stop(); // T2.2：停空闲卸载监视定时器
      scheduler.stop(); // T2.1：停 stalled 监视定时器
      registry.sealAll(); // T2.2：全部热会话封口（stopped 里程碑 write-through 落盘）
      await subagentLauncher?.dispose(); // T2.2：O-6 序列回收全部存活子进程（零孤儿）
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
  // spawn 携带当前会话归属（既有测试口径不变）；kill/send/status 按 agentId 全局寻址
  const currentOrchestration: AgentOrchestrationPort = {
    spawn: (task, profileKind) => scheduler.spawn(registry.currentSessionId(), task, profileKind),
    send: (agentId, message) => scheduler.send(agentId, message),
    status: (agentId) => scheduler.status(agentId),
    kill: (agentId) => scheduler.kill(agentId),
  };
  const ws = new WsServerAdapter({
    chat: chatRouter,
    directory: registry,
    system,
    orchestration: currentOrchestration, // T2.3：agent.kill 命令链回调度
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

  logger.info(`daemon 启动：home=${paths.home} model=${config.model ?? "(未配置)"}`);

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
    directory: registry,
    registry,
    runCli: () => cli.run(),
    shutdown: system.shutdown,
  };
}
