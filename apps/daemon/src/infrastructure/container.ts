import type { SessionChatPort, SendOutcome } from "../application/ports/inbound/ChatPort";
import type { SessionPort } from "../application/ports/inbound/SessionPort";
import type { SystemPort, DaemonStatus } from "../application/ports/inbound/SystemPort";
import type { AgentOrchestrationPort } from "../application/ports/inbound/AgentOrchestrationPort";
import type { SessionDirectoryPort } from "../application/ports/inbound/SessionDirectoryPort";
import type { ClockPort } from "../application/ports/outbound/ClockPort";
import type { BrowserPort } from "../application/ports/outbound/BrowserPort";
import type { ModelPort } from "../application/ports/inbound/ModelPort";
import type { InstanceRunner } from "../application/services/InstanceRunner";
import { ModelService } from "../application/services/ModelService";
import { SessionRegistry } from "../application/services/SessionRegistry";
import { ResourceService } from "../application/services/ResourceService";
import { CliAdapter, StdoutEventPublisher } from "../adapters/driving/cli/CliAdapter";
import { WsServerAdapter } from "../adapters/driving/ws-server/WsServerAdapter";
import { webStatusPayloadOf } from "../adapters/driving/ws-server/handlers/web";
import { lastMainAnchorId, type AnchorScanEntry } from "@helix/protocol"; // 锚扫描基元单源 projection
import { isMainInstanceId } from "../domain/agent/AgentInstance";
import { StaticServe } from "../adapters/driven/static-serve/StaticServe";
import { SubagentLauncher } from "../adapters/driven/subagent/SubagentLauncher";
import { CdpConnectionManager } from "../adapters/driven/cdp/CdpConnectionManager";
import { createPaths, osHomeDir, type HelixPaths } from "./paths";
import { ensureConfigTemplate, loadConfig, writeConfig, type DaemonConfig, type LegacyModelConfig } from "./config";
import { resolveRgPath } from "../adapters/driven/tools/grep/resolve-rg";
import { resolveCodegraphPath } from "../adapters/driven/codegraph-engine/resolve-codegraph";
import { buildKnowledgeStack, startKgSyncBackground, type KgSyncBackground, type KnowledgeStack } from "./assembly/buildKnowledgeStack";
import { freezeGrepBackend, probeRgVersion, RG_PROBE_TIMEOUT_MS } from "../adapters/driven/tools/grep/freeze-backend";
import { accessSync, constants as fsConstants } from "node:fs";
import { ensureDevToken } from "./dev-token";
import { createFileLogger, type Logger } from "./logging";
import { acquireSingletonLock, type SingletonLock } from "./lifecycle";
import { buildPersistence } from "./assembly/buildPersistence";
import { buildModelStack } from "./assembly/buildModelStack";
import { buildSessionStack, type AssemblyBackfill, type EngineAssemblyMode } from "./assembly/buildSessionStack";
import { FanoutPublisher, wireEventFanout, type NamedFanoutTarget } from "./assembly/wireEventFanout";
import { createResourceEventBus, type ResourceEventBus } from "./assembly/resource-events";

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
  /**
   * 浏览器连接入口（CDP 地基，BrowserPort）：lazy 连接， browser 工具
   * 与状态协议的消费面；生命周期 = daemon 生命周期（shutdown 挂 stop()）。
   */
  readonly browser: BrowserPort;
  /** 多会话容器（生命周期编排观测面——测试断言懒加载/卸载用）。 */
  readonly registry: SessionRegistry;
  /**
   * kg 子系统栈（T2.1：.kg 双 port + codegraph 引擎被动封装；
   * KgSyncService 挂入归 T2.2）。shutdown 时 dispose 全部 per-project 连接。
   */
  readonly knowledge: KnowledgeStack;
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
  /** 跳过 kg sync 启动触发+fs-watch 挂接（生产缺省启动；测试面默认跳——真 codegraph 构建不进测试，T2.2）。 */
  readonly skipKgSyncStartup?: boolean;
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
  //    resolve-rg 三级解析 + rg --version 探针（2s 超时/退出码 0），结果──
  //    内存定格——进程生命周期内不重新解析、不升级）──
  // HELIX_RG_PATH/PATH 的 process.env 读取收束于本组合根（AG-08 唯一例外面，
  // 壳注入的资源定位参数，非配置源）；resolve-rg.ts 本体零 env/fs 依赖。
  // 定格产物经 buildSessionStack → CoreToolExecutor 注入 grep 门面（门面
  // 运行期只读内存标识选后端；首败永久降级编排见 GrepTool.ts）。
  const rgResolution = resolveRgPath({
    bundlePath: process.env.HELIX_RG_PATH,
    configPath: config.rgPath,
    pathEnv: process.env.PATH,
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
    logger.info(`grep 后端定格内置 TS：${grepFreeze.reasons.join("；")}`);
  }

  // ── codegraph 引擎三级解析定格（T2.1/AF-2，TR-AD-32 同模式）──────
  //    HELIX_CODEGRAPH_PATH/PATH 的 process.env 读取收束于本组合根
  //    （AG-08 唯一例外面，壳注入的资源定位参数，非配置源）；
  //    resolve-codegraph.ts 本体零 env/fs 依赖。三级全 miss ≠ 装配失败：
  //    引擎面定格不可用（binaryPath=null），构建面 degraded（AF-2）。──
  const codegraphResolution = resolveCodegraphPath({
    bundlePath: process.env.HELIX_CODEGRAPH_PATH,
    configPath: config.codegraphPath,
    pathEnv: process.env.PATH,
    probe: isExecutableFile,
  });
  if (codegraphResolution.kind === "resolved") {
    logger.info(`codegraph 引擎定格（source=${codegraphResolution.source}）：${codegraphResolution.path}`);
  } else {
    logger.info(`codegraph 引擎不可用（构建面 degraded，AF-2）：${codegraphResolution.reasons.join("；")}`);
  }
  const knowledge = buildKnowledgeStack({ codegraphResolution });

  // ── 装配序步 2-4：持久化族 → 模型域 → 会话/运行面（architecture §4.2.2） ──
  const persistence = buildPersistence({ paths, logger });
  const modelStack = buildModelStack({ paths, logger });
  const clock: ClockPort = { now: () => new Date().toISOString(), nowMs: () => Date.now() };

  // ── fan-out 发布面（先建，服务构造即依赖它；目标归 wireEventFanout 装配） ──
  const fanoutPublisher = new FanoutPublisher();

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
    browserPort,
    events: fanoutPublisher,
    publishResourceChanged: (kind) => resourceEvents.publish({ kind }),
    backfill,
    engineMode: deps.engineMode,
    subagentRunnerOverride: deps.subagentRunnerOverride,
    toolCwd: deps.toolCwd,
    // grep 启动定格产物（AF-1）：rg 定格时注入路径 + 降级 warning 面；
    // ts 定格时仅注入 warning 面（降级路径不会触发，门面恒走 ts）。
    grep: {
      rgPath: grepFreeze.kind === "rg" ? grepFreeze.rgPath : undefined,
      warn: (m) => logger.warn(m),
    },
    builtinSkillsDir: deps.builtinSkillsDir,
    sessionIdleUnloadMs: deps.sessionIdleUnloadMs,
    sessionIdlePollMs: deps.sessionIdlePollMs,
  });
  const { resourceService, subagentLauncher, scheduler, eventStream, registry, sessionService, resolveSubagentModelId } = sessionStack;

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

  // ── 会话路由对话入口：CLI / WS 共用——sessionId 缺省 = 当前会话 ──
  const chatRouter: SessionChatPort = {
    sendMessage: async (text: string, sessionId?: string, images?: readonly string[]): Promise<SendOutcome> => {
      const target = sessionId ?? registry.currentSessionId();
      const runtime = registry.peek(target) ?? (await registry.get(target));
      return runtime.chatService.sendMessage(text, images);
    },
    steer: async (text: string, sessionId?: string, instanceId?: string): Promise<{ entryId: string }> => {
      const target = sessionId ?? registry.currentSessionId();
      const runtime = registry.peek(target) ?? (await registry.get(target));
      // instanceId 透传——定向/主实例分流判定归 ChatService（契约 v0.3 §3.2）
      return runtime.chatService.steer(text, instanceId);
    },
    abort: (sessionId?: string): void => {
      // 冷会话无在飞 run（卸载前置条件 = idle）——热会话直接中断
      const target = sessionId ?? registry.currentSessionId();
      registry.peek(target)?.chatService.abort();
    },
  };

  // ── driving：CLI（stdout 事件发布器由组合根构造并注入两侧） ─────
  const stdoutPublisher = new StdoutEventPublisher(deps.cliOutput ?? process.stdout);
  const cli = new CliAdapter({
    chat: chatRouter,
    session: sessionService,
    events: stdoutPublisher,
    input: deps.cliInput,
    output: deps.cliOutput,
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

  // ── 装配序步 7.5：kg sync 启动触发 + fs-watch 兑底（T2.2，AD-15）──
  // daemon 启动 cwd = workspace 根（§3.1/TR-AD-6）：一层扫描逐项目异步
  // onStartup（不阻塞启动，失败吞——退避重试在 service 内）+ 单流 watch
  // 兑底外部编辑。测试面（createTestDaemon）默认 skip：真 codegraph 构建
  // 不进测试进程。
  let kgSyncBackground: KgSyncBackground | undefined;
  if (!deps.skipKgSyncStartup) {
    kgSyncBackground = startKgSyncBackground(knowledge, process.cwd());
  }

  let running = true;
  let wsServer: WsServerAdapter | undefined;
  // model 位数据源改会话级（AD-3 model 族 + AD-2）：当前会话
  // 引擎观测值；冷会话/引擎未暴露 → 全局默认（SQLite 读面 + builtin 兑底）
  const system: SystemPort = {
    // getStatus() 是系统级/「当前会话」（注册表最近活跃）读面——仅用于
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
      registry.stop(); // 停空闲卸载监视定时器
      scheduler.stop(); // 停 stalled 监视定时器
      registry.sealAll(); // 全部热会话封口（stopped 里程碑 write-through 落盘）
      await subagentLauncher?.dispose(); // O-6 序列回收全部存活子进程（零孤儿）
      unsubscribeBrowserStatus(); // web.status.changed 广播订阅退订（先退订再 stop）
      await browserPort.stop(); // 关全部 managed tabs → 断 CDP WS（浏览器侧零残留）
      await persistence.writeQueue.close(); // 优雅退出：drain 全部仓位后关连接（lifecycle 挂点）
      kgSyncBackground?.stop(); // 停 fs-watch + 清 sync 计时器（在库连接关闭前）
      knowledge.dispose(); // .kg per-project 连接全关（库文件保留，T2.1）
      lock?.release();
      logger.info("daemon 已关闭");
    },
  };

  // ── driving：WS 服务（127.0.0.1 + hello 握手 + 命令路由 + 事件推送）──
  // dev token 每次启动重写（<home>/dev-token，0600）；静态产物缺失不影响启动
  const token = ensureDevToken(paths.devTokenPath());
  const staticDir = deps.staticDir ?? config.staticDir;
  const staticServe = new StaticServe(staticDir);
  // 当前会话绑定编排门面：Daemon.orchestration / WS 编排命令共用——
  // spawn 携带当前会话归属 + 两级链解析模型透传（AgentInstanceDto.model
  // 填充链；T12 起不取会话当前模型）；kill/send/status 按 agentId 全局寻址
  const currentOrchestration: AgentOrchestrationPort = {
    spawn: (task, profileKind, reportIntervalMs) =>
      scheduler.spawn(
        registry.currentSessionId(),
        task,
        profileKind,
        resolveSubagentModelId(),
        reportIntervalMs, // T3-A：进展报告间隔透传
      ),
    send: (agentId, message) => scheduler.send(agentId, message),
    status: (agentId) => scheduler.status(agentId),
    kill: (agentId) => scheduler.kill(agentId),
    inspect: (agentId) => scheduler.inspect(agentId), // T3-B
  };
  // 模型/认证管理门面（AD-2）：WS model.*/auth.* 命令族回口；
  // model.changed 经 EventStream 广播（channel=model，订阅路由）
  const modelService = new ModelService({
    registry,
    catalog: modelStack.catalog,
    auth: modelStack.authStore,
    defaultModel: persistence.defaultModel,
    onModelChanged: (payload) => eventStream.broadcastModelChanged(payload),
    // thinking 批①：thinking.changed 广播出海（channel=thinking，订阅路由同 model.changed）
    onThinkingChanged: (payload) => eventStream.broadcastThinkingChanged(payload),
  });
  const ws = new WsServerAdapter({
    chat: chatRouter,
    directory: registry,
    system,
    orchestration: currentOrchestration, // agent.kill 命令链回调度
    model: modelService, // model.*/auth.* 命令族回口（AD-2）
    resource: resourceService, // agent.config 命令族回口（契约 v0.6）
    browser: browserPort, // web 族命令族回口（契约 v0.7）
    hasModel: (id) => modelStack.catalog.hasModel(id), // model 型 set 前置校验
    traceQuery: persistence.traceQuery, // trace.query 命令回口（只读面）
    events: eventStream,
    token,
    port: deps.port ?? config.port,
    staticHandler: (req) => staticServe.handle(req),
    tailSize: deps.tailSize,
  });
  wsServer = ws;
  if (!staticServe.active) {
    logger.info(
      `static-serve 未激活（staticDir=${staticDir ?? "未配置"}）——前端产物缺失不影响 daemon（T1.7 前属正常）`,
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
    devToken: token,
    subagentLauncher,
    orchestration: currentOrchestration,
    model: modelService,
    resource: resourceService,
    directory: registry,
    browser: browserPort,
    registry,
    knowledge,
    fanoutTargets: fanoutPublisher.targets,
    resourceEvents,
    runCli: () => cli.run(),
    shutdown: system.shutdown,
  };
}
