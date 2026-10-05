/**
 * 装配函数：driving 接线（组合根切片，AG-02④ 豁免面
 * infrastructure/assembly/**——M29 自 container.ts 切出）。
 *
 * 两阶段保序（装配序契约 §4.2.2 不动）：
 * - buildCliDriving：会话路由对话入口（chatRouter，CLI/WS 共用）+ stdout
 *   事件发布器 + CLI 主循环——须在 wireEventFanout（装配序步 5）之前
 *  （stdoutPublisher 是 fan-out 七目标之一），全部惰性闭包（initialize
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
import type { AskService } from "../../application/services/AskService";
import type { WorkspaceService } from "../../application/services/workspace/WorkspaceService";
import { ModelService } from "../../application/services/ModelService";
import { CliAdapter, StdoutEventPublisher } from "../../adapters/driving/cli/CliAdapter";
import { WsServerAdapter, type McpCommandDeps } from "../../adapters/driving/ws-server/WsServerAdapter";
import { createDaemonFreshnessProvider } from "../../adapters/driven/freshness/SourceFreshness";
import type { EventStream } from "../../adapters/driving/ws-server/EventStream";
import type { VoiceCommandDeps } from "../../adapters/driving/ws-server/handlers/context";
import type {
  StewardCommandDeps,
  SurfaceCommandDeps,
  EmbeddingCommandDeps,
  ProviderCommandDeps,
} from "../../adapters/driving/ws-server/handlers/context";
import { StaticServe } from "../../adapters/driven/static-serve/StaticServe";
import type { SubagentLauncher } from "../../adapters/driven/subagent/SubagentLauncher";
import { SUBAGENT_KG_WRITER_EXTRA_TOOLS, SubAgentKgWriterProfile } from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentKgWriterProfile";
import { SubAgentCodeReviewerProfile } from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentCodeReviewerProfile";
import { MainSessionProfile } from "../../adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SubAgentProfile } from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { OrchestratorProfile } from "../../adapters/driven/pi-engine/runtime/profiles/OrchestratorProfile";
import { ensureDevToken } from "../dev-token";
import { DashScopeSttAdapter, DASHSCOPE_PROVIDER_ID } from "../../adapters/driven/stt/dashscope";
import { SiliconFlowSttAdapter, SILICONFLOW_PROVIDER_ID } from "../../adapters/driven/stt/siliconflow";
import { DashScopeRealtimeSttAdapter } from "../../adapters/driven/stt/realtime";
import { SttStreamService } from "../../application/stt/SttStreamService";
import type { SingletonLock } from "../lifecycle";
import type { HelixPaths } from "../paths";
import type { DaemonConfig } from "../config";
import { DEFAULT_PORT } from "../config";
import type { Logger } from "../logging";
import type { PersistenceStack } from "./buildPersistence";
import type { SandboxConfigPort } from "../../application/ports/outbound/SandboxConfigPort";
import type { TopicConfigPort } from "../../application/ports/outbound/TopicConfigPort";
import type { PortConfigPort } from "../../application/ports/outbound/PortConfigPort";
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

/**
 * 当前会话绑定编排门面纯工厂（可测化抽出——buildWsDriving 本体有
 * ensureDevToken 写盘等副作用，窄测试只打本工厂）。
 *
 * spawn 携带当前会话归属 + 两级链解析模型透传（AgentInstanceDto.model
 * 填充链；T12 起不取会话当前模型）；kill/send/status 按 agentId 全局寻址。
 *
 * 坑因登记（code-review 低危波次实测）：port 签名的第 4 参 options
 * （U3 writes 写面声明）曾在本适配层被整个丢弃——少参箭头函数赋多参
 * 接口在 TS 协变下合法，静默退化 shared（isolated 声明不到 launcher，
 * provisioner 零参与，实例 bash 自建散乱 worktree）。options 透传必须
 * 显式书写，测试钉死（orchestration-facade.test.ts）。
 */
export function buildOrchestrationFacade(deps: {
  readonly registry: SessionRegistry;
  readonly scheduler: SchedulerService;
  readonly resolveSubagentModelId: SessionStack["resolveSubagentModelId"];
}): AgentOrchestrationPort {
  const { registry, scheduler } = deps;
  return {
    spawn: (task, profileKind, reportIntervalMs, options) =>
      scheduler.spawn(
        registry.currentSessionId(),
        task,
        profileKind,
        deps.resolveSubagentModelId(profileKind),
        reportIntervalMs, // T3-A：进展报告间隔透传
        options, // U3：writes 写面声明透传（漏参即静默退化 shared——见工厂头注）
      ),
    send: (agentId, message) => scheduler.send(agentId, message),
    status: (agentId) => scheduler.status(agentId),
    kill: (agentId) => scheduler.kill(agentId),
    inspect: (agentId) => scheduler.inspect(agentId), // T3-B
    park: (agentId) => scheduler.park(agentId), // ⑤ 链 C：reason 缺省 user（chat 域入口）
    resume: (agentId) => scheduler.resume(agentId), // ⑤ 链 C
  };
}

export interface WsDrivingDeps {
  readonly registry: SessionRegistry;
  readonly scheduler: SchedulerService;
  /** SubAgent 模型两级链解析单点（spawn 透传，T12 起不取会话当前模型）。 */
  readonly resolveSubagentModelId: SessionStack["resolveSubagentModelId"];
  readonly chat: SessionChatPort;
  readonly persistence: PersistenceStack;
  /** WS 端口配置面（config.get/set_port 回口；组合根装配 argv/KV/实际端口信息）。 */
  readonly portConfig?: PortConfigPort;
  /** 沙箱开关（config.get/set_sandbox 回口；沙箱开关批）。 */
  readonly sandboxConfig?: SandboxConfigPort;
  /** 动态主题配置读写面（config.get/set_topic 命令族；动态主题批）。 */
  readonly topicConfig?: TopicConfigPort;
  /** 分类端点清单读面（config.get/set_topic 回执携带）。 */
  readonly topicJudgeEndpoints?: () => readonly { id: string; name: string }[];
  /** 提权申请仲裁面（ask.answer 命令回口；permission_request 批）。 */
  readonly askService?: AskService;
  readonly modelStack: ModelStack;
  readonly taskStack: TaskStack;
  /**
   * T3 diff.get 查询面（sessionStack.diff 透传）：热会话 diff 状态读面 +
   * TurnDiffService 查询操作面——WS diff.get 命令回口（未装配 →
   * command.unimplemented，task/kg 族先例）。
   */
  readonly diff?: SessionStack["diff"];
  /** kg 族命令回口解析器群（M29/M30 切片同源注入）。 */
  readonly kgResolvers: KgResolverGroup;
  readonly resourceService: ResourceService;
  /**
   * skill 正文读面（skill-content 批）：技能名 → SKILL.md 全文 + 路径。
   * 组合根构造（SkillScanner scan 现拍 + 读文件；未知名/读取失败 →
   * undefined）——agent.skill_content.get 命令回口，经 WsServerAdapter
   * 窄数据面透传（driving 不 import driven）。
   */
  readonly skillContentOf: (name: string) => Promise<{ filePath: string; content: string } | undefined>;
  /** skills 添加批：用户级技能创建写面（可选——stub rig 防御）。 */
  readonly skillCreateOf?: (content: string) => Promise<import("../../application/ports/outbound/SkillSourcePort").SkillCreateOutcome>;
  readonly subagentLauncher: SubagentLauncher | undefined;
  /** U1 manifest 落盘面（shutdown flush 挂点——去抖收尾，测试 tmpdir 复活竞态免疫）。 */
  readonly manifestStore: { dispose(): Promise<void> } | undefined;
  /** 管家记忆 GC 定时器停面（遗忘机制批：shutdown 清 interval——TR-152
   *  落盘面定时器纪律；未装配记忆 = undefined）。 */
  readonly stopStewardMemoryGc?: () => void;
  readonly eventStream: EventStream;
  readonly browserPort: BrowserPort;
  /**
   * 语音播报面（V2 TTS）：voice 族三命令回口（TtsPort + key 读面 +
   * EventStream 连接级订阅面）。可选：未注入 → 三命令回 command.unimplemented
   *（stt 先例；stub rig 兼容）。
   */
  readonly voice?: VoiceCommandDeps;
  /**
   * 文本管家面（V2.5）：steward 族六命令回口（StewardService + EventStream
   * 连接级 steward 订阅面）。可选：未注入 → 六命令回 command.unimplemented
   *（voice 先例；stub rig 兼容）。
   */
  readonly steward?: StewardCommandDeps;
  /**
   * 表面协议面（M0 表面协议地基批）：surface 族四命令回口
   * （SurfaceRegistry——注册/事件上行/回执只转发不决策）。可选：未注入
   * → 四命令回 command.unimplemented（steward 先例；stub rig 兼容）。
   */
  readonly surface?: SurfaceCommandDeps;
  /**
   * embedding 配置域回口（管家记忆 B2）：端点 CRUD + 连通测试
   * （EmbeddingConfigService）。可选：未注入 → 四命令回
   * command.unimplemented（steward 先例；stub rig 兼容）。
   */
  readonly embedding?: EmbeddingCommandDeps;
  /**
   * 三方平台回口（三方平台批）：自定义 OpenAI 兼容平台 CRUD
   * （CustomProviderService）。可选：未注入 → 三命令回
   * command.unimplemented（embedding 同构；stub rig 兼容）。
   */
  readonly provider?: ProviderCommandDeps;
  /**
   * mcp 族命令依赖面（mcp 批）：McpServerPort + 配置窄写面（组合根闭包）。
   * 可选：未注入 → mcp 六命令回 command.unimplemented（stub rig 兼容）。
   */
  readonly mcp?: McpCommandDeps;
  readonly workspace: WorkspaceService;
  readonly config: DaemonConfig;
  readonly paths: HelixPaths;
  readonly lock: SingletonLock | undefined;
  readonly logger: Logger;
  /** web.status.changed 广播订阅退订面（shutdown 先退订再 stop）。 */
  readonly unsubscribeBrowserStatus: () => void;
  /** mcp 批：MCP 注册表收尾（退订状态广播 + stopAll kill 全部 server 子进程）。 */
  readonly stopMcp?: () => void;
  /** WS 监听端口（组合根解析链 argv --port > KV daemon_port > 7333 的定格产物；0 = 随机）。 */
  readonly port?: number;
  /**
   * daemon 进程启动时刻（epoch ms；stale-indicator 批）：组装根 bootedAtMs
   * 单源透传——welcome daemonFreshness 的比对基准。
   */
  readonly daemonStartedAtMs?: number;
  /** 前端静态产物目录覆盖（缺省取 config.staticDir）。 */
  readonly staticDir?: string;
  /** 主时间轴尾窗大小覆盖（G-1 注入面；缺省 WsServerAdapter 内建缺省）。 */
  readonly tailSize?: number;
  /** 握手超时窗口 ms 覆盖（修复批③注入口；缺省 10s）。 */
  readonly wsHandshakeTimeoutMs?: number;
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
  /**
   * shutdown memo 化（code-review M5 可重入防护）：main.ts SIGTERM handler
   * 与 parent-watchdog onOrphan 共用同一 gracefulExit——SIGTERM 重复送达或
   * watchdog+SIGTERM 竞态会使 shutdown 并发重入，sealAll/dispose/stopMcp/
   * browserPort.stop 序列交错执行。二次调用直接返回首次结果（序列恰好执行
   * 一次；首次失败时同一 rejected promise 透传，调用方各自观测）。
   */
  let shutdownPromise: Promise<void> | undefined;
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
      shutdownPromise ??= (async () => {
        running = false;
        wsServer?.stop(); // 先停 WS（不再接受新连接/命令），再收尾业务
        registry.stop(); // 停空闲卸载监视定时器
        scheduler.stop(); // 停 stalled 监视定时器
        registry.sealAll(); // 全部热会话封口（stopped 里程碑 write-through 落盘）
        await deps.subagentLauncher?.dispose(); // O-6 序列回收全部存活子进程（零孤儿）
        await deps.manifestStore?.dispose(); // U1 manifest 去抖收尾（flush 后零异步写——tmpdir 复活竞态免疫）
        deps.unsubscribeBrowserStatus(); // web.status.changed 广播订阅退订（先退订再 stop）
        deps.stopMcp?.(); // mcp 批：MCP 状态广播退订 + 全部 server 子进程收尾
        deps.stopStewardMemoryGc?.(); // 遗忘机制批：停记忆 GC 定时器（interval 不阻退出，优雅关停双保险）
        await browserPort.stop(); // 关全部 managed tabs → 断 CDP WS（浏览器侧零残留）
        await persistence.writeQueue.close(); // 优雅退出：drain 全部仓位后关连接（lifecycle 挂点）
        workspace.dispose(); // 停 kg background + .kg per-project 连接全关（库文件保留，T2.1；W1 经持有者）
        lock?.release();
        logger.info("daemon 已关闭");
      })();
      return shutdownPromise;
    },
  };

  // ── driving：WS 服务（127.0.0.1 + hello 握手 + 命令路由 + 事件推送）──
  // dev token 每次启动重写（<home>/dev-token，0600）；静态产物缺失不影响启动
  const token = ensureDevToken(paths.devTokenPath());
  const staticDir = deps.staticDir ?? config.staticDir;
  const staticServe = new StaticServe(staticDir);
  // 当前会话绑定编排门面：Daemon.orchestration / WS 编排命令共用（门面装配
  // 抽出为 buildOrchestrationFacade 纯工厂——可测化，见下方导出）。
  const currentOrchestration = buildOrchestrationFacade({
    registry,
    scheduler,
    resolveSubagentModelId: deps.resolveSubagentModelId,
  });
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
    // 语音输入批 V1：STT provider 扩展集（auth.set_key/authList 放行——非
    // LLM 目录成员；authVerify 回明确说明不走 LLM 验证）
    sttProviderIds: [DASHSCOPE_PROVIDER_ID, SILICONFLOW_PROVIDER_ID],
  });
  const ws = new WsServerAdapter({
    chat: deps.chat,
    directory: registry,
    system,
    orchestration: currentOrchestration, // agent.kill 命令链回调度
    model: modelService, // model.*/auth.* 命令族回口（AD-2）
    compactionConfig: persistence.compactionConfig, // config 族命令回口（压缩参数）
    schedulingConfig: persistence.schedulingConfig, // config 族命令回口（SubAgent 调度预算）
    ...(deps.portConfig !== undefined ? { portConfig: deps.portConfig } : {}), // config 族命令回口（WS 端口；组合根注入）
    ...(deps.sandboxConfig !== undefined ? { sandboxConfig: deps.sandboxConfig } : {}), // config 族命令回口（沙箱开关；沙箱开关批）
    ...(deps.topicConfig !== undefined ? { topicConfig: deps.topicConfig } : {}), // config 族命令回口（动态主题；动态主题批）
    ...(deps.topicJudgeEndpoints !== undefined ? { topicJudgeEndpoints: deps.topicJudgeEndpoints } : {}), // 分类端点清单（config.topic 回执）
    ...(deps.askService !== undefined ? { askService: deps.askService } : {}), // ask.answer 命令回口（提权申请批）
    resource: deps.resourceService, // agent.config 命令族回口（契约 v0.6）
    browser: browserPort, // web 族命令族回口（契约 v0.7）
    // 语音输入批 V1 + 流式转写批 V3b-1：stt 命令族回口（SttPort 装配优先序 =
    // dashscope 主选、siliconflow 兜底；流式面 = SttStreamService 连接级单流
    // 生命周期 + DashScope realtime adapter——冒烟证据 docs/temp/stt-streaming/
    // DECISION.md：qwen3-asr-flash-realtime + corpus 偏置单转写架构；key 读面
    // 对齐 model-provider AuthStore getter 先例——每次调用重读 auth.json，
    // 换 key 后自动跟随）
    stt: {
      providers: [new DashScopeSttAdapter({ getApiKey: () => modelStack.authStore.apiKeyOf(DASHSCOPE_PROVIDER_ID) }), new SiliconFlowSttAdapter({ getApiKey: () => modelStack.authStore.apiKeyOf(SILICONFLOW_PROVIDER_ID) })],
      apiKeyOf: (providerId) => modelStack.authStore.apiKeyOf(providerId),
      stream: {
        service: new SttStreamService({
          adapters: [new DashScopeRealtimeSttAdapter({ getApiKey: () => modelStack.authStore.apiKeyOf(DASHSCOPE_PROVIDER_ID) })],
          apiKeyOf: (providerId) => modelStack.authStore.apiKeyOf(providerId),
        }),
      },
    },
    // 语音播报批 V2：voice 族三命令回口（TTS 与 BroadcastService 同源 adapter；
    // key 读面同 stt 先例——每次调用重读 auth.json，换 key 自动跟随）
    ...(deps.voice !== undefined ? { voice: deps.voice } : {}),
    // 文本管家批 V2.5：steward 族六命令回口（StewardService + feed 订阅面）
    ...(deps.steward !== undefined ? { steward: deps.steward } : {}),
    // surface 批（M0 表面协议地基）：surface 族四命令回口（未注入 → 回
    // unimplemented——stub rig 兼容）
    ...(deps.surface !== undefined ? { surface: deps.surface } : {}),
    // 管家记忆 B2：embedding 配置域回口（端点 CRUD + 连通测试；未注入 →
    // 四命令回 unimplemented——stub rig 兼容）
    ...(deps.embedding !== undefined ? { embedding: deps.embedding } : {}),
    // 三方平台批：provider 族三命令回口（未注入 → 回 unimplemented；组合根恒注入）
    ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
    // mcp 批：mcp 族六命令回口（未注入 → 回 unimplemented；组合根恒注入）
    ...(deps.mcp !== undefined ? { mcp: deps.mcp } : {}),
    hasModel: (id) => modelStack.catalog.hasModel(id), // model 型 set 前置校验
    // agent-roster 批：kg-writer 派生面恒在工具（增量常量单源——driving
    // 不得 import driven，经窄数据面注入；list 缺省全量的 system 只读块派生用）
    kgWriterPinnedTools: SUBAGENT_KG_WRITER_EXTRA_TOOLS,
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
    // skill-content 批：skill 正文读面（技能名 → SKILL.md 全文 + 路径）——
    // 任务栈扫描器同形同源复用（scan 现拍 + 读文件；未知名/读取失败 →
    // undefined，handler 回 invalid_payload）
    skillContentOf: deps.skillContentOf,
    // skills 添加批：用户级技能创建写面（SKILL.md 全文 → SkillCreateOutcome；
    // 可选——stub rig 未注入 → handler 回 skipped 防御）
    skillCreateOf: deps.skillCreateOf,
    traceQuery: persistence.traceQuery, // trace.query 命令回口（只读面）
    // kg 族命令回口（P-1 六命令，§9；project 参数 service 内单点解析）——
    // W1 重绑接缝：经 workspace 持有者读现值（deps.kg 直接注入形态保留给
    // stub 测试 rig；未绑定 → handler 空集/拒绝防御契约）
    workspace, // workspace 族命令回口（W1：get/open 两命令 + 门禁判别面）
    // task 族命令回口（P-2 任务页九命令族，§8.1，T1.5）：读面 + 生命周期
    // 写面（task.changed 广播在 handlers/task.ts + EventStream 层接线，O-7）
    taskQuery: deps.taskStack.query,
    taskEngine: deps.taskStack.taskEngine,
    // T3 diff.get 命令回口（轮次 diff 查询面；stub rig 缺省 → unimplemented）
    ...(deps.diff !== undefined ? { diff: deps.diff } : {}),
    // kg-bootstrap 五命令回口（T3.2）：解析器形态（workspace 现值跟随；直连注入保留给 stub rig）
    kgBootstrap: deps.kgResolvers.kgBootstrapResolver,
    // kg 维护批两命令回口（C1）：解析器形态（同接缝）
    kgMaintenance: deps.kgResolvers.kgMaintenanceResolver,
    // kg 评审批一命令回口（W2-F）：解析器形态（同接缝）
    kgReview: deps.kgResolvers.kgReviewResolver,
    // kg-triage 批一命令回口（P1）：解析器形态（同接缝）
    kgTriage: deps.kgResolvers.kgTriageResolver,
    // code-review 批一命令回口（code-review v1.5）：解析器形态（同接缝）
    codeReview: deps.kgResolvers.codeReviewResolver,
    events: eventStream,
    token,
    // stale-indicator 批：握手 freshness 读面（驱 driven 计算体；未传
    // startedAt → 不装配，welcome 缺省字段——stub 测试形态兼容）
    ...(deps.daemonStartedAtMs !== undefined
      ? { freshness: createDaemonFreshnessProvider({ startedAt: deps.daemonStartedAtMs }) }
      : {}),
    port: deps.port ?? DEFAULT_PORT, // deps.port = 组合根已解析端口（argv > KV > 7333 链定格产物）
    staticHandler: (req) => staticServe.handle(req),
    tailSize: deps.tailSize,
    // 修复批③⑤：握手超时自清 + 连接级诊断日志（INFO 一行式——未来死锁连接有轨迹可查）
    ...(deps.wsHandshakeTimeoutMs !== undefined ? { handshakeTimeoutMs: deps.wsHandshakeTimeoutMs } : {}),
    connLog: logger,
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
