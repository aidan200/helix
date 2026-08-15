import type { ChatPort } from "../application/ports/inbound/ChatPort";
import type { SessionPort } from "../application/ports/inbound/SessionPort";
import type { SystemPort, DaemonStatus } from "../application/ports/inbound/SystemPort";
import type { AgentEnginePort } from "../application/ports/outbound/AgentEnginePort";
import type { SessionRepositoryPort } from "../application/ports/outbound/SessionRepositoryPort";
import type { EventPublisherPort } from "../application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../application/ports/outbound/ClockPort";
import type { SessionSnapshot } from "../domain/session/SessionSnapshot";
import { ChatService } from "../application/services/ChatService";
import { SessionService } from "../application/services/SessionService";
import { CliAdapter, StdoutEventPublisher } from "../adapters/driving/cli/CliAdapter";
import { PiAgentEngineAdapter } from "../adapters/driven/pi-engine/PiAgentEngineAdapter";
import { MainSessionProfile } from "../adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { createPaths, type HelixPaths } from "./paths";
import { ensureConfigTemplate, loadConfig, type DaemonConfig } from "./config";
import { createFileLogger, type Logger } from "./logging";
import { acquireSingletonLock, type SingletonLock } from "./lifecycle";

/**
 * 组合根（architecture.md §3.6）：整个 daemon 唯一允许 new 具体实现的地方。
 * 依赖图在这里闭合：driven adapter → service → driving adapter 接线，
 * 四层内部只见接口。
 *
 * 事件接线：fan-out publisher 先建（ChatService 依赖它构造），目标
 * （CLI stdout publisher、SessionService 订阅回灌）装配后追加——
 * 无需构造后回写依赖。
 *
 * 测试注入口（不进生产路径）：engine（FakeAgentEngine）、CLI 输入输出流
 * （PassThrough）、skipLock/skipConfig（单测并行与 Fake 演示）。
 */
export interface DaemonOptions {
  /** 显式 home（main.ts 已解析 --home；测试指向 tmp 目录）。 */
  readonly home?: string;
  /** 引擎覆盖（测试注入 FakeAgentEngine；缺省装配真 pi 引擎）。 */
  readonly engine?: AgentEnginePort;
  /** CLI 输入/输出流覆盖（测试注入 PassThrough）。 */
  readonly cliInput?: NodeJS.ReadableStream;
  readonly cliOutput?: NodeJS.WritableStream;
  /** 跳过单例锁（单测并行用；生产不得关闭）。 */
  readonly skipLock?: boolean;
  /** 跳过 config 加载（FakeAgentEngine 演示不需要真实模型配置）。 */
  readonly skipConfig?: boolean;
}

export interface Daemon {
  readonly paths: HelixPaths;
  readonly config: DaemonConfig;
  readonly chat: ChatPort;
  readonly session: SessionPort;
  readonly system: SystemPort;
  readonly logger: Logger;
  /** CLI 主循环（阻塞至 /exit/EOF/二次 Ctrl-C）。 */
  runCli(): Promise<void>;
  /** 优雅关闭：停输入、释放锁。 */
  shutdown(): Promise<void>;
}

export function createDaemon(options: DaemonOptions = {}): Daemon {
  const paths = createPaths(options.home);
  const lock: SingletonLock | undefined = options.skipLock ? undefined : acquireSingletonLock(paths.lockPath());
  const logger = createFileLogger(paths.logsDir());

  // 配置：首次创建模板（0600，AG-09）+ 加载（fail-fast）
  ensureConfigTemplate(paths.configPath());
  const config = options.skipConfig ? { port: 7333 } : loadConfig(paths.configPath());

  // ── driven：agent 引擎（pi 防腐墙后；测试可注入 Fake） ──────────
  const engine: AgentEnginePort =
    options.engine ??
    new PiAgentEngineAdapter({
      profile: MainSessionProfile,
      modelStr: config.model ?? "",
      apiKeys: config.apiKeys ?? {},
    });

  // ── 持久化（T1.4 临时内存实现；T1.8 由 SQLite 单写队列接替） ────
  const repository = createInMemorySessionRepository();

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

  // ── services：编排 + 会话状态（共享同一聚合访问器） ─────────────
  const clock: ClockPort = { now: () => new Date().toISOString() };
  const chatService = new ChatService({ engine, repository, events: fanout, clock });
  const sessionService = new SessionService({
    getSession: () => chatService.sessionView,
    getAgentState: () => chatService.agentState,
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

  // fan-out 目标装配：CLI stdout + SessionService 订阅者回灌
  publisherTargets.push(
    stdoutPublisher,
    {
      publish: (event) => sessionService.notify(event),
      publishDelta: (delta) => sessionService.notify(delta),
    },
  );

  let running = true;
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
      chatService.stop();
      lock?.release();
      logger.info("daemon 已关闭");
    },
  };

  logger.info(`daemon 启动：home=${paths.home} model=${config.model ?? "(未配置)"}`);

  return {
    paths,
    config,
    chat: chatService,
    session: sessionService,
    system,
    logger,
    runCli: () => cli.run(),
    shutdown: system.shutdown,
  };
}

/** T1.4 临时内存持久化（真实现 T1.8：SQLite WAL + 单写队列）。 */
function createInMemorySessionRepository(): SessionRepositoryPort {
  const store = new Map<string, SessionSnapshot>();
  return {
    async save(snapshot) {
      store.set(snapshot.sessionId, structuredClone(snapshot));
    },
    async restore(sessionId) {
      const snap = store.get(sessionId);
      return snap ? structuredClone(snap) : undefined;
    },
    async listSessionIds() {
      return [...store.keys()];
    },
  };
}
