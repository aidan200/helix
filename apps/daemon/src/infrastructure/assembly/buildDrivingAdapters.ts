/**
 * 装配函数：driving 接线（组合根切片，AG-02④ 豁免面
 * infrastructure/assembly/**——M29 自 container.ts 切出）。
 *
 * 两阶段保序（装配序契约 §4.2.2 不动）：
 * - buildCliDriving：会话路由对话入口（chatRouter，CLI/WS 共用）+ stdout
 *   事件发布器 + CLI 主循环——须在 wireEventFanout（装配序步 5）之前
 *  （stdoutPublisher 是 fan-out 六目标之一），全部惰性闭包（initialize
 *   前零触发）。
 * - buildWsDriving：system 门面 + dev token/静态产物 + 当前会话编排门面 +
 *   模型/认证管理门面 + WS 服务——须在 registry.initialize 与任务恢复
 *   扫描之后（WS 端口绑定时刻不变）。running/wsServer 可变态封装在本
 *   切片内（shutdown 序列语义逐行保留）。
 */

import type { SessionChatPort, SendOutcome } from "../../application/ports/inbound/ChatPort";
import type { SystemPort, DaemonStatus } from "../../application/ports/inbound/SystemPort";
import type { AgentOrchestrationPort } from "../../application/ports/inbound/AgentOrchestrationPort";
import type { BrowserPort } from "../../application/ports/outbound/BrowserPort";
import type { SessionRegistry } from "../../application/services/SessionRegistry";
import type { SessionService } from "../../application/services/SessionService";
import type { SchedulerService } from "../../application/services/scheduler/SchedulerService";
import type { ResourceService } from "../../application/services/ResourceService";
import type { WorkspaceService } from "../../application/services/workspace/WorkspaceService";
import { ModelService } from "../../application/services/ModelService";
import { CliAdapter, StdoutEventPublisher } from "../../adapters/driving/cli/CliAdapter";
import { WsServerAdapter } from "../../adapters/driving/ws-server/WsServerAdapter";
import type { EventStream } from "../../adapters/driving/ws-server/EventStream";
import { StaticServe } from "../../adapters/driven/static-serve/StaticServe";
import type { SubagentLauncher } from "../../adapters/driven/subagent/SubagentLauncher";
import { SUBAGENT_KG_WRITER_EXTRA_TOOLS, SubAgentKgWriterProfile } from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentKgWriterProfile";
import { SUBAGENT_CODE_REVIEWER_REMOVED_TOOLS, SubAgentCodeReviewerProfile } from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentCodeReviewerProfile";
import { MainSessionProfile } from "../../adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SubAgentProfile } from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { OrchestratorProfile } from "../../adapters/driven/pi-engine/runtime/profiles/OrchestratorProfile";
import { ensureDevToken } from "../dev-token";
import type { SingletonLock } from "../lifecycle";
import type { HelixPaths } from "../paths";
import type { DaemonConfig } from "../config";
import type { Logger } from "../logging";
import type { PersistenceStack } from "./buildPersistence";
import type { ModelStack } from "./buildModelStack";
import type { TaskStack } from "./buildTaskStack";
import type { SessionStack } from "./buildSessionStack";
import type { KgResolverGroup } from "./buildKgResolverGroup";

// ── 阶段一：chatRouter + CLI（wireEventFanout 之前） ─────────────────

export interface CliDrivingDeps {
  readonly registry: SessionRegistry;
  readonly sessionService: SessionService;
  /** CLI 输入流覆盖（缺省 process.stdin；真实启动面）。 */
  readonly cliInput?: NodeJS.ReadableStream;
  /** CLI 输出流覆盖（缺省 process.stdout；真实启动面）。 */
  readonly cliOutput?: NodeJS.WritableStream;
}

export interface CliDriving {
  /** 会话路由对话入口（chatRouter 本体；SessionChatPort = ChatPort 超集）。 */
  readonly chat: SessionChatPort;
  /** stdout 事件发布器（组合根构造并注入两侧——fan-out 目标 + CLI）。 */
  readonly stdoutPublisher: StdoutEventPublisher;
  /** CLI 主循环适配器。 */
  readonly cli: CliAdapter;
}

export function buildCliDriving(deps: CliDrivingDeps): CliDriving {
  const { registry } = deps;
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
    session: deps.sessionService,
    events: stdoutPublisher,
    input: deps.cliInput,
    output: deps.cliOutput,
  });
  return { chat: chatRouter, stdoutPublisher, cli };
}

// ── 阶段二：system + 编排/模型门面 + WS（initialize/恢复扫描之后） ────

export interface WsDrivingDeps {
  readonly registry: SessionRegistry;
  readonly scheduler: SchedulerService;
  /** SubAgent 模型两级链解析单点（spawn 透传，T12 起不取会话当前模型）。 */
  readonly resolveSubagentModelId: SessionStack["resolveSubagentModelId"];
  readonly chat: SessionChatPort;
  readonly persistence: PersistenceStack;
  readonly modelStack: ModelStack;
  readonly taskStack: TaskStack;
  /** kg 族命令回口解析器群（M29/M30 切片同源注入）。 */
  readonly kgResolvers: KgResolverGroup;
  readonly resourceService: ResourceService;
  readonly subagentLauncher: SubagentLauncher | undefined;
  readonly eventStream: EventStream;
  readonly browserPort: BrowserPort;
  readonly workspace: WorkspaceService;
  readonly config: DaemonConfig;
  readonly paths: HelixPaths;
  readonly lock: SingletonLock | undefined;
  readonly logger: Logger;
  /** web.status.changed 广播订阅退订面（shutdown 先退订再 stop）。 */
  readonly unsubscribeBrowserStatus: () => void;
  /** WS 监听端口覆盖（0 = 随机；缺省取 config.port）。 */
  readonly port?: number;
  /** 前端静态产物目录覆盖（缺省取 config.staticDir）。 */
  readonly staticDir?: string;
  /** 主时间轴尾窗大小覆盖（G-1 注入面；缺省 WsServerAdapter 内建缺省）。 */
  readonly tailSize?: number;
}

export interface WsDriving {
  readonly system: SystemPort;
  /** WS 服务（127.0.0.1；实际监听端口/地址可观测）。 */
  readonly ws: WsServerAdapter;
  /** 本次启动生成的 dev token（与 <home>/dev-token 文件内容一致）。 */
  readonly devToken: string;
  /** 编排入口（spawn/send/status/kill；三工具与 WS 命令的公共回口）。 */
  readonly orchestration: AgentOrchestrationPort;
  /** 模型/认证管理入口（AD-2：model 族与 auth 族命令公共回口）。 */
  readonly model: ModelService;
}

export function buildWsDriving(deps: WsDrivingDeps): WsDriving {
  const { registry, scheduler, persistence, modelStack, eventStream, browserPort, workspace, config, paths, lock, logger } = deps;
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
      await deps.subagentLauncher?.dispose(); // O-6 序列回收全部存活子进程（零孤儿）
      deps.unsubscribeBrowserStatus(); // web.status.changed 广播订阅退订（先退订再 stop）
      await browserPort.stop(); // 关全部 managed tabs → 断 CDP WS（浏览器侧零残留）
      await persistence.writeQueue.close(); // 优雅退出：drain 全部仓位后关连接（lifecycle 挂点）
      workspace.dispose(); // 停 kg background + .kg per-project 连接全关（库文件保留，T2.1；W1 经持有者）
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
        deps.resolveSubagentModelId(profileKind),
        reportIntervalMs, // T3-A：进展报告间隔透传
      ),
    send: (agentId, message) => scheduler.send(agentId, message),
    status: (agentId) => scheduler.status(agentId),
    kill: (agentId) => scheduler.kill(agentId),
    inspect: (agentId) => scheduler.inspect(agentId), // T3-B
    park: (agentId) => scheduler.park(agentId), // ⑤ 链 C：reason 缺省 user（chat 域入口）
    resume: (agentId) => scheduler.resume(agentId), // ⑤ 链 C
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
    chat: deps.chat,
    directory: registry,
    system,
    orchestration: currentOrchestration, // agent.kill 命令链回调度
    model: modelService, // model.*/auth.* 命令族回口（AD-2）
    compactionConfig: persistence.compactionConfig, // config 族命令回口（压缩参数）
    resource: deps.resourceService, // agent.config 命令族回口（契约 v0.6）
    browser: browserPort, // web 族命令族回口（契约 v0.7）
    hasModel: (id) => modelStack.catalog.hasModel(id), // model 型 set 前置校验
    // agent-roster 批：kg-writer 派生面恒在工具（增量常量单源——driving
    // 不得 import driven，经窄数据面注入；list 缺省全量的 system 只读块派生用）
    kgWriterPinnedTools: SUBAGENT_KG_WRITER_EXTRA_TOOLS,
    // D5 第五 kind：reviewer 派生面恒摘除工具（摘除常量单源——窄数据面注入，
    // kgWriterPinnedTools 同法；list 缺省全量的 system 只读块派生用）
    reviewerRemovedTools: SUBAGENT_CODE_REVIEWER_REMOVED_TOOLS,
    // base prompt 批：base 段系统提示词读面（五 profile 声明单源——
    // kg-writer = SUBAGENT base + 图谱产出型后缀 / reviewer = SUBAGENT base
    // + 评审纪律后缀，均已在 profile 声明拼好；窄数据面注入，driving 不 import driven）
    basePrompts: {
      "main-session": MainSessionProfile.systemPrompt,
      "subagent-worker": SubAgentProfile.systemPrompt,
      "orchestrator": OrchestratorProfile.systemPrompt,
      "subagent-kg-writer": SubAgentKgWriterProfile.systemPrompt,
      "subagent-code-reviewer": SubAgentCodeReviewerProfile.systemPrompt,
    },
    traceQuery: persistence.traceQuery, // trace.query 命令回口（只读面）
    // kg 族命令回口（P-1 六命令，§9；project 参数 service 内单点解析）——
    // W1 重绑接缝：经 workspace 持有者读现值（deps.kg 直接注入形态保留给
    // stub 测试 rig；未绑定 → handler 空集/拒绝防御契约）
    workspace, // workspace 族命令回口（W1：get/open 两命令 + 门禁判别面）
    // task 族命令回口（P-2 任务页九命令族，§8.1，T1.5）：读面 + 生命周期
    // 写面（task.changed 广播在 handlers/task.ts + EventStream 层接线，O-7）
    taskQuery: deps.taskStack.query,
    taskEngine: deps.taskStack.taskEngine,
    // kg-bootstrap 五命令回口（T3.2）：解析器形态（workspace 现值跟随；直连注入保留给 stub rig）
    kgBootstrap: deps.kgResolvers.kgBootstrapResolver,
    // kg 维护批两命令回口（C1）：解析器形态（同接缝）
    kgMaintenance: deps.kgResolvers.kgMaintenanceResolver,
    // kg 评审批一命令回口（W2-F）：解析器形态（同接缝）
    kgReview: deps.kgResolvers.kgReviewResolver,
    // code-review 批一命令回口（code-review v1.5）：解析器形态（同接缝）
    codeReview: deps.kgResolvers.codeReviewResolver,
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
  return { system, ws, devToken: token, orchestration: currentOrchestration, model: modelService };
}
