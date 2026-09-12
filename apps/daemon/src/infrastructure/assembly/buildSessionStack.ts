import type { SessionRepositoryPort } from "../../application/ports/outbound/SessionRepositoryPort";
import type { EventPublisherPort } from "../../application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../application/ports/outbound/ClockPort";
import type { BrowserPort } from "../../application/ports/outbound/BrowserPort";
import type { ProfileKind } from "../../application/ports/outbound/ResourceStatePort";
import type { InstanceRunner } from "../../application/services/InstanceRunner";
import type { SessionRunStateLike } from "../../domain/agent/ObservabilityState";
import path from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { ChatService } from "../../application/services/ChatService";
import { SessionService } from "../../application/services/SessionService";
import { RestoreService } from "../../application/services/RestoreService";
import { SchedulerService } from "../../application/services/scheduler/SchedulerService";
import type { ClosureFindingsSink } from "../../application/services/scheduler/ClosureRecorder";
import { SessionRegistry, type SessionRuntime } from "../../application/services/SessionRegistry";
import { ResourceService } from "../../application/services/ResourceService";
import { SystemPromptAssembler } from "../../application/services/SystemPromptAssembler";
import type { TaskTypeInfo } from "../../application/ports/outbound/TaskSkillRegistryPort";
import { SchedulingPolicy } from "../../domain/agent/SchedulingPolicy";
import type { SchedulingConfigPort } from "../../application/ports/outbound/SchedulingConfigPort";
import type { SandboxConfigPort } from "../../application/ports/outbound/SandboxConfigPort";
import { EventStream } from "../../adapters/driving/ws-server/EventStream";
import { sessionPlanPayloadOf } from "../../adapters/driving/ws-server/SnapshotMapper";
import { LazyWorkLedger } from "../../adapters/driven/sqlite-session/WorkLedger";
import { WorkLedgerService } from "../../application/services/task/WorkLedgerService";
import { SubagentLauncher } from "../../adapters/driven/subagent/SubagentLauncher";
import { GitWorktreeProvisioner } from "../../adapters/driven/worktree/GitWorktreeProvisioner";
import { TurnDiffService, type TurnDiffState } from "../../application/services/TurnDiffService";
import { WriteFactRegistry } from "../../application/services/WriteFactRegistry";
import { CoordinationService } from "../../application/services/CoordinationService";
import { WriteManifestStore, manifestDir } from "../../application/services/WriteManifestStore";
import { walkWorkspaceStats } from "../../adapters/driven/workspace-stat-walk";
import { generateUnifiedPatch } from "../../adapters/driven/tools/edit/kernel/edit-diff";
import { readFile } from "node:fs/promises";
import { MAIN_SESSION_SYSTEM_PROMPT } from "../../adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { DEFAULT_COMPACTION, type CompactionSettings } from "../../adapters/driven/pi-engine/runtime/AgentProfile";
import { SubAgentProfile, SUBAGENT_SYSTEM_PROMPT } from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import {
  SUBAGENT_KG_WRITER_EXTRA_TOOLS,
  SUBAGENT_KG_WRITER_PROMPT_SUFFIX,
  SubAgentKgWriterProfile,
} from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentKgWriterProfile";
import {
  SUBAGENT_CODE_REVIEWER_PROMPT_SUFFIX,
  SUBAGENT_CODE_REVIEWER_REMOVED_TOOLS,
  SubAgentCodeReviewerProfile,
} from "../../adapters/driven/pi-engine/runtime/profiles/SubAgentCodeReviewerProfile";
import {
  OrchestratorProfile,
  ORCHESTRATOR_SYSTEM_PROMPT,
} from "../../adapters/driven/pi-engine/runtime/profiles/OrchestratorProfile";
import { isTaskSessionId, TASK_SESSION_PREFIX } from "../../application/services/task/TaskOrchestratorService";
import type { McpRegistry } from "../../adapters/driven/mcp/McpRegistry";
import { createMcpDiscoverTools, createMcpTools } from "../../adapters/driven/mcp/mcp-tool";
import { resolveConfigModel } from "../../adapters/driven/pi-engine/model-provider";
import { ModelCatalog } from "../../adapters/driven/pi-engine/model-catalog";
import { SkillScanner } from "../../adapters/driven/pi-engine/SkillScanner";
import { TOOL_PROMPT_SNIPPETS } from "../../adapters/driven/tools/ToolPromptSnippets";
import { CoreToolExecutor, type CoreToolExecutorOptions, type KgToolOptions } from "../../adapters/driven/tools/CoreToolExecutor";
import { readSandboxRuntime } from "../../adapters/driven/tools/sandboxSetup";
import type { PlanToolDeps } from "../../adapters/driven/tools/plan/PlanTools";
import type { TaskCreateToolDeps } from "../../adapters/driven/tools/task-create/TaskCreateTool";
import type { TaskReportToolDeps } from "../../adapters/driven/tools/task-report/TaskReportTool";
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
 * 引擎装配形态与主会话 LLM 覆盖类型（M5 切片迁 sessionEngineFactory——
 * 本文件 re-export 保持既有导出面：container/createTestDaemon import 路径不变）；
 * 静态工具目录与 MCP 准入白名单（M5 切片迁 mcpCatalogSurface——MCP_ALLOWED_OF
 * import 复用，SubagentLauncher mcpServersFor 门控同源）。
 */
export type { EngineAssemblyMode, MainSessionLlmOverride } from "./sessionEngineFactory";
import type { EngineAssemblyMode, MainSessionLlmOverride } from "./sessionEngineFactory";
import { buildMainEngineFactory, buildSessionRuntimeFactory } from "./sessionEngineFactory";
import { buildMcpCatalogSurface, MCP_ALLOWED_OF } from "./mcpCatalogSurface";

// ── U3 readonly 档派生面（任一 kind 生效集减三写工具 + 只读纪律后缀；
//    模块级导出供 parity 测试 import——E-98 reviewer 减法同构）──────────
/** 与 reviewer 摘除面同值（write/edit/edit-lines）；语义独立常量，不跨档耦合。 */
export const SUBAGENT_READONLY_REMOVED_TOOLS = ["write", "edit", "edit-lines"] as const;
/** 只读纪律行：诚实声明 bash 软约束（非形式化只读，事实流对账兜底）。 */
export const SUBAGENT_READONLY_PROMPT_SUFFIX =
  "【写面声明：readonly】本任务为只读任务：write/edit/edit-lines 已不可用。" +
  "不要修改任何项目文件（包括经 bash 间接写——sed -i/重定向/mv 等）；" +
  "过程产物写入 workspace 根 docs/temp/（非项目仓）。若任务确需写项目文件，" +
  "在报告中说明并结束任务，由派发方以 shared/isolated 档重派。";
/** U3 派生单点：readonly 减三写工具+后缀；其余档原样返回。 */
export function applyWriteModeToAssembly<T extends { tools: readonly string[]; systemPrompt: string }>(
  base: T,
  writeMode: string | undefined,
): T {
  if (writeMode !== "readonly") return base;
  return {
    ...base,
    tools: base.tools.filter((t) => !(SUBAGENT_READONLY_REMOVED_TOOLS as readonly string[]).includes(t)),
    systemPrompt: `${base.systemPrompt}\n\n${SUBAGENT_READONLY_PROMPT_SUFFIX}`,
  };
}
/** effectiveMainToolNames（M5 切片迁 sessionEngineFactory；re-export 保 main-session-plan 测试 import 路径）。 */
export { effectiveMainToolNames } from "./sessionEngineFactory";

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
  /** SubAgent 调度预算（可选——测试缺省回落 DEFAULT_SCHEDULING；生产恒注入，运行期可调）。 */
  readonly schedulingConfig?: SchedulingConfigPort;
  /** 沙箱开关（可选——缺省关；会话创建时读 KV，新会话生效）。 */
  readonly sandboxConfig?: SandboxConfigPort;
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
  /**
   * MCP 注册表（mcp 批）：提供则① catalog 动态拼 MCP 工具名（main/worker
   * 准入）② executor 构造注入现值工具③ refreshAssembly 对活跃会话
   * appendTools（server 到位即推）。缺省 = 无 MCP（零配置兼容形态）。
   */
  readonly mcpRegistry?: McpRegistry;
  /** 空闲卸载窗口 ms 覆盖（测试注入缩短到秒级；缺省 30min）。 */
  readonly sessionIdleUnloadMs?: number;
  /** 空闲卸载轮询间隔 ms 覆盖（测试注入面；缺省 min(60s, 窗口/10)）。 */
  readonly sessionIdlePollMs?: number;
  /** grep 后端定格注入（AF-1 启动定格产物：组合根透传；rg 单后端，缺省 = unavailable 响亮失败）。 */
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
   * task_report 工具注入面（D3）：主会话 executor 注册 task_report（chat
   * 回流通用报告查询面；仅 MainAgent 生效集——SubAgent 子进程本地栈与
   * 编排主 agent 均不注入）。组合根接任务栈查询面（TaskQueryService
   * list/detail）+ closure_records 读面 + 报告目录约定；缺省不注册
   *（测试形态——engineFor 未注入时从 main 工具集剔除，taskCreate 同构）。
   */
  readonly taskReport?: TaskReportToolDeps;
  /**
   * 可用任务类型清单读面（audience 分类注入，批二）：MainAgent 提示的
   * 「可用任务类型」段数据源（TaskSkillRegistry.listTaskTypes 同源）——
   * 任务类型 SOP 不进技能清单，MainAgent 经 task_create 发起。仅
   * main-session 组装消费；缺省 = 无任务类型段（测试形态）。
   */
  readonly taskTypesOf?: () => readonly TaskTypeInfo[];
  /**
   * 项目常驻规则段数据源（global 声明节点触发面，组合根接
   * KgQueryService.residentRulesSection）：U7 去全扫化——纯查询面
   *（足迹项目集 → 段或 null）；足迹求值在栈内（writeFacts 可达——
   * deps 是栈入参拿不到栈内产物，故签名不带 sessionId）。空足迹 →
   * null（不注入：感知不到项目时不注错误项目规则）；段在会话级应用
   * 点尾拼（main 三接触点/subagentAssemblyFor 尾参）。缺省不注入
   *（测试形态）。
   */
  readonly residentRulesOf?: (projectRoots: readonly string[]) => string | null;
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
   * 主会话 plan 三工具装配面（main-session plan 批）：提供则每会话 executor
   * 注册 plan 三工具（instanceId = sessionId 作用域——主会话台账跨重启
   * 稳定，不与 agent-N 实例撞名）；台账写面 = 父进程 LazyWorkLedger 直连
   *（dbPath 缺省 paths.dbPath()；同库 WAL + busy_timeout 跨进程安全）；
   * 执行成功后装配层广播 session.plan.changed（观察面即问责面）。缺省不
   * 注册（engineFor 从 main 工具集剔除三名——隔离测试形态）。
   */
  readonly mainPlan?: { readonly dbPath?: string };
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
  /** U7：写事实登记表读面（会话足迹求值源；U4 占用协调同源消费）。 */
  readonly writeFacts: WriteFactRegistry;
  /** U4：占用协调服务（租约表 + undeclared 检出 + 轮末机械对账；wireEventFanout coord-bridge 消费）。 */
  readonly coordination: CoordinationService;
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
   * T3 diff.get 查询面：热会话 diff 状态读面（registry peek）+ TurnDiffService
   * 查询操作面（live 即时终读 / frozen 环形视图）。WS diff.get 命令回口
   * （buildDrivingAdapters 透传；未装配 → command.unimplemented）。
   */
  readonly diff: {
    readonly stateOf: (sessionId: string) => TurnDiffState | undefined;
    readonly service: TurnDiffService;
  };
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
  /**
   * 编排会话 MCP 工具工厂（编排 MCP 接入批）：每编排会话构造时现拍——
   * 与主会话 executor 构造点同法（具体工具 + deferred meta 工具，kind
   * 绑定 "orchestrator"：isToolEnabled 读编排 kind 启停 + onDiscover
   * 物化集按编排 kind 登记）。mcpRegistry 缺席 → undefined（编排 executor
   * 不注入 mcp 面；catalog 门控同源——装配清单此时也不含 MCP 名）。
   * 类型经 CoreToolExecutorOptions 推导（AG-04：pi 类型不进 infrastructure）。
   */
  readonly orchestratorMcpTools: () => NonNullable<CoreToolExecutorOptions["mcp"]>["tools"] | undefined;
}

/**
 * main 工具集装配过滤已随 M5 切片迁 sessionEngineFactory（上方 re-export
 * 保持导出面）；engineFor/buildRuntime/MCP catalog 闭包群同批抽出——本函数
 * 保留装配序编排与五 kind 快照缓存（装配序语义不变，零行为改动）。
 */
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
  // ── T2 turn diff：轮次级内存态 diff 操作面（多会话共用单例——状态在
  //    各 SessionRuntime.diff，服务只持注入件；全内存零持久化）。
  //    IO 绑定：读文本 = node:fs/promises（缺文件→null）、walk =
  //    walkWorkspaceStats（忽略重目录段）、patch = VENDORED
  //    generateUnifiedPatch（AG-02②：application 不 import driven，绑定在此）。──
  // T3 推送回调：state → 归属会话反查（WeakMap——服务方法零 sessionId 参数，
  // T2 形态保持）→ fan-out publishDelta 瞬态通道（channel="diff"：不落盘、
  // 不投影、EventStream 直推——chat/thinking stream delta 同通道纪律）。
  const diffSessionIds = new WeakMap<TurnDiffState, string>();
  // ── U0a 写事实登记表（跨轮跨会话底座——daemon 内存单例，liveness 语义：
  //    重启清零零落盘；workspaceRoot 同 toolCwdOf 口径供 projectFootprint）。
  //    U1 护栏：observer 并联 manifest 落盘（去抖 250ms 原子写
  //    <home>/write-facts/<sid>.json——pre-commit hook 跨进程读面）──
  const manifestStore = new WriteManifestStore({
    manifestRoot: () => manifestDir(paths.home),
    fs: {
      mkdir: async (dir) => {
        await mkdir(dir, { recursive: true });
      },
      writeFile: async (p, body) => {
        await writeFile(p, body, "utf8");
      },
      rename: async (from, to) => {
        await rename(from, to);
      },
      readFile: (p) => readFile(p, "utf8"),
      readdir: (dir) => readdir(dir),
      remove: (p) => rm(p, { force: true }),
    },
  });
  const writeFacts = new WriteFactRegistry({
    workspaceRoot: () => toolCwdOf(),
    observer: {
      onSessionPaths: (sid, paths_) => manifestStore.notify(sid, paths_),
      onSessionDrop: (sid) => {
        void manifestStore.drop(sid);
      },
    },
    // U4：逐事实观察者（undeclared 检出 + 活跃刷新；晚绑 ref——coordination
    // 在 writeFacts 之后构造，构造窗口零回调）
    factObserver: (fact) => coordinationRef?.onWriteFact(fact),
  });
  // ── U4 占用协调服务（daemon 全局单例：租约表 + undeclared 检出 + 轮末
  //    机械对账；plan 读面晚绑——mainPlan 服务在本块之后构造回填） ──
  const coordination = new CoordinationService({
    publish: (e) => events.publish(e),
    writeFacts,
    planReaderFor: () => planReaderRef,
    workspaceRoot: () => toolCwdOf(),
    now: () => Date.parse(clock.now()),
    // U6：冲突占用者 steer 注入（晚绑 ref——SessionRegistry 在本块之后构造，
    // L989；注入失败静默（stopped 会话可观测丢弃已是 injectClosure 语义））
    notifyOwner: (sid, text) => {
      registryRef?.peek(sid)?.chatService.injectClosure(text, "coord");
    },
  });
  const coordinationRef = coordination;
  let registryRef: SessionRegistry | undefined;
  let planReaderRef: import("../../application/services/task/WorkLedgerService").WorkLedgerService | undefined;
  const turnDiff = new TurnDiffService(
    {
      readTextFile: (p) =>
        readFile(p, "utf8").catch(() => null),
      walkStats: (root) => walkWorkspaceStats(root),
      workspaceRoot: () => toolCwdOf(),
      computePatch: (p, oldContent, newContent) => generateUnifiedPatch(p, oldContent, newContent),
      absoluteOf: (p) => (path.isAbsolute(p) ? p : path.join(toolCwdOf(), p)),
    },
    {
      onDiffChanged: (state, change) => {
        const sessionId = diffSessionIds.get(state);
        if (sessionId === undefined) return;
        events.publishDelta({ messageId: "", delta: "", channel: "diff", sessionId, diff: change });
      },
    },
  );
  const skillScanner = new SkillScanner({
    userSkillsDir: paths.skillsHome(),
    builtinSkillsDir: deps.builtinSkillsDir ?? builtinSkillsDir(),
    cwd: bootToolCwd,
  });
  // ── MCP catalog 闭包群（M5 切片，assembly/mcpCatalogSurface）：静态目录 +
  //    准入白名单 + 四 catalog 闭包 + deferred 物化集/discover 回调（含 publish
  //    catch 兑底——M5 修复）。ResourceService/registry 为构造环对端（catalog
  //    闭包进 ResourceService deps，onMcpDiscover 运行期才回读两者）——晚绑
  //    getter 闭包保原装配序语义。──
  const mcpSurface = buildMcpCatalogSurface({
    mcpRegistry: deps.mcpRegistry,
    effectiveToolsOf: (kind) => resourceService.getEffectiveTools(kind),
    hotRuntimes: () => registry.hotRuntimes(),
    publishResourceChanged: (kind) => deps.publishResourceChanged(kind),
  });
  const resourceService = new ResourceService({
    store: resourceState,
    skills: skillScanner,
    // mcp 批：catalog 函数化（M5 切片迁 mcpCatalogSurface）——静态 profile
    // 声明面 + MCP 命名空间工具名动态拼接 + 准入门控/物化集语义全部不变。
    toolsCatalog: mcpSurface.toolsCatalog,
    effectiveToolsCatalog: mcpSurface.effectiveToolsCatalog,
    // list 读面 snippet 透传（SystemPromptAssembler 同源注册表单点）
    toolSnippets: TOOL_PROMPT_SNIPPETS,
    // server 级配置面批两闭包（M5 切片迁 mcpCatalogSurface，语义不变）：
    // MCP 工具行 snippet = registry description 透传；server 运行态行 =
    // registry 现拍 + MCP_ALLOWED_OF 白名单门控。
    toolSnippetOf: mcpSurface.toolSnippetOf,
    mcpServersOf: mcpSurface.mcpServersOf,
    // 生效链（事件化，架构 §4.2.3）：toggle applied → 发布
    // resources.changed（装配级总线）→ 容器订阅侧 refreshAssembly 重算该
    // kind 组装快照 + 刷新活跃 runtime（main 直改 systemPrompt/tools；
    // subagent 只更新快照缓存，spawn 时刻消费）——发布/订阅方向倒转，
    // 结构保证取代注释保证。
    publishResourceChanged: (kind) => deps.publishResourceChanged(kind),
  });

  // ── builtin 技能差异行播种（TR-124：五 kind 全播）──
  // builtin 默认开是全局缺省（与 user 源显式启用制分野）；运行时零特判
  // 不变：缺行才播 enabled=true、用户关过的行不覆盖、版本升级新增 builtin
  // 重启自动补播——开箱即用与显式启用制两全。
  await resourceService.seedBuiltinSkillDefaults([
    "main-session",
    "subagent-worker",
    "orchestrator",
    "subagent-kg-writer",
    "subagent-code-reviewer",
  ]);

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
  // 技能段五 kind 同构注入（终态：orchestrator 亦无豁免——SOP 只是使用层
  // 要求它读技能清单，装配层照常注入自身生效集；omitSkills 机制已退役）。
  const computeAssembly = async (
    kind: ProfileKind,
  ): Promise<{ readonly tools: readonly string[]; readonly systemPrompt: string }> => {
    const tools = resourceService.getEffectiveTools(kind);
    const skills = await resourceService.getEffectiveSkills(kind);
    return {
      tools,
      systemPrompt: promptAssembler.assemble({
        basePrompt: assemblyBase(kind),
        toolNames: tools,
        skills,
        // U7：常驻规则段退场栈级快照——会话级应用点拼接（main 三接触点
        // /subagentAssemblyFor 尾参），按 sessionId 足迹注入；后台型 kind
        //（kg-writer/reviewer/orchestrator）栈级无会话上下文不注入（触发面
        // 意义弱，观察项）。任务类型段仍栈级（main-session 全局事实）。
        ...(kind === "main-session" && deps.taskTypesOf !== undefined
          ? { taskTypes: deps.taskTypesOf() }
          : {}),
      }),
    };
  };
  // U7 会话级常驻规则段拼接（应用时刻取足迹现值——栈内 writeFacts
  // 可达）：main 三接触点（engineFor 装配经 ctx.residentRulesFor、
  // instantiatedSnapshot 同、toggle 推送）与 subagentAssemblyFor 尾参共用。
  const residentSectionFor = (sessionId: string): string | null =>
    deps.residentRulesOf === undefined
      ? null
      : deps.residentRulesOf(writeFacts.projectFootprint(sessionId));
  const withResidentRules = (prompt: string, sessionId: string): string => {
    const section = residentSectionFor(sessionId);
    return section === null ? prompt : `${prompt}\n\n${section}`;
  };
  let mainAssembly = await computeAssembly("main-session");
  let subagentAssembly = await computeAssembly("subagent-worker");
  // D8 W-R6：kg-writer 组装快照 = 自身 kind 独立装配（声明面单源
  // SubAgentKgWriterProfile——全集已含 kg 工具；生效集受自身差异行管控）
  // + 评审纪律后缀。toggle 刷新自身重算（独立配置，不随 worker 联动）。
  const computeKgWriterAssembly = async (): Promise<{
    readonly tools: readonly string[];
    readonly systemPrompt: string;
  }> => {
    const own = await computeAssembly("subagent-kg-writer");
    return { tools: own.tools, systemPrompt: `${own.systemPrompt}\n\n${SUBAGENT_KG_WRITER_PROMPT_SUFFIX}` };
  };
  let kgWriterAssembly = await computeKgWriterAssembly();
  // D5：reviewer 组装快照 = 自身 kind 独立装配（声明面单源
  // SubAgentCodeReviewerProfile——全集已减 write/edit）+ 评审纪律后缀；
  // toggle 刷新自身重算（独立配置，不随 worker 联动）。
  const computeReviewerAssembly = async (): Promise<{
    readonly tools: readonly string[];
    readonly systemPrompt: string;
  }> => {
    const own = await computeAssembly("subagent-code-reviewer");
    return { tools: own.tools, systemPrompt: `${own.systemPrompt}\n\n${SUBAGENT_CODE_REVIEWER_PROMPT_SUFFIX}` };
  };
  let reviewerAssembly = await computeReviewerAssembly();
  /** 批次实例组装快照按 profileKind 派发（W-R6 编排分流的装配端消费点；D5 扩第三支——其余缺省归 chat worker 快照）。 */
  const subagentAssemblyFor = (
    profileKind: string | undefined,
    writeMode?: string,
    sessionId?: string,
  ): typeof subagentAssembly => {
    const base =
      profileKind === "subagent-kg-writer"
        ? kgWriterAssembly
        : profileKind === "subagent-code-reviewer"
          ? reviewerAssembly
          : subagentAssembly;
    // U3：readonly 档任一 kind 生效集减三写工具+只读纪律后缀（派生单点在
    // 模块级 applyWriteModeToAssembly——减法幂等，reviewer 已无写工具再减无害）
    const applied = applyWriteModeToAssembly(base, writeMode);
    // U7：spawn 快照尾拼会话足迹常驻段（sessionId = 派发会话——与
    // HELIX_SESSION_ID 同口径；兜底快照无实例上下文不拼）。子进程经 env
    // 定格自动继承。
    return sessionId === undefined
      ? applied
      : { ...applied, systemPrompt: withResidentRules(applied.systemPrompt, sessionId) };
  };
  let orchestratorAssemblyValue = await computeAssembly("orchestrator"); // T2.2：编排会话工厂消费（快照缓存，启动/toggle 重算；技能段照常注入自身生效集）
  // mcp 批：活跃主会话 executor 登记（engineFor 构造点 set；refreshAssembly
  // 对活跃会话 appendTools 后再 setTools——MCP 新工具实例进 registry 才能被
  // 按名 resolve）。生命周期见 set 点注释。
  const sessionExecutors = new Map<string, InstanceType<typeof CoreToolExecutor>>();
  /** toggle applied 后的重算入口（WS 命令复用面：命令只调 toggle，刷新单点在此）。 */
  const refreshAssembly = async (kind: ProfileKind): Promise<void> => {
    // 五 kind 同构刷新（独立配置终态：各自 toggle 各自重算，派生联动撤除——
    // kg-writer/reviewer 工具/技能面不再随 worker 联动）。前三分支消费
    // computeAssembly 产物；kg-writer/reviewer 走各自带后缀的独立快照函数
    //（内部重跑 computeAssembly——不预拍 next 白跑一遍）。
    if (kind === "main-session") {
      const next = await computeAssembly(kind);
      mainAssembly = next;
      // 活跃 runtime 直改（setModel 同构）：systemPrompt 重算 + tools 重 resolve，
      // 下一 turn 生效（in-flight 不变）。model 槽位不在此链（读面生效，见 engineFor）。
      // mcp 批：MCP 工具实例先 append 进活跃会话 executor registry（同名覆盖
      // = server 工具更新后新 schema 生效），再按名 setTools。
      if (deps.mcpRegistry !== undefined) {
        // mcp 批：具体工具 + deferred 批 meta 工具同批 append（meta 每次
        // 现拍——server 增删/撞名变化跟随；物化链闭包同 executor 构造点）。
        const mcpTools = [
          ...createMcpTools(deps.mcpRegistry.discoveredTools(), deps.mcpRegistry),
          ...createMcpDiscoverTools(deps.mcpRegistry, {
            isToolEnabled: (name) => resourceService.isToolEnabled("main-session", name),
            onDiscover: (server, names) => mcpSurface.onMcpDiscover("main-session", server, names),
          }).tools,
        ];
        const live = new Set(registry.hotRuntimes().map((r) => r.sessionId));
        for (const [id, executor] of sessionExecutors) {
          if (!live.has(id)) {
            sessionExecutors.delete(id); // 顺带清死项（卸载/删除会话残留）
            continue;
          }
          executor.appendTools(mcpTools);
        }
      }
      for (const runtime of registry.hotRuntimes()) {
        // U7：toggle 重算推送也过会话级拼接（足迹段不被栈级重算冲掉）
        runtime.chatService.setSystemPrompt(withResidentRules(next.systemPrompt, runtime.sessionId));
        runtime.chatService.setTools(next.tools);
      }
    } else if (kind === "subagent-worker") {
      subagentAssembly = await computeAssembly(kind); // 已 spawn 实例 env 已定格（代际生效，零刷新）
    } else if (kind === "subagent-kg-writer") {
      kgWriterAssembly = await computeKgWriterAssembly(); // 独立快照重算（已 spawn env 定格，代际生效）
    } else if (kind === "subagent-code-reviewer") {
      reviewerAssembly = await computeReviewerAssembly(); // 独立快照重算（同上）
    } else {
      orchestratorAssemblyValue = await computeAssembly(kind); // 编排会话短生命周期：下一会话生效（零活跃刷新）
    }
  };

  // ── SubAgent profile 三叉单点助手（M31：kg-writer/code-reviewer/worker
  //    三叉 + thinking 链 + 槽位 kind 归一的逐字重复消重）──────────────
  // TR-42 per-kind 语义不变：kg-writer/reviewer 读自身槽位（不联动 worker），
  // 两级链 = profile 静态声明 ?? 本 kind 槽位 ?? 全局兜底。
  /** SubAgent profile 静态声明三叉（W-R6/D5：kg-writer / code-reviewer / 缺省 worker）。 */
  const subagentProfileFor = (profileKind: string | undefined) =>
    profileKind === "subagent-kg-writer"
      ? SubAgentKgWriterProfile
      : profileKind === "subagent-code-reviewer"
        ? SubAgentCodeReviewerProfile
        : SubAgentProfile;
  /** 槽位 kind 归一（R7 per-kind + D5 第三支：kg-writer/reviewer 读自身槽位；其余/缺省 → subagent-worker）。 */
  const slotKindOf = (profileKind: string | undefined): ProfileKind =>
    profileKind === "subagent-kg-writer" || profileKind === "subagent-code-reviewer"
      ? (profileKind as ProfileKind)
      : "subagent-worker";
  /** thinking 两级链单点（TR-42：profile 静态声明 ?? 本 kind 槽位 ?? 全局兜底——per-kind 零联动）。 */
  const thinkingChainOf = (profileKind: string | undefined): string | undefined =>
    subagentProfileFor(profileKind).thinkingLevel ?? resourceService.thinkingSlot(slotKindOf(profileKind)) ?? globalThinking();

  // ── SubAgent 模型两级链解析单点（id 形态，AD-3/T12）──────────────────
  // profile.model 静态声明 ?? subagent-worker kind 槽位 ?? 全局兜底——spawn
  // 透传（AgentInstanceDto.model 填充链）与 instantiated 快照供给同源同点；
  // launcher launch 实际用模同序（id → Model 对象解析在 launcher，AD-3 联动）。
  // T12 砍 spawn 会话快照级：SubAgent 只认自身 profile，不继承 main session 选择。
  const resolveSubagentModelId = (profileKind?: string): string =>
    // R7 per-kind + D5 第三支：kg-writer/reviewer 自身槽位（不联动 worker）；profile 静态声明优先
    subagentProfileFor(profileKind).model ?? resourceService.modelSlot(slotKindOf(profileKind)) ?? defaultModel.current();

  // ── driven：SubAgent 子进程运行器（SubagentLauncher 真体，O-7 候选 A）──
  // U3 晚绑前置：worktree 供给真体（无状态可直接构造）+ scheduler 回填
  // ref（scheduler 晚于 launcher 构造——onWorktreeProvisioned 闭包读现值）
  const worktreeProvisionerSingleton = new GitWorktreeProvisioner();
  let schedulerWorktreeRef: SchedulerService | undefined;
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
          // M31：三叉 + thinking 链收敛 subagentProfileFor/thinkingChainOf 单点（语义不变）
          profile: (profileKind: string) => ({
            ...subagentProfileFor(profileKind),
            thinkingLevel: thinkingChainOf(profileKind),
          }),
          // 可观测 logger（dispose kill 失败 warn；缺省静默）
          logger,
          // 两级链末级（AD-3/T12）：全局兜底现值解析（set_default 后新子进程跟随）
          model: () => resolveConfigModel(defaultModel.current(), catalog.modelsView()),
          // profile.model 槽位解析目录（AD-3 第一级声明时启用；生产未声明）
          models: catalog.modelsView(),
          // 模型槽位（profile 槽位 UI 化）：resource_state kind 槽位现值
          // （launch 时刻读取定格；未设 → 全局兜底）
          uiModelSlot: (profileKind: string) => {
            // R7 per-kind + D5 第三支：kg-writer/reviewer 读自身槽位（不联动 worker）
            const slot = resourceService.modelSlot(slotKindOf(profileKind));
            return slot === undefined ? undefined : resolveConfigModel(slot, catalog.modelsView());
          },
          // spawn 快照：组装产物缓存（启动/toggle 后重算，launch 读现值定格）。
          // W-R6：按实例 profileKind 派发——subagent-kg-writer（图谱产出型批次）
          // 领 worker 生效集 + kg-write 面；其余（缺省）领通用 worker 快照。
          // U3：writeMode=readonly 时快照减三写工具+纪律后缀（任一 kind 均可）。
          // U7：sessionId 第三参（spawn 快照尾拼派发会话足迹常驻段——与
          // HELIX_SESSION_ID 同口径）
          spawnSnapshot: (profileKind: string, writeMode?: string, sessionId?: string) =>
            subagentAssemblyFor(profileKind, writeMode, sessionId),
          // U3 isolated 档：worktree 供给真体（git 适配——TR-143 软链四处/
          // TR-82 锁残留坑机械内化）。provision 成功回登记调度器（晚绑
          // ref——scheduler 晚于 launcher 构造，U2 同款回填形态）
          worktreeProvisioner: worktreeProvisionerSingleton,
          onWorktreeProvisioned: (instanceId: string, info: { path: string; branch: string }) =>
            schedulerWorktreeRef?.registerWorktree(instanceId, info),
          // mcp 批：MCP server 配置透传（launch 时刻现拍；kind 白名单门控同
          // catalog——kg-writer/reviewer 静态 kind 不接 MCP；零 enabled
          // server → 不传键零开销。子进程自建 registry await 预热后构造
          // executor，保证 spawn 快照工具名与子进程注册表一致）
          mcpServersFor: (profileKind: string) => {
            const registry = deps.mcpRegistry;
            if (registry === undefined) return undefined;
            const allowed = MCP_ALLOWED_OF[profileKind as ProfileKind];
            if (allowed === undefined) return undefined;
            // server 级配置面批：per-kind server 差异行门控——关闭的 server
            // 不进 env 透传（子进程零感知零连接；与主进程 getEffectiveTools
            // 的前缀合取同源同效）
            return registry
              .listConfigs()
              .filter((c) => c.enabled !== false)
              .filter((c) => allowed === "*" || allowed.includes(c.name))
              .filter((c) => resourceState.get(profileKind as ProfileKind, "mcp-server", c.name)?.enabled !== false);
          },
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
          // 沙箱开关批：spawn 时读 KV 现值（persistence 注入）→ HELIX_SANDBOX
          // env 透传子进程；未装配（测试栈）不传键 = 子进程沙箱关
          ...(deps.sandboxConfig !== undefined ? { sandboxConfig: deps.sandboxConfig } : {}),
          // U1 护栏：manifest 根透传（会话标识取 launch 时刻 instance.sessionId）
          writeFactsManifestDir: manifestDir(paths.home),
          // F3.0（T4.1）：报告落点经 env IPC 面传参（HELIX_REPORT_PATH）——
          // 与 ClosureRecorder 兜底 reportsDirFor 同源同式（<home>/reports/<session>）
          reportDirFor: (sessionId) => path.join(paths.home, "reports", sessionId),
          // H-3：tool-req 转发目标 = 全局唯一 CDP 单例（ScopedBrowserProxy
          // 归属校验：ownerId 强制 = 通道 instanceId）
          browser: browserPort,
          // T2 turn diff：子进程 file-write 元数据行 → 归属会话热 runtime 的
          // diff 记账（recordExternal——agents 集合累积 SubAgent 实例）。
          // 会话反向查找同 injectClosure 先例（scheduler.instance →
          // registry.peek；冷会话/无归属丢弃——轮外写不归属）。
          onFileWrite: (agentId, meta) => {
            const sessionId = scheduler.instance(agentId)?.sessionId;
            if (sessionId === undefined) return;
            // U0a 并联：工具写事实登记（跨轮持久——diff 记账之外的第二消费者）
            writeFacts.record({ instanceId: agentId, sessionId, path: meta.path, at: Date.now(), confidence: "precise" });
            const hot = registry.peek(sessionId);
            if (hot !== undefined) turnDiff.recordExternal(hot.diff, { ...meta, agentId });
          },
          // U0b：bash-fact 行分派（子进程内算毕的快照差集）→ registry 记账。
          // 会话反查同 onFileWrite；差 diff 出口留位（见 SubagentLauncher 注释）。
          onBashFact: (agentId, facts) => {
            const sessionId = scheduler.instance(agentId)?.sessionId;
            if (sessionId === undefined) return;
            writeFacts.recordMany(
              facts.map((f) => ({ instanceId: agentId, sessionId, path: f.path, at: f.at, confidence: f.confidence })),
            );
          },
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
  // U2 观测态晚绑：scheduler 先于 SessionRegistry 构造——先落冷会话 idle
  // 兑底，registry 建成后回填真读口（main 实例 displayState 编译输入）
  let sessionRunStateOfImpl: (sessionId: string) => SessionRunStateLike = () => "idle";
  const scheduler = new SchedulerService({
    // U2：main 实例 agent_status displayState 编译读口（晚绑闭包）
    sessionRunStateOf: (sessionId) => sessionRunStateOfImpl(sessionId),
    // U4 占用协调：subagent 终态摘执行者 + worktree 登记 isolated 租约
    onSubagentSettled: (executorId) => coordination.onSubagentSettled(executorId),
    onWorktreeClaim: (input) => coordination.onWorktree(input),
    // 调度策略工厂：每次预算判定现拍 KV 现值（设置页 set 完成后下一次
    // decideSpawn 即生效——运行期可调，无需重启）；stalled 阈值仍走 domain 缺省；
    // 未注入 store（测试形态）→ SchedulingPolicy 构造缺省回落 DEFAULT_SCHEDULING
    policy: () => {
      const budget = deps.schedulingConfig?.current();
      return new SchedulingPolicy(budget !== undefined ? { ...budget } : {});
    },
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
    subagentSnapshotFor: (profileKind?: string, sessionId?: string) => ({
      // 快照供给改读组装缓存（消观测漂移——与 launch 实际注入同源
      // 同时点；W-R6：按实例 profileKind 派发 kg-writer/worker 快照）；model
      // 链与 launcher resolveModelFor 同序：profile 槽位 ?? kind 槽位（uiModelSlot）?? 全局兑底
      // R7 per-kind + 全局兜底：与 launcher resolveThinkingFor/resolveModelFor 同源同时点（AD-4④）
      // M31：thinking 链收敛 thinkingChainOf 单点（语义不变）
      // U7：sessionId 尾参——instantiated 快照与会话足迹常驻段同源（spawn
      // 时刻求值，与 HELIX_SYSTEM_PROMPT 同段）
      thinkingLevel: thinkingChainOf(profileKind),
      profileSnapshot: {
        systemPrompt: subagentAssemblyFor(profileKind, undefined, sessionId).systemPrompt,
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
  // U3 回填：isolated worktree 登记真体（launcher 闭包晚绑——scheduler 已建成）
  schedulerWorktreeRef = scheduler;

  // ── driving：WS 事件流（EventPublisherPort 实现，fan-out 目标之一——
  // WS 推送显式消费者：统一信封章印 + 按 sessionId 路由， AD-3） ──
  const eventStream = new EventStream({
    // 契约 v0.3 §1：agent.spawned 帧锚点 enrichment（调度器内存携带面值）
    spawnAnchorFor: (instanceId) => scheduler.spawnAnchorOf(instanceId),
    // T10a kind 判别读面（typed 回填面闭合前 undefined = legacy 判别兜底）
    mainInstanceIdFor: (sessionId) => backfill.mainInstanceIdFor?.(sessionId),
  });

  // ── 主会话 plan 栈（main-session plan 批）：父进程写面 LazyWorkLedger
  // 直连 helix.db（同库 WAL + busy_timeout 跨进程安全；惰性开库——零 plan
  // 调用零文件触碰）；写后广播包装 = 发布点在装配层（不入 WorkLedgerService）。
  // instanceId 维度 = sessionId（engineFor 每会话注入 deps.plan.instanceId）。──
  const mainPlanStack =
    deps.mainPlan === undefined
      ? undefined
      : (() => {
          const ledger = new LazyWorkLedger(deps.mainPlan?.dbPath ?? paths.dbPath());
          const service = new WorkLedgerService({ reader: ledger, writer: ledger });
          /** 成功后广播（失败路径不发布：写面抛错即工具 error 结果，无事件）。 */
          const publish = (instanceId: string): void => {
            eventStream.broadcastPlanChanged(sessionPlanPayloadOf(instanceId, service.getPlan(instanceId)));
          };
          /** 包装面：plan 三工具执行成功后发布 session.plan.changed（三工具
           *  全量发布——plan_read 成功也发一帧幂等快照，观察面即问责面）。 */
          const planToolService: PlanToolDeps["service"] = {
            createPlan: async (instanceId, items) => {
              const r = await service.createPlan(instanceId, items);
              publish(instanceId);
              return r;
            },
            updateItem: async (instanceId, seq, status, note) => {
              await service.updateItem(instanceId, seq, status, note);
              publish(instanceId);
            },
            getPlan: (instanceId) => {
              const rows = service.getPlan(instanceId);
              publish(instanceId);
              return rows;
            },
            forceResolveInProgress: async (instanceId, note) => {
              const r = await service.forceResolveInProgress(instanceId, note);
              publish(instanceId);
              return r;
            },
          };
          return { ledger, planToolService, service };
        })();
        // U4：轮末对账 plan 读面晚绑回填（main plan 键 = sessionId）
        planReaderRef = mainPlanStack?.service;

  // ── service：多会话容器（AD-4 主承载） ─────────────────────
  // 会话绑定引擎工厂（M5 切片，assembly/sessionEngineFactory——语义注释随
  // 切片迁移）：测试 override / 生产真引擎两形态不变；mainAssembly 经 getter
  // 读现值（refreshAssembly 重算 let 缓存——与原闭包直读变量同语义）。
  const engineFor = buildMainEngineFactory({
    engineMode,
    scheduler,
    resolveSubagentModelId: () => resolveSubagentModelId(),
    resourceService,
    mainAssemblyOf: () => mainAssembly,
    // U7 委派（engineFor/buildRuntime 两接触点尾拼会话足迹常驻段）
    residentRulesFor: residentSectionFor,
    compactionSettings,
    globalThinking,
    toolCwdOf,
    turnDiff,
    writeFacts,
    writeFactsManifestDir: () => manifestDir(paths.home),
    browserPort,
    sessionExecutors,
    planToolService: mainPlanStack?.planToolService,
    coordination,
    catalog,
    authStore,
    defaultModel,
    onMcpDiscover: mcpSurface.onMcpDiscover,
    // 沙箱（可选开启，KV sandbox_config + 自检降级；off/失败 → undefined 纯透传。
    // 开关在会话创建时定格读取——设置页改开关对新会话生效，运行中不热切换）
    sandboxOf: () => readSandboxRuntime(deps.sandboxConfig?.current().enabled ?? false, paths.home, toolCwdOf()),
    ...(deps.editDeps !== undefined ? { editDeps: deps.editDeps } : {}),
    ...(deps.kgTools !== undefined ? { kgTools: deps.kgTools } : {}),
    ...(deps.codegraphTool !== undefined ? { codegraphTool: deps.codegraphTool } : {}),
    ...(deps.taskCreate !== undefined ? { taskCreate: deps.taskCreate } : {}),
    ...(deps.taskReport !== undefined ? { taskReport: deps.taskReport } : {}),
    ...(deps.grep !== undefined ? { grep: deps.grep } : {}),
    ...(deps.mcpRegistry !== undefined ? { mcpRegistry: deps.mcpRegistry } : {}),
    ...(deps.mainSessionLlmOverride !== undefined ? { mainSessionLlmOverride: deps.mainSessionLlmOverride } : {}),
  });

  // U2 观测态晚绑回填：registry 建成——scheduler 的 sessionRunStateOf
  const registry = new SessionRegistry({
    repository,
    clock,
    scheduler,
    // U1 护栏：会话卸载统一回调——写事实与 manifest 同步清理（三点：
    // unloadIdle/unloadAll/deleteSession）
    onSessionUnload: (sid) => {
      writeFacts.dropSession(sid);
      // U4：会话卸载 → 租约全释放（占用与写事实同生命周期清理）
      coordination.onSessionGone(sid);
    },
    restore: (sessionId) => restoreService.restore(sessionId),
    // 会话运行时工厂（组合根唯一 new 面；M5 切片迁 assembly/sessionEngineFactory
    // ——Session + ChatService 族 + 投影绑定语义注释随切片迁移，行为不变）：
    // promoteDraft 晚绑闭包（registry 自引用，运行期才触发）与原 inline 同语义。
    buildRuntime: buildSessionRuntimeFactory({
      repository,
      clock,
      events,
      scheduler,
      resourceService,
      defaultModel,
      catalog,
      engineFor,
      diffSessionIds,
      turnDiff,
      mainAssemblyOf: () => mainAssembly,
      coordination,
      // U7 委派（instantiatedSnapshot 接触点）
      residentRulesFor: residentSectionFor,
      compactionSettings,
      hasMainPlan: mainPlanStack !== undefined,
      promoteDraft: (sessionId) => registry.promoteDraft(sessionId),
      ...(deps.kgTools !== undefined ? { kgTools: deps.kgTools } : {}),
      ...(deps.codegraphTool !== undefined ? { codegraphTool: deps.codegraphTool } : {}),
      ...(deps.taskCreate !== undefined ? { taskCreate: deps.taskCreate } : {}),
      ...(deps.taskReport !== undefined ? { taskReport: deps.taskReport } : {}),
      ...(deps.taskInjector !== undefined ? { taskInjector: deps.taskInjector } : {}),
      ...(deps.mainSessionLlmOverride !== undefined ? { mainSessionLlmOverride: deps.mainSessionLlmOverride } : {}),
    }),
    onListChanged: (change) => eventStream.broadcastListChanged(change),
    // 主会话工作台账读面（main-session plan 批）：快照组装附 plan 全行
    //（未接 plan 栈 = 缺省不携带——旧装配兼容）
    ...(mainPlanStack !== undefined
      ? { mainPlanOf: (sessionId: string) => mainPlanStack.ledger.getItems(sessionId) }
      : {}),
    idleUnloadMs: deps.sessionIdleUnloadMs,
    idlePollMs: deps.sessionIdlePollMs,
    logger,
  });

  // U2 观测态晚绑回填：registry 建成——scheduler 的 sessionRunStateOf
  // 闭包从冷会话兑底切真读口（main 实例 displayState 实时化）
  sessionRunStateOfImpl = (sessionId) => registry.sessionRunStateOf(sessionId);
  // U6 占用协调晚绑回填：registry 建成——冲突占用者 steer 注入读口
  registryRef = registry;

  // ── services：会话状态入口（当前会话读面，经注册表组装） ──────────
  const sessionService = new SessionService({
    getView: () => registry.currentView(),
    getAgentState: () => registry.currentRuntime().chatService.agentState,
  });

  return {
    resourceService,
    writeFacts,
    coordination,
    subagentLauncher,
    scheduler,
    eventStream,
    registry,
    sessionService,
    refreshAssembly,
    resolveSubagentModelId,
    toolCwdNow: toolCwdOf,
    orchestratorAssembly: () => orchestratorAssemblyValue,
    // 编排 MCP 接入批：编排会话工厂 executor 注入面（每会话构造现拍——
    // 与主会话 executor 构造点同法；registry 缺席 → undefined 不注入）
    orchestratorMcpTools: () => {
      const mcpReg = deps.mcpRegistry;
      if (mcpReg === undefined) return undefined;
      return [
        ...createMcpTools(mcpReg.discoveredTools(), mcpReg),
        ...createMcpDiscoverTools(mcpReg, {
          isToolEnabled: (name) => resourceService.isToolEnabled("orchestrator", name),
          onDiscover: (server, names) => mcpSurface.onMcpDiscover("orchestrator", server, names),
        }).tools,
      ];
    },
    // T3 diff.get 查询面（热会话读面 + 服务查询操作面）
    diff: {
      stateOf: (sessionId: string) => registry.peek(sessionId)?.diff,
      service: turnDiff,
    },
  };
}
