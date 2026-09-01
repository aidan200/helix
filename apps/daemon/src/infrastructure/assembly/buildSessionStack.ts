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
import { readFileSync } from "node:fs";
import { ChatService } from "../../application/services/ChatService";
import { SessionService } from "../../application/services/SessionService";
import { RestoreService } from "../../application/services/RestoreService";
import { SchedulerService } from "../../application/services/scheduler/SchedulerService";
import type { ClosureFindingsSink } from "../../application/services/scheduler/ClosureRecorder";
import { SessionProjection } from "../../application/services/SessionProjection";
import { SessionRegistry, type SessionRuntime } from "../../application/services/SessionRegistry";
import { profileKindOf } from "../../application/services/modes";
import { ResourceService } from "../../application/services/ResourceService";
import { SystemPromptAssembler } from "../../application/services/SystemPromptAssembler";
import { SchedulingPolicy } from "../../domain/agent/SchedulingPolicy";
import { EventStream } from "../../adapters/driving/ws-server/EventStream";
import { lastMainAnchorId } from "@helix/protocol"; // 锚扫描基元单源 projection
import { SubagentLauncher } from "../../adapters/driven/subagent/SubagentLauncher";
import { PiAgentEngineAdapter, type PiEngineOptions } from "../../adapters/driven/pi-engine/PiAgentEngineAdapter";
import { seedMessagesOf, type AgentMessage } from "../../adapters/driven/pi-engine/mappers/SessionMapper";
import { MainSessionProfile, MAIN_SESSION_SYSTEM_PROMPT } from "../../adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { DEFAULT_COMPACTION, type CompactionSettings } from "../../adapters/driven/pi-engine/runtime/AgentProfile";
import { SubAgentProfile, SUBAGENT_SYSTEM_PROMPT } from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import {
  SUBAGENT_KG_WRITER_EXTRA_TOOLS,
  SUBAGENT_KG_WRITER_PROMPT_SUFFIX,
  SubAgentKgWriterProfile,
} from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentKgWriterProfile";
import {
  OrchestratorProfile,
  ORCHESTRATOR_SYSTEM_PROMPT,
} from "../../adapters/driven/pi-engine/runtime/profiles/OrchestratorProfile";
import { isTaskSessionId, TASK_SESSION_PREFIX } from "../../application/services/task/TaskOrchestratorService";
import { resolveConfigModel } from "../../adapters/driven/pi-engine/model-provider";
import { resolveEffectiveThinking } from "../../adapters/driven/pi-engine/thinking-resolve";
import { ModelCatalog } from "../../adapters/driven/pi-engine/model-catalog";
import { SkillScanner } from "../../adapters/driven/pi-engine/SkillScanner";
import { TOOL_PROMPT_SNIPPETS } from "../../adapters/driven/tools/ToolPromptSnippets";
import { CoreToolExecutor, type KgToolOptions } from "../../adapters/driven/tools/CoreToolExecutor";
import type { TaskCreateToolDeps } from "../../adapters/driven/tools/task-create/TaskCreateTool";
import type { GrepToolDeps } from "../../adapters/driven/tools/grep/GrepTool";
import type { CodegraphToolDeps } from "../../adapters/driven/tools/codegraph/CodegraphTool";
import type { EditToolDeps } from "../../adapters/driven/tools/edit/EditTool";
import { AuthStore } from "../auth-store";
import type { DefaultModelStore } from "../../adapters/driven/sqlite-session/DefaultModelStore";
import type { DefaultThinkingStore } from "../../adapters/driven/sqlite-session/DefaultThinkingStore";
import type { CompactionConfigPort } from "../../application/ports/outbound/CompactionConfigPort";
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
 * 换序不可消解——走本回填面（消费方 ?.()，类型可见）。T12：currentModelOf
 * （改由 resolveSubagentModelId 单点供给）与 spawnModelSource（spawn 会话
 * 快照级砍除）两字段退役，仅余 spawn 锚计算一面。
 */
export interface AssemblyBackfill {
  /** spawn 时刻锚计算（契约 v0.3 §1 规则②读面；registry 就绪前未定义）。 */
  computeSpawnAnchor?: (sessionId: string) => string | null;
  /** 会话主实例 id 查询（T10a kind 判别读面：EventStream engine.error 抑制
   *  /信封条目归属编码；registry 就绪前未定义 = legacy "main" 判别兜底）。 */
  mainInstanceIdFor?: (sessionId: string) => string | undefined;
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

/**
 * 主会话 LLM 覆盖（测试接缝：fake 剧本 streamFn + 可解析 model + apiKeys）。
 * 缺省 = 生产形态（resolveConfigModel + 真 streamFn）；携带时仅替换 LLM 面
 *（工具族/引擎状态机/事件翻译全真）——与 orchestratorLlmOverride 同哲学。
 */
export interface MainSessionLlmOverride {
  readonly model: () => ReturnType<typeof resolveConfigModel>;
  readonly streamFn: NonNullable<PiEngineOptions["streamFnOverride"]>;
  /** provider → apiKey 测试覆盖（浅合并覆盖生产 authStore 快照）。 */
  readonly apiKeys?: () => Record<string, string>;
}

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
  /** R7 全局兜底批：全局默认推理强度（各 agent thinking 链尾兜底）。 */
  readonly defaultThinking?: DefaultThinkingStore;
  /** 压缩参数配置（可选——测试缺省回落 DEFAULT_COMPACTION）。 */
  readonly compactionConfig?: CompactionConfigPort;
  readonly browserPort: BrowserPort;
  /** fan-out 发布面（组合根先建、wireEventFanout 后装目标——服务构造期依赖稳定引用）。 */
  readonly events: EventPublisherPort;
  /** resources.changed 发布面（装配级总线适配——事件化后 service 只持发布函数面）。 */
  readonly publishResourceChanged: PublishResourceChanged;
  /** typed 回填面（构造早期声明；组合根在 initialize 前闭合）。 */
  readonly backfill: AssemblyBackfill;
  /** 引擎装配形态（§4.3 显式模式：production 真引擎 / override 测试工厂注入）。 */
  readonly engineMode: EngineAssemblyMode;
  /** 主会话 LLM 覆盖（测试接缝；缺省生产形态——resolveConfigModel + 真 streamFn）。 */
  readonly mainSessionLlmOverride?: MainSessionLlmOverride;
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
  /**
   * 自写 edit/edit-lines 挂点注入面工厂（T3.2 附着接线）：组合根把 kg 栈
   * （notifyWrite 写后通知 + KgAttachmentService 附着）经此注入；sessionId
   * 在 engineFor 闭包内闭合（会话级跨通道去重键）。缺省不注入（SubAgent
   * 子进程装配/测试）——容缺空操作，EditTool 行为不变。W1 绑定闭环：
   * 未绑定（无 kg 栈）时工厂返回 undefined（edit 工具无 kg 挂点）。
   */
  readonly editDeps?: (sessionId: string) => EditToolDeps | undefined;
  /**
   * kg 双工具注入面（T3.3）：提供则每会话 executor 注册 kg/kg-update
   *（结构同 CoreToolExecutorOptions.kg）。缺省不注册（测试形态）。
   * W1 绑定闭环：支持工厂形态（每会话装配时读 workspace 持有者现值——
   * 重绑后新会话跟随新栈；未绑定 → undefined 不注册）。
   */
  readonly kgTools?: KgToolOptions | (() => KgToolOptions | undefined);
  /**
   * codegraph 工具注入面（W1-B，R5/R7）：提供则每会话 executor 注册
   * codegraph（只读六 op；结构同 CoreToolExecutorOptions.codegraph）。
   * 缺省不注册（测试形态）。W1 绑定闭环同 kgTools：支持工厂形态（未绑定
   * → undefined 不注册，engineFor 同步从 main 工具集剔除该名）。
   */
  readonly codegraphTool?: CodegraphToolDeps | (() => CodegraphToolDeps | undefined);
  /**
   * codegraph 二进制定格路径（W1-B：组合根启动定格产物透传）——
   * SubagentLauncher 经 HELIX_CODEGRAPH_PATH env 传子进程（子进程三级解析
   * 缺 config 级——定格值透传保持父子一致，同 HELIX_MODEL_JSON 哲学）。
   * 缺省/undefined = 子进程仅靠继承 env 自解析（解析失败则工具 degraded）。
   */
  readonly codegraphPath?: string;
  /**
   * task_create 工具注入面（T2.4，AD-7）：主会话 executor 注册 task_create
   *（chat 第二创建入口；仅 MainAgent 生效集——SubAgent 子进程本地栈不
   * 注入）。组合根接任务栈（TaskEngineService.createTask + TaskQueryService
   * 回执读面）；缺省不注册（测试形态——profile 声明该名时 resolveTools
   * fail-fast，engineFor 未注入时从 main 工具集剔除，与 kg 双工具 W1 模式
   * 同构）。
   */
  readonly taskCreate?: TaskCreateToolDeps;
  /**
   * 会话工具沙箱 cwd 动态解析面（W1 绑定闭环）：基准改绑定的 root——
   * 每会话装配（engineFor）时求值，重绑后新会话跟随。缺省回落启动定格
   * 值；deps.toolCwd 显式注入时恒优先（测试面）。
   */
  readonly resolveToolCwd?: () => string;
  /**
   * spawn 派发任务切片注入器（T3.3，F1.3）：透传 SchedulerService
   * （组合根接 KgQueryService.injectTaskSlice）。缺省不注入。第三参
   * audience（D8 W-R6）：本函数经两条消费链分叉——SchedulerService
   * （SubAgent spawn）传 "worker"，ChatService（主会话）传 "main"。
   */
  readonly taskInjector?: (sessionId: string, task: string, audience?: "main" | "worker") => string;
  /**
   * findings 落账管道（F3.0，T4.1）：透传 SchedulerService→ClosureRecorder
   * （组合根接 kg 栈 KgWriteService；测试工厂可注入替身）。缺省不注入
   * （SubAgent 子进程装配/纯调度测试形态）。
   */
  readonly findingsSink?: ClosureFindingsSink;
  /**
   * 任务批次实例收口路由（T2.2）：调度器注入回调里 task:* 会话归属实例的
   * closure 转投编排服务（组合根接 TaskOrchestratorService.handleInstanceClosure
   * ——不升第二通路；进展报告不入）。缺省不路由（编排未装配形态，冷会话
   * 补投走既有 warn 路径）。
   */
  readonly taskClosureSink?: (agentId: string) => void;
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
  /**
   * SubAgent 模型两级链解析单点（id 形态，AD-3/T12：profile.model 静态声明 ??
   * subagent-worker kind 槽位 ?? 全局兜底）——spawn 透传（AgentInstanceDto.model
   * 填充）与 instantiated 快照供给同源；container 编排门面共用。
   */
  readonly resolveSubagentModelId: (profileKind?: string) => string;
  /**
   * 会话工具沙箱 cwd 求值单点现值读面（W1F-F1）：engineFor 每会话装配
   * （CoreToolExecutor.cwd）与 SubAgent spawn（HELIX_TOOL_CWD）共用
   * toolCwdOf 同一求值——绑定后 = 绑定 root 规范形，未绑定回落启动
   * 定格 cwd。暴露给组合根（Daemon.toolCwdNow）供集成断言（设计稿 §8
   * 「绑定后 toolCwd 基准正确」）。
   */
  readonly toolCwdNow: () => string;
  /**
   * 编排主 agent 组装快照现值读面（T2.2）：编排会话工厂消费（启动/toggle
   * 后重算缓存；编排会话短生命周期，下一会话生效——与 subagent 快照同
   * 语义）。
   */
  readonly orchestratorAssembly: () => { readonly tools: readonly string[]; readonly systemPrompt: string };
}

export async function buildSessionStack(deps: BuildSessionStackDeps): Promise<SessionStack> {
  const { paths, config, logger, repository, resourceState, clock, authStore, catalog, defaultModel, browserPort, events, backfill } =
    deps;
  const defaultThinking = deps.defaultThinking; // R7 全局兜底（可选注入——测试缺省无兜底）
  /** R7 全局兜底读面：未注入/未配置 → undefined（链尾自然短路）。 */
  const globalThinking = (): string | undefined => defaultThinking?.stored() ?? undefined;
  /** 压缩参数读面：未注入/未配置 → DEFAULT_COMPACTION（内置默认阈值）。 */
  const compactionSettings = (): CompactionSettings => {
    const c = deps.compactionConfig?.current();
    return c === undefined ? DEFAULT_COMPACTION : { enabled: true, reserveTokens: c.reserveTokens, keepRecentTokens: c.keepRecentTokens };
  };
  const { engineMode } = deps;

  // ── 资源数据域：resource_state 差异行 + 三层技能扫描 + 合取服务 ──
  // tools 全集从两 profile 声明面构建注入（AG-02：application 不得反向
  // import driven 层 profiles——组合根单向传映射表）；project 层技能根
  // 与 toolCwd 同款工作区型判定（启动时定格，不做监听）；builtin 层 =
  // daemon 随仓 resources/skills（第三源，paths 单点派生）。
  // 工具沙箱 cwd 两面（W1）：bootToolCwd = 启动定格面（技能扫描/子进程
  // env 的回退，启动时定格不做监听）；toolCwdOf = 会话面（每会话装配时
  // 读绑定 root 现值——deps.toolCwd 显式注入恒优先，未绑定回落定格值）。
  const bootToolCwd = deps.toolCwd ?? process.cwd();
  const toolCwdOf = (): string => deps.toolCwd ?? deps.resolveToolCwd?.() ?? bootToolCwd;
  const skillScanner = new SkillScanner({
    userSkillsDir: paths.skillsHome(),
    projectSkillsDir: path.join(bootToolCwd, ".helix", "skills"),
    builtinSkillsDir: deps.builtinSkillsDir ?? builtinSkillsDir(),
    cwd: bootToolCwd,
  });
  const resourceService = new ResourceService({
    store: resourceState,
    skills: skillScanner,
    toolsCatalog: {
      "main-session": MainSessionProfile.tools,
      "subagent-worker": SubAgentProfile.tools,
      "orchestrator": OrchestratorProfile.tools, // T2.2 第三 kind（additive 扩值；编排工具面可配置化）
      // R7 系统槽位批第四 kind：kg-writer 目录全集（声明面 = 快照派生同源；
      // tool/skill 启停写面仍拒——目录仅供槽位族读面形状完整）
      "subagent-kg-writer": SubAgentKgWriterProfile.tools,
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
    kind === "main-session"
      ? MAIN_SESSION_SYSTEM_PROMPT
      : kind === "subagent-worker"
        ? SUBAGENT_SYSTEM_PROMPT
        : ORCHESTRATOR_SYSTEM_PROMPT; // orchestrator（T2.2）：与 MainAgent 消费 skill 同构的三段组装
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
  // D8 W-R6：kg-writer 组装快照 = 通用 worker 生效集 + kg-update + 图谱产出型
  // 一句（增量常量单源 SubAgentKgWriterProfile；kg-update 不进 resource_state
  // 目录——不可 toggle，豁免面恒在）。toggle 刷新 worker 时同步重算（派生面）。
  const computeKgWriterAssembly = async (): Promise<{
    readonly tools: readonly string[];
    readonly systemPrompt: string;
  }> => {
    const worker = await computeAssembly("subagent-worker");
    const tools = [...worker.tools];
    for (const t of SUBAGENT_KG_WRITER_EXTRA_TOOLS) {
      if (!tools.includes(t)) tools.push(t);
    }
    return { tools, systemPrompt: `${worker.systemPrompt}\n\n${SUBAGENT_KG_WRITER_PROMPT_SUFFIX}` };
  };
  let kgWriterAssembly = await computeKgWriterAssembly();
  /** 批次实例组装快照按 profileKind 派发（W-R6 编排分流的装配端消费点）。 */
  const subagentAssemblyFor = (profileKind: string | undefined): typeof subagentAssembly =>
    profileKind === "subagent-kg-writer" ? kgWriterAssembly : subagentAssembly;
  let orchestratorAssemblyValue = await computeAssembly("orchestrator"); // T2.2：编排会话工厂消费（快照缓存，启动/toggle 重算）
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
    } else if (kind === "subagent-worker") {
      subagentAssembly = next; // 已 spawn 实例 env 已定格（代际生效，零刷新）
      kgWriterAssembly = await computeKgWriterAssembly(); // W-R6 派生面同刷（kg-writer 生效集随 worker toggle 联动）
    } else {
      orchestratorAssemblyValue = next; // 编排会话短生命周期：下一会话生效（零活跃刷新）
    }
  };

  // ── SubAgent 模型两级链解析单点（id 形态，AD-3/T12）──────────────────
  // profile.model 静态声明 ?? subagent-worker kind 槽位 ?? 全局兜底——spawn
  // 透传（AgentInstanceDto.model 填充链）与 instantiated 快照供给同源同点；
  // launcher launch 实际用模同序（id → Model 对象解析在 launcher，AD-3 联动）。
  // T12 砍 spawn 会话快照级：SubAgent 只认自身 profile，不继承 main session 选择。
  const resolveSubagentModelId = (profileKind?: string): string =>
    // R7 per-kind：kg-writer 自身槽位（不联动 worker）；profile 静态声明优先
    (profileKind === "subagent-kg-writer" ? SubAgentKgWriterProfile.model : SubAgentProfile.model) ??
    resourceService.modelSlot(profileKind === "subagent-kg-writer" ? "subagent-kg-writer" : "subagent-worker") ??
    defaultModel.current();

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
          // R7 per-kind：worker/kg-writer 各自 profile + 各自 kind 槽位 + 全局兜底
          //（不再联动 worker 槽位；未配槽位且未配全局 → undefined = 默认关）
          profile: (profileKind: string) =>
            profileKind === "subagent-kg-writer"
              ? {
                  ...SubAgentKgWriterProfile,
                  thinkingLevel:
                    SubAgentKgWriterProfile.thinkingLevel ??
                    resourceService.thinkingSlot("subagent-kg-writer") ??
                    globalThinking(),
                }
              : {
                  ...SubAgentProfile,
                  thinkingLevel:
                    SubAgentProfile.thinkingLevel ?? resourceService.thinkingSlot("subagent-worker") ?? globalThinking(),
                },
          // 可观测 logger（dispose kill 失败 warn；缺省静默）
          logger,
          // 两级链末级（AD-3/T12）：全局兜底现值解析（set_default 后新子进程跟随）
          model: () => resolveConfigModel(defaultModel.current(), catalog.modelsView()),
          // profile.model 槽位解析目录（AD-3 第一级声明时启用；生产未声明）
          models: catalog.modelsView(),
          // 模型槽位（profile 槽位 UI 化）：resource_state kind 槽位现值
          // （launch 时刻读取定格；未设 → 全局兜底）
          uiModelSlot: (profileKind: string) => {
            // R7 per-kind：kg-writer 读自身槽位（不联动 worker）
            const slot = resourceService.modelSlot(profileKind === "subagent-kg-writer" ? "subagent-kg-writer" : "subagent-worker");
            return slot === undefined ? undefined : resolveConfigModel(slot, catalog.modelsView());
          },
          // spawn 快照：组装产物缓存（启动/toggle 后重算，launch 读现值定格）。
          // W-R6：按实例 profileKind 派发——subagent-kg-writer（图谱产出型批次）
          // 领 worker 生效集 + kg-write 面；其余（缺省）领通用 worker 快照。
          spawnSnapshot: (profileKind: string) => subagentAssemblyFor(profileKind),
          // 注入源切换：auth.json 现值快照（换 key 后新子进程跟随）
          apiKeys: () => authStore.apiKeysSnapshot(),
          // W1F-F2：子进程 env cwd = spawn 时刻现值（toolCwdOf 同源求值——
          // 绑定 root 缺省回落启动 cwd；重绑后新 spawn 跟随新根，已 spawn
          // 实例 env 已定格，代际生效）。deps.toolCwd 显式注入（测试面）
          // 时恒优先（toolCwdOf 优先级链）。
          toolCwd: () => toolCwdOf(),
          // T1.4（AF-1.11 接线）：work_item 台账库路径 env 传参——与父进程
          // WriteQueue 同库（O-1：helix.db 任务表域），子进程直连自设
          // WAL+busy_timeout；启动时刻现值定格
          ledgerDbPath: () => paths.dbPath(),
          // W1-B：codegraph 二进制定格路径 env 传参（HELIX_CODEGRAPH_PATH——
          // 子进程三级解析缺 config 级，定格值透传保持父子一致；未定格不传键，
          // 子进程靠继承 env 自解析，失败则 codegraph 工具 degraded）
          codegraphPath: deps.codegraphPath,
          // F3.0（T4.1）：报告落点经 env IPC 面传参（HELIX_REPORT_PATH）——
          // 与 ClosureRecorder 兜底 reportsDirFor 同源同式（<home>/reports/<session>）
          reportDirFor: (sessionId) => path.join(paths.home, "reports", sessionId),
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
    // findings 旁路文件读（task-778eb18a 截断兜底）：fs 只读经回调注入
    //（application 零 IO——AG 守卫）；缺失/异常归一 null（best-effort）
    readFindingsFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    // 契约 v0.3 §1 规则②：spawn 时刻锚（聚合视图读面；内存携带不落盘）
    // ——typed 回填面（registry 就绪后由组合根闭合；闭合前 null 流首）
    spawnAnchorFor: (sessionId) => backfill.computeSpawnAnchor?.(sessionId) ?? null,
    // spawn 派发任务切片注入（T3.3，F1.3）：任务文本成形后/传给 launcher 前
    // 单点挂接（SchedulerService 内部消化失败）。D8 W-R6：spawn 链恒 worker
    // 受众（协议行 findings 申报措辞——SubAgent 无 kg-update）。
    ...(deps.taskInjector !== undefined
      ? { taskInjector: (sessionId: string, task: string) => deps.taskInjector!(sessionId, task, "worker") }
      : {}),
    // findings 落账管道（F3.0，T4.1）：透传 ClosureRecorder（组合根接 kg 栈）
    ...(deps.findingsSink !== undefined ? { findingsSink: deps.findingsSink } : {}),
    // pending_sync job 归属解析（W2-D R13）：task:* 会话 → jobId、chat 会话 → null
    pendingSyncJobIdOf: (sessionId) =>
      isTaskSessionId(sessionId) ? sessionId.slice(TASK_SESSION_PREFIX.length) : null,
    // Sub instantiated 快照供给——profile（AD-5，契约 v0.4 §2）
    // 常量全文 + model 两级链解析 id 形态（profile 槽位 ?? 全局兜底，T12 砍
    // spawn 会话快照级；与该实例 launch 实际用模同源同时点——launch 侧
    // resolveModelFor 同序同值，仅 id → Model 对象的解析在 launcher，AD-3 联动）。
    subagentSnapshotFor: (profileKind?: string) => ({
      // 快照供给改读组装缓存（消观测漂移——与 launch 实际注入同源
      // 同时点；W-R6：按实例 profileKind 派发 kg-writer/worker 快照）；model
      // 链与 launcher resolveModelFor 同序：profile 槽位 ?? kind 槽位（uiModelSlot）?? 全局兑底
      // R7 per-kind + 全局兜底：与 launcher resolveThinkingFor/resolveModelFor 同源同时点（AD-4④）
      thinkingLevel:
        (profileKind === "subagent-kg-writer" ? SubAgentKgWriterProfile.thinkingLevel : SubAgentProfile.thinkingLevel) ??
        resourceService.thinkingSlot(profileKind === "subagent-kg-writer" ? "subagent-kg-writer" : "subagent-worker") ??
        globalThinking(),
      profileSnapshot: {
        systemPrompt: subagentAssemblyFor(profileKind).systemPrompt,
        tools: [...subagentAssemblyFor(profileKind).tools],
        model: resolveSubagentModelId(profileKind),
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
      // T2.2 任务批次实例路由：task:* 会话归属的 closure/收口注入转投编排服务
      //（进展报告不入——编排会话不被机械信封噪扰）；非任务实例走既有会话路由。
      const ownerSession = scheduler.instance(agentId)?.sessionId;
      if (ownerSession !== undefined && isTaskSessionId(ownerSession) && source !== "progress" && deps.taskClosureSink !== undefined) {
        deps.taskClosureSink(agentId);
        return;
      }
      const sessionId = ownerSession;
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
    // T10a kind 判别读面（typed 回填面闭合前 undefined = legacy 判别兜底）
    mainInstanceIdFor: (sessionId) => backfill.mainInstanceIdFor?.(sessionId),
  });

  // ── service：多会话容器（AD-4 主承载） ─────────────────────
  // 会话绑定引擎工厂：测试注入实例 = 全部会话共享（单会话测试形态）；
  // 工厂 = 每会话独立；生产路径 = 真引擎 + 会话绑定工具执行器（编排三工具
  // 回口携带会话归属——agent_spawn 经此路由到目标会话的调度入参）。
  // （AD-2）+ ：新会话模型 = 构建期解析 kind 槽位 ?? 当前默认
  //（set_default/槽位 set 后新建会话跟随新值；既有会话不跟随——per-session
  // 覆盖链不变）；apiKey 经 getter 读 auth.json 现值（换 key 下一请求生效）；
  // resolveModelById = 目录活解析面（运行期换模 overlay 模型可达）。
  // spawn 透传模型 = 组合根两级链解析产物（resolveSubagentModelId，T12 起不再
  // 取会话当前模型——SubAgent 只认自身 profile 链）。
  // P1 T3：槽位 kind 字面量参数化——modelSlot/thinkingSlot 的 kind 从会话定格
  // mode 解析（profileKindOf；default → main-session，行为零变化；P2 多模式
  // 自动跟随注册表）。override 工厂（测试注入）不接 mode——结构兼容（参数
  // 少的函数可赋参数多的类型），Fake 引擎无槽位语义不受影响。
  const engineFor: (sessionId: string, mode?: string, seed?: readonly AgentMessage[]) => AgentEnginePort =
    engineMode.kind === "override"
      ? (sessionId: string) => engineMode.factory(sessionId)
      : (sessionId: string, mode?: string, seed?: readonly AgentMessage[]): AgentEnginePort => {
            const sessionOrchestration: AgentOrchestrationPort = {
              spawn: (task, profileKind, reportIntervalMs) =>
                scheduler.spawn(sessionId, task, profileKind, resolveSubagentModelId(), reportIntervalMs),
              send: (agentId, message) => scheduler.send(agentId, message),
              status: (agentId) => scheduler.status(agentId),
              kill: (agentId) => scheduler.kill(agentId),
              inspect: (agentId) => scheduler.inspect(agentId), // T3-B
              park: (agentId) => scheduler.park(agentId), // ⑤ 链 C：reason 缺省 user（chat 域入口）
              resume: (agentId) => scheduler.resume(agentId), // ⑤ 链 C
            };
            // W1：kg 挂点/双工具经 workspace 持有者读现值（未绑定 → 不注册/
            // 无挂点——edit 行为不变；kg/kg-update 同步从 profile 工具清单
            // 剔除，resolveTools 硬校验（声明即注册）不破，绑定后新会话获得）
            const editDeps = deps.editDeps?.(sessionId);
            const kgTools = typeof deps.kgTools === "function" ? deps.kgTools() : deps.kgTools;
            // W1-B：codegraph 工具同 kgTools W1 模式（工厂读现值；未绑定 → 不注册 + 清单剔除）
            const codegraphTool =
              typeof deps.codegraphTool === "function" ? deps.codegraphTool() : deps.codegraphTool;
            const toolExecutor = new CoreToolExecutor({
              cwd: toolCwdOf(),
              orchestration: sessionOrchestration,
              grep: deps.grep,
              ...(editDeps !== undefined ? { edit: editDeps } : {}),
              ...(kgTools !== undefined ? { kg: kgTools } : {}),
              ...(codegraphTool !== undefined ? { codegraph: codegraphTool } : {}),
              // task_create（T2.4，AD-7）：仅主会话 executor（SubAgent 子进程
              // 本地栈不注入——生效集隔离，AD-2 创建按宿主）
              ...(deps.taskCreate !== undefined ? { taskCreate: deps.taskCreate } : {}),
              // 动态族：单 browser 工具注册（ownerId 缺省 "main"——主会话
              // tab 归属）；ChildMain 子进程经 RemoteBrowserPort 转发接入（H-3）
              browser: browserPort,
            });
            // 新会话装配读组装快照现值（瘦身后 base + 生效工具清单 +
            // 生效技能段；toggle 后新会话/重建会话跟随）；model 四级链读面——
            // kind 槽位 > default_model（per-session 覆盖 = 既有 setModel 直改链）。
            // 活跃 runtime 不随槽位变更强推模型（下一装配生效——实现取舍见任务 report）。
            // thinking 解析链（§3.1 落点一/§3.3，thinking 批 T1.2）：链 =
            // [会话覆盖（引擎读面回读）, 会话模式 profileKind 槽位]逐值能力适配
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
                // W1 绑定闭环：未绑定（kg 双工具未注册）时剔除 kg/kg-update——
                // profile 声明与 executor 注册面一致（resolveTools 硬校验不破）；
                // 绑定后新建会话自动恢复注册面。
                // task_create 同款：未注入（测试形态）时剔除，声明与注册一致。
                tools: mainAssembly.tools
                  .filter((t) => kgTools !== undefined || (t !== "kg" && t !== "kg-update"))
                  .filter((t) => codegraphTool !== undefined || t !== "codegraph")
                  .filter((t) => deps.taskCreate !== undefined || t !== "task_create"),
                // 压缩参数可配置（KV 存储值 ?? DEFAULT_COMPACTION）；每会话装配读现值。
                compaction: compactionSettings(),
              },
              model: deps.mainSessionLlmOverride?.model() ?? resolveConfigModel(
                resourceService.modelSlot(profileKindOf(mode)) ?? defaultModel.current(),
                catalog.modelsView(),
              ),
              apiKeys: () => ({ ...authStore.apiKeysSnapshot(), ...(deps.mainSessionLlmOverride?.apiKeys?.() ?? {}) }),
              models: catalog.modelsView(),
              resolveModelById: (modelId) => resolveConfigModel(modelId, catalog.modelsView()),
              resolveThinking: (model) =>
                // R7 全局兜底：链尾追加全局默认（未配槽位且未配全局 → 默认关不变）
                resolveEffectiveThinking(
                  [adapter?.thinkingOverride(), resourceService.thinkingSlot(profileKindOf(mode)), globalThinking()],
                  model,
                ),
              resolveTools: (names) => toolExecutor.resolveTools(names),
              // 测试接缝：mainSessionLlmOverride 恒最高（缺省生产形态）
              ...(deps.mainSessionLlmOverride !== undefined ? { streamFnOverride: deps.mainSessionLlmOverride.streamFn } : {}),
              // 恢复回填：mainAgent 实例窗口销毁重建后回填它自己的历史（seed
              // 由 buildRuntime 经 seedMessagesOf 派生；新建会话 = undefined）。
              ...(seed !== undefined ? { initialMessages: seed } : {}),
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
      // 恢复回填（三层模型）：实例窗口（LLM 上下文）销毁重建后，从 Entry 树按
      // mainInstanceId 过滤回填该 mainAgent 自己的 user/assistant 历史——空闲卸载/
      // 重启后的「同一实例复活」延续上下文；新建会话/阶段切换新实例无历史 = 空 seed。
      // model 元数据取当前解析模型（与 engineFor 生产分支同序同值；assistant 回填元数据源）。
      const seedModel = deps.mainSessionLlmOverride?.model() ?? resolveConfigModel(
        resourceService.modelSlot(profileKindOf(material.session.mode)) ?? defaultModel.current(),
        catalog.modelsView(),
      );
      const seed = seedMessagesOf(material.session.entryList(), material.session.mainInstanceId, {
        api: seedModel.api,
        provider: seedModel.provider,
        model: seedModel.id,
      });
      const engine = engineFor(material.session.id, material.session.mode, seed);
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
            ? { compaction: compactionSettings() }
            : {}),
          hooks: MainSessionProfile.hooks.map((H) => H.hookName),
        }),
        // 转正单点触发面：零条目草稿首个用户条目落聚合 → 注册表
        // promoteDraft（恰好一次 instantiated + 补 created；闭包仅在运行期
        // 触发——createFresh 发生在 initialize/运行期，注册表已就位）
        onFirstUserEntry: () => registry.promoteDraft(material.session.id),
        // W2-D R9/R10 主会话切片注入：复用 spawn 派发同一注入器（KgQueryService
        // .injectTaskSlice——sessionId 跨通道去重同键）；空串回退（未绑定工作
        // 空间时容器注入面回 ""）视为空命中原文透传。D8 W-R6：主会话链恒
        // main 受众（协议行 kg-update 直落措辞——与 spawn 链 worker 版分叉）。
        ...(deps.taskInjector !== undefined
          ? { taskSliceInjector: (sid: string, text: string) => deps.taskInjector!(sid, text, "main") || text }
          : {}),
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
    resolveSubagentModelId,
    toolCwdNow: toolCwdOf,
    orchestratorAssembly: () => orchestratorAssemblyValue,
  };
}
