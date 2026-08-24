import type { AgentOrchestrationPort } from "../../application/ports/inbound/AgentOrchestrationPort";
import type { AgentEnginePort } from "../../application/ports/outbound/AgentEnginePort";
import type { SessionRepositoryPort } from "../../application/ports/outbound/SessionRepositoryPort";
import type { EventPublisherPort } from "../../application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../application/ports/outbound/ClockPort";
import type { BrowserPort } from "../../application/ports/outbound/BrowserPort";
import type { ProfileKind } from "../../application/ports/outbound/ResourceStatePort";
import type { InstanceRunner } from "../../application/services/InstanceRunner";
import type { ProfileSnapshotData } from "../../domain/events/DomainEvent";
import path from "node:path";
import { ChatService } from "../../application/services/ChatService";
import { SessionService } from "../../application/services/SessionService";
import { RestoreService } from "../../application/services/RestoreService";
import { SchedulerService } from "../../application/services/scheduler/SchedulerService";
import { SessionProjection } from "../../application/services/SessionProjection";
import { SessionRegistry, type SessionRuntime } from "../../application/services/SessionRegistry";
import { ResourceService } from "../../application/services/ResourceService";
import { SystemPromptAssembler } from "../../application/services/SystemPromptAssembler";
import { SchedulingPolicy } from "../../domain/agent/SchedulingPolicy";
import { EventStream } from "../../adapters/driving/ws-server/EventStream";
import { lastMainAnchorId } from "@helix/protocol"; // 锚扫描基元单源 projection
import { SubagentLauncher, type SubagentLauncherDeps } from "../../adapters/driven/subagent/SubagentLauncher";
import { PiAgentEngineAdapter } from "../../adapters/driven/pi-engine/PiAgentEngineAdapter";
import { MainSessionProfile, MAIN_SESSION_SYSTEM_PROMPT } from "../../adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { SubAgentProfile, SUBAGENT_SYSTEM_PROMPT } from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { resolveConfigModel } from "../../adapters/driven/pi-engine/model-provider";
import { resolveEffectiveThinking } from "../../adapters/driven/pi-engine/thinking-resolve";
import { ModelCatalog } from "../../adapters/driven/pi-engine/model-catalog";
import { SkillScanner } from "../../adapters/driven/pi-engine/SkillScanner";
import { TOOL_PROMPT_SNIPPETS } from "../../adapters/driven/tools/ToolPromptSnippets";
import { CoreToolExecutor } from "../../adapters/driven/tools/CoreToolExecutor";
import type { GrepToolDeps } from "../../adapters/driven/tools/grep/GrepTool";
import { AuthStore } from "../auth-store";
import type { DefaultModelStore } from "../../adapters/driven/sqlite-session/DefaultModelStore";
import type { ResourceStateStore } from "../../adapters/driven/sqlite-session/ResourceStateStore";
import { builtinSkillsDir } from "../paths";
import type { HelixPaths } from "../paths";
import type { DaemonConfig } from "../config";
import type { Logger } from "../logging";
import type { PublishResourceChanged } from "./resource-events";

/**
 * 装配函数 ③ 会话/运行面（architecture §4.2.1）：组合根的一部分
 * （AG-02④ 豁免面 infrastructure/assembly/**）。成员：资源域（ResourceService/
 * SkillScanner/组装快照）、SubagentLauncher/InstanceRunner、RestoreService、
 * SchedulerService、EventStream、SessionRegistry（buildRuntime 唯一 new 面）、
 * SessionService。
 *
 * 装配序契约（§4.2.2）：本函数整体位于 buildPersistence/buildModelStack 之后、
 * wireEventFanout 之前；registry.initialize() 归组合根（fan-out 目标装配后）。
 */
/**
 * typed 回填面（architecture §4.2.5——晚绑收口）：构造早期声明、
 * registry.initialize 前闭合的对象回填容器——字段持 typed 函数引用
 * （编译期类型约束、可 grep），非运行期字符串图；与迷你容器的本质区别：
 * 仅作构造期回填容器，不做通用服务定位器。scheduler↔registry 构造环
 * （spawnAnchorFor/injectClosure 读 registry、registry 依赖 scheduler）
 * 换序不可消解——四面统一走本回填面（消费方 ?.()，类型可见）。
 */
export interface AssemblyBackfill {
  /** spawn 时透传当前模型（AgentInstanceDto.model 填充链；registry 就绪前未定义）。 */
  currentModelOf?: (sessionId: string) => string | undefined;
  /** spawn 时刻锚计算（契约 v0.3 §1 规则②读面；registry 就绪前未定义）。 */
  computeSpawnAnchor?: (sessionId: string) => string | null;
  /** SubAgent spawn 会话快照模型源（AD-3 三级链第二级；scheduler 就绪前未定义）。 */
  spawnModelSource?: SubagentLauncherDeps["spawnModelFor"];
}

/**
 * 引擎装配形态（architecture §4.3 显式模式）：判别字段取代「注入
 * 缺省即生产」的隐式分支——生产入口（createDaemon）恒为 production；
 * 测试工厂（test/helpers/createTestDaemon.ts）注入 Fake 引擎时为 override
 * （工厂已归一：实例注入 → 每会话共享的 () => 实例）。
 */
export type EngineAssemblyMode =
  | { readonly kind: "production" }
  | { readonly kind: "override"; readonly factory: (sessionId: string) => AgentEnginePort };

export interface BuildSessionStackDeps {
  readonly paths: HelixPaths;
  readonly config: DaemonConfig;
  readonly logger: Logger;
  readonly repository: SessionRepositoryPort;
  readonly resourceState: ResourceStateStore;
  readonly clock: ClockPort;
  readonly authStore: AuthStore;
  readonly catalog: ModelCatalog;
  readonly defaultModel: DefaultModelStore;
  readonly browserPort: BrowserPort;
  /** fan-out 发布面（组合根先建、wireEventFanout 后装目标——服务构造期依赖稳定引用）。 */
  readonly events: EventPublisherPort;
  /** resources.changed 发布面（装配级总线适配——事件化后 service 只持发布函数面）。 */
  readonly publishResourceChanged: PublishResourceChanged;
  /** typed 回填面（构造早期声明；组合根在 initialize 前闭合）。 */
  readonly backfill: AssemblyBackfill;
  /** 引擎装配形态（§4.3 显式模式：production 真引擎 / override 测试工厂注入）。 */
  readonly engineMode: EngineAssemblyMode;
  /** SubAgent runner 覆盖（测试工厂注入 fake runner 驱动收口时序；缺省走真体/占位降级）。 */
  readonly subagentRunnerOverride?: InstanceRunner;
  /** 工具沙箱 cwd 覆盖（测试指向 tmp；缺省为进程工作区）。 */
  readonly toolCwd?: string;
  /** builtin 层技能目录覆盖（测试注入空 tmp 隔离；缺省 = paths.builtinSkillsDir() 随仓真目录）。 */
  readonly builtinSkillsDir?: string;
  /** 空闲卸载窗口 ms 覆盖（测试注入缩短到秒级；缺省 30min）。 */
  readonly sessionIdleUnloadMs?: number;
  /** 空闲卸载轮询间隔 ms 覆盖（测试注入面；缺省 min(60s, 窗口/10)）。 */
  readonly sessionIdlePollMs?: number;
  /** grep 后端定格注入（AF-1 启动定格产物：组合根透传；缺省 = 定格内置 TS）。 */
  readonly grep?: GrepToolDeps;
}

export interface SessionStack {
  readonly resourceService: ResourceService;
  readonly subagentLauncher: SubagentLauncher | undefined;
  readonly scheduler: SchedulerService;
  readonly eventStream: EventStream;
  readonly registry: SessionRegistry;
  readonly sessionService: SessionService;
  /** toggle applied 后的重算入口（容器订阅 resources.changed 后接此单点）。 */
  readonly refreshAssembly: (kind: ProfileKind) => Promise<void>;
}

export async function buildSessionStack(deps: BuildSessionStackDeps): Promise<SessionStack> {
  const { paths, config, logger, repository, resourceState, clock, authStore, catalog, defaultModel, browserPort, events, backfill } =
    deps;
  const { engineMode } = deps;

  // ── 资源数据域：resource_state 差异行 + 三层技能扫描 + 合取服务 ──
  // tools 全集从两 profile 声明面构建注入（AG-02：application 不得反向
  // import driven 层 profiles——组合根单向传映射表）；project 层技能根
  // 与 toolCwd 同款工作区型判定（启动时定格，不做监听）；builtin 层 =
  // daemon 随仓 resources/skills（第三源，paths 单点派生）。
  const toolCwd = deps.toolCwd ?? process.cwd();
  const skillScanner = new SkillScanner({
    userSkillsDir: paths.skillsHome(),
    projectSkillsDir: path.join(toolCwd, ".helix", "skills"),
    builtinSkillsDir: deps.builtinSkillsDir ?? builtinSkillsDir(),
    cwd: toolCwd,
  });
  const resourceService = new ResourceService({
    store: resourceState,
    skills: skillScanner,
    toolsCatalog: {
      "main-session": MainSessionProfile.tools,
      "subagent-worker": SubAgentProfile.tools,
    } satisfies Record<ProfileKind, readonly string[]>,
    // list 读面 snippet 透传（SystemPromptAssembler 同源注册表单点）
    toolSnippets: TOOL_PROMPT_SNIPPETS,
    // 生效链（事件化，架构 §4.2.3）：toggle applied → 发布
    // resources.changed（装配级总线）→ 容器订阅侧 refreshAssembly 重算该
    // kind 组装快照 + 刷新活跃 runtime（main 直改 systemPrompt/tools；
    // subagent 只更新快照缓存，spawn 时刻消费）——发布/订阅方向倒转，
    // 结构保证取代注释保证。
    publishResourceChanged: (kind) => deps.publishResourceChanged(kind),
  });

  // ── 提示组装：三段组装器 + 两 kind 组装快照（启动时定格，toggle 刷新） ──
  // base = 瘦身后 profile 常量（无工具清单，消双源）；工具段从生效集（resolveTools
  // 产物同源）派生；技能段从扫描生效集派生。main 快照供 engineFor（新会话装配
  // 读现值）+ 活跃 runtime 直改推送；subagent 快照供 SubagentLauncher spawn 定格
  // （launch 同步秒回——技能扫描异步，故缓存式：启动与 toggle applied 时重算；
  // resource_state 读面同步读不受此限——已知边界：无 toggle 的技能文件增删要
  // 下次 toggle/重启才进提示，§六「profile 全集变更不触发运行期刷新」同族）。
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
  /** toggle applied 后的重算入口（WS 命令复用面：命令只调 toggle，刷新单点在此）。 */
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

  // ── driven：SubAgent 子进程运行器（SubagentLauncher 真体，O-7 候选 A）──
  // 装配形态由 engineMode 判别字段显式声明（AD-2 + §4.3 显式模式）
  // production = 真子进程 runner + SQLite 默认模型源 + auth.json key 源；
  // override（测试工厂注入 Fake 引擎）→ 不装真体，退回占位告警替身。
  // subagentRunnerOverride 为测试注入口（优先级最高）。
  const subagentLauncher =
    engineMode.kind === "production"
      ? new SubagentLauncher({
          // thinking/model 解析输入面（AD-1 落点二）：profile 静态声明优先
          // （model 先例：声明即最高），未声明合并 resource_state kind 槽位
          // 现值（launch 时刻 getter 读取定格——配置变更后新 spawn 跟随，
          // 已 spawn 实例 env 已定格，代际生效）
          profile: () => ({
            ...SubAgentProfile,
            thinkingLevel: SubAgentProfile.thinkingLevel ?? resourceService.thinkingSlot("subagent-worker"),
          }),
          // 可观测 logger（dispose kill 失败 warn；缺省静默）
          logger,
          // 三级链第三级（AD-3）：全局兜底现值解析（set_default 后新子进程跟随）
          model: () => resolveConfigModel(defaultModel.current(), catalog.modelsView()),
          // profile.model 槽位解析目录（AD-3 第一级声明时启用；生产未声明）
          models: catalog.modelsView(),
          // 模型槽位（三级链第一级 UI 化）：resource_state kind 槽位现值
          // （launch 时刻读取定格；未设 → 后续档）
          uiModelSlot: () => {
            const slot = resourceService.modelSlot("subagent-worker");
            return slot === undefined ? undefined : resolveConfigModel(slot, catalog.modelsView());
          },
          // spawn 快照：组装产物缓存（启动/toggle 后重算，launch 读现值定格）
          spawnSnapshot: () => subagentAssembly,
          // AD-3三级链第二级：spawn 会话快照读取通道（typed 回填面——
          // scheduler 就绪后由组合根闭合；闭合前 undefined 走后续档）
          spawnModelFor: (id) => backfill.spawnModelSource?.(id),
          // 注入源切换：auth.json 现值快照（换 key 后新子进程跟随）
          apiKeys: () => authStore.apiKeysSnapshot(),
          toolCwd,
          // H-3：tool-req 转发目标 = 全局唯一 CDP 单例（ScopedBrowserProxy
          // 归属校验：ownerId 强制 = 通道 instanceId）
          browser: browserPort,
        })
      : undefined;
  const subagentRunner: InstanceRunner = deps.subagentRunnerOverride ?? subagentLauncher ?? {
    launch: (instance) =>
      logger.warn(
        `SubAgent 实例 ${instance.instanceId} 的子进程 runner 未装配（测试 Fake 引擎形态），任务未执行`,
      ),
    setCallbacks: () => undefined,
  };

  // ── service：SubAgent 调度编排（多会话共用：构造期绑死 sessionId 废弃；
  //    实例归属经 spawn 入参/AgentInstanceData.sessionId；全局预算不分裂） ──
  const restoreService = new RestoreService({ repository, clock });
  const scheduler = new SchedulerService({
    policy: new SchedulingPolicy({
      maxConcurrent: config.maxConcurrent,
      maxQueued: config.maxQueued,
    }),
    // 可观测 logger（kill 终止信号失败 warn；缺省静默）
    logger,
    runner: subagentRunner,
    events,
    repository,
    clock,
    // O-5：<home>/reports/<session>/<agentId>.md——按实例归属会话解析
    reportsDirFor: (sessionId) => path.join(paths.home, "reports", sessionId),
    // 契约 v0.3 §1 规则②：spawn 时刻锚（聚合视图读面；内存携带不落盘）
    // ——typed 回填面（registry 就绪后由组合根闭合；闭合前 null 流首）
    spawnAnchorFor: (sessionId) => backfill.computeSpawnAnchor?.(sessionId) ?? null,
    // Sub instantiated 快照供给——profile（AD-5，契约 v0.4 §2）
    // 常量全文 + model 三级链解析 id 形态（profile 槽位 ?? spawn 会话快照 ??
    // 全局兜底；与该实例 launch 实际用模同源同时点——launch 侧 resolveModelFor
    // 同序同值，仅 id → Model 对象的解析在 launcher，AD-3 联动）。
    subagentSnapshotFor: (spawnModel) => ({
      // 快照供给改读组装缓存（消观测漂移——与 launch 实际注入同源
      // 同时点）；model 链与 launcher resolveModelFor 同序：profile 槽位 ??
      // kind 槽位（uiModelSlot）?? spawn 快照 ?? 全局兑底
      thinkingLevel: SubAgentProfile.thinkingLevel ?? resourceService.thinkingSlot("subagent-worker"), // 与 resolveThinkingFor 同源同时点（AD-4④）；无配置 → undefined = 默认关
      profileSnapshot: {
        systemPrompt: subagentAssembly.systemPrompt,
        tools: [...subagentAssembly.tools],
        model:
          SubAgentProfile.model ??
          resourceService.modelSlot("subagent-worker") ??
          spawnModel ??
          defaultModel.current(),
        hooks: SubAgentProfile.hooks.map((H) => H.hookName),
      },
    }),
    // CDP 地基：agent 终态 → 回收其全部 managed tabs（idle sweep 兼底）
    onInstanceTerminal: (agentId) => void browserPort.reclaimOwner(agentId),
    // closure 注入主线（AD-8 双通道；会话反向查找：实例归属会话 → 注册表
    // 寻址目标 ChatService）。热会话同步直达（收口链时序不变）；冷会话（理论
    // 不可达——活跃实例的会话不会卸载）异步恢复后补投。注册表在本函数内
    // 后置构造——回调仅在运行期（spawn 后）触发，装配窗口内不会被调。
    injectClosure: (agentId, message, source) => {
      const sessionId = scheduler.instance(agentId)?.sessionId;
      if (sessionId === undefined) return;
      const hot = registry.peek(sessionId);
      if (hot !== undefined) {
        hot.chatService.injectClosure(message, source);
        return;
      }
      void registry
        .get(sessionId)
        .then((runtime) => runtime.chatService.injectClosure(message, source))
        .catch((err) => {
          // 冷补投失败可观测（吞错面宽于旧注释「会话已删」——恢复 IO
          // 失败/补投异常同此口；补投丢弃但收口链继续）
          logger.warn(
            `[container] SubAgent closure 冷会话补投失败（实例 ${agentId} → 会话 ${sessionId}）：${(err as Error).message}`,
          );
        });
    },
  });

  // ── driving：WS 事件流（EventPublisherPort 实现，fan-out 目标之一——
  // WS 推送显式消费者：统一信封章印 + 按 sessionId 路由， AD-3） ──
  const eventStream = new EventStream({
    // 契约 v0.3 §1：agent.spawned 帧锚点 enrichment（调度器内存携带面值）
    spawnAnchorFor: (instanceId) => scheduler.spawnAnchorOf(instanceId),
  });

  // ── service：多会话容器（AD-4 主承载） ─────────────────────
  // 会话绑定引擎工厂：测试注入实例 = 全部会话共享（单会话测试形态）；
  // 工厂 = 每会话独立；生产路径 = 真引擎 + 会话绑定工具执行器（编排三工具
  // 回口携带会话归属——agent_spawn 经此路由到目标会话的调度入参）。
  // （AD-2）+ ：新会话模型 = 构建期解析 kind 槽位 ?? 当前默认
  //（set_default/槽位 set 后新建会话跟随新值；既有会话不跟随——per-session
  // 覆盖链不变）；apiKey 经 getter 读 auth.json 现值（换 key 下一请求生效）；
  // resolveModelById = 目录活解析面（运行期换模 overlay 模型可达）。
  // spawn 透传当前模型（AgentInstanceDto.model 填充链）走 typed 回填面
  // backfill.currentModelOf（registry 就绪前 undefined，闭合前无 spawn 发生）。
  const engineFor =
    engineMode.kind === "override"
      ? engineMode.factory
      : (sessionId: string): AgentEnginePort => {
            const sessionOrchestration: AgentOrchestrationPort = {
              spawn: (task, profileKind, reportIntervalMs) =>
                scheduler.spawn(sessionId, task, profileKind, backfill.currentModelOf?.(sessionId), reportIntervalMs),
              send: (agentId, message) => scheduler.send(agentId, message),
              status: (agentId) => scheduler.status(agentId),
              kill: (agentId) => scheduler.kill(agentId),
              inspect: (agentId) => scheduler.inspect(agentId), // T3-B
            };
            const toolExecutor = new CoreToolExecutor({
              cwd: toolCwd,
              orchestration: sessionOrchestration,
              grep: deps.grep,
              // 动态族：单 browser 工具注册（ownerId 缺省 "main"——主会话
              // tab 归属）；ChildMain 子进程经 RemoteBrowserPort 转发接入（H-3）
              browser: browserPort,
            });
            // 新会话装配读组装快照现值（瘦身后 base + 生效工具清单 +
            // 生效技能段；toggle 后新会话/重建会话跟随）；model 四级链读面——
            // kind 槽位 > default_model（per-session 覆盖 = 既有 setModel 直改链）。
            // 活跃 runtime 不随槽位变更强推模型（下一装配生效——实现取舍见任务 report）。
            // thinking 解析链（§3.1 落点一/§3.3，thinking 批 T1.2）：链 =
            // [会话覆盖（引擎读面回读）, main-session kind 槽位]逐值能力适配
            // 取首个生效值；全链未配置 / reasoning=false / 链值 "off"（显式关
            // 短路）→ undefined → 注入器不动 options（pi-ai 不传 reasoning =
            // 显式关思考，默认关 D 方案）。自引用闭包仅在 turn 开始
            //（streamFn 调用）/currentThinking 观测时触发——构造完成之后
            //（闭包内 adapter 已赋值，测试同形态先例见 thinking-set-chain）。
            let adapter!: PiAgentEngineAdapter;
            adapter = new PiAgentEngineAdapter({
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
              resolveThinking: (model) =>
                resolveEffectiveThinking(
                  [adapter?.thinkingOverride(), resourceService.thinkingSlot("main-session")],
                  model,
                ),
              resolveTools: (names) => toolExecutor.resolveTools(names),
            });
            return adapter;
          };

  const registry = new SessionRegistry({
    repository,
    clock,
    scheduler,
    restore: (sessionId) => restoreService.restore(sessionId),
    // 会话运行时工厂（组合根唯一 new 面）：Session + ChatService 族 + 投影绑定
    buildRuntime: (material): SessionRuntime => {
      const engine = engineFor(material.session.id);
      // thinking 批③跨冷恢复（AD-4③）：回放末值覆盖直写引擎内存态——
      // 不走 ChatService.setThinking 发布面（零新事件流零落盘铁律，恢复不重放）；
      // 区别于 model.set 不跨冷恢复现状（TR-AD-41 反例钉死，差异不动）。
      if (material.thinkingOverride !== undefined) engine.setThinking?.(material.thinkingOverride);
      const chatService = new ChatService({
        engine,
        events,
        clock,
        session: material.session,
        restoredToolCalls: material.toolCalls,
        // 定向 steer 转投面——AgentOrchestrationPort.send（契约 v0.3 §3.2）
        // 同链路（目标状态前置判定归调度侧既有 send 链，编排泄零入 driving）
        sendToInstance: (agentId, message) => scheduler.send(agentId, message),
        // model.changed 的 from 兜底（AD-6：引擎未暴露观测值时
        // 回退全局默认，与 ModelService previous 口径一致）
        modelFallback: () => defaultModel.current(),
        // 主实例 instantiated 快照供给（AD-5）：读组装缓存
        // 缓存（与 engineFor 实际装配同源，消观测漂移；模型仍取创建时引擎
        // 观测值 ?? 全局默认）；起发布触发在注册表 promoteDraft（转正：
        // 首个用户条目；恢复路径不重发）。
        instantiatedSnapshot: (): ProfileSnapshotData => ({
          systemPrompt: mainAssembly.systemPrompt,
          tools: [...mainAssembly.tools],
          model: engine.currentModel?.() ?? defaultModel.current(),
          ...(MainSessionProfile.compaction !== undefined
            ? { compaction: MainSessionProfile.compaction }
            : {}),
          hooks: MainSessionProfile.hooks.map((H) => H.hookName),
        }),
        // 转正单点触发面：零条目草稿首个用户条目落聚合 → 注册表
        // promoteDraft（恰好一次 instantiated + 补 created；闭包仅在运行期
        // 触发——createFresh 发生在 initialize/运行期，注册表已就位）
        onFirstUserEntry: () => registry.promoteDraft(material.session.id),
      });
      // 会话投影消费者（AD-3 §3.2②；多会话 = 按 sessionId 分实例化，
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
    idleUnloadMs: deps.sessionIdleUnloadMs,
    idlePollMs: deps.sessionIdlePollMs,
    logger,
  });

  // ── services：会话状态入口（当前会话读面，经注册表组装） ──────────
  const sessionService = new SessionService({
    getView: () => registry.currentView(),
    getAgentState: () => registry.currentRuntime().chatService.agentState,
  });

  return {
    resourceService,
    subagentLauncher,
    scheduler,
    eventStream,
    registry,
    sessionService,
    refreshAssembly,
  };
}
