/**
 * 装配函数 ③ 的会话引擎/运行时工厂域（code-review M5 切片，自
 * buildSessionStack 抽出——组合根 AG-02④ 豁免面 infrastructure/assembly/**）。
 * 成员：引擎装配形态类型（EngineAssemblyMode/MainSessionLlmOverride）、
 * main 工具集装配过滤（effectiveMainToolNames）、engineFor（会话绑定引擎
 * 工厂：CoreToolExecutor + PiAgentEngineAdapter 生产/override 两形态）、
 * buildRuntime（SessionRegistry 会话运行时工厂：Session + ChatService 族 +
 * 投影绑定）。抽出为零行为改动纯移动——装配序语义与注释留痕不变；
 * buildSessionStack 经 re-export 保持既有导出面（container/createTestDaemon/
 * main-session-plan 测试 import 路径不变）。
 */

import type { AgentOrchestrationPort } from "../../application/ports/inbound/AgentOrchestrationPort";
import type { AgentEnginePort } from "../../application/ports/outbound/AgentEnginePort";
import type { SessionRepositoryPort } from "../../application/ports/outbound/SessionRepositoryPort";
import type { EventPublisherPort } from "../../application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../application/ports/outbound/ClockPort";
import type { BrowserPort } from "../../application/ports/outbound/BrowserPort";
import type { ProfileKind } from "../../application/ports/outbound/ResourceStatePort";
import type { ProfileSnapshotData } from "../../domain/events/DomainEvent";
import { ChatService } from "../../application/services/ChatService";
import { SessionProjection } from "../../application/services/SessionProjection";
import { profileKindOf } from "../../application/services/modes";
import type { ResourceService } from "../../application/services/ResourceService";
import type { SchedulerService } from "../../application/services/scheduler/SchedulerService";
import type { RuntimeMaterial, SessionRuntime } from "../../application/services/SessionRegistry";
import { createTurnDiffState, TurnDiffService, type TurnDiffState } from "../../application/services/TurnDiffService";
import type { McpRegistry } from "../../adapters/driven/mcp/McpRegistry";
import { createMcpDiscoverTools, createMcpTools } from "../../adapters/driven/mcp/mcp-tool";
import { McpDeferredHooks } from "../../adapters/driven/pi-engine/runtime/hooks/McpDeferredHooks";
import { resolveConfigModel } from "../../adapters/driven/pi-engine/model-provider";
import { resolveEffectiveThinking } from "../../adapters/driven/pi-engine/thinking-resolve";
import type { ModelCatalog } from "../../adapters/driven/pi-engine/model-catalog";
import { PiAgentEngineAdapter, type PiEngineOptions } from "../../adapters/driven/pi-engine/PiAgentEngineAdapter";
import { seedMessagesOf, type AgentMessage } from "../../adapters/driven/pi-engine/mappers/SessionMapper";
import { MainSessionProfile } from "../../adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import type { CompactionSettings } from "../../adapters/driven/pi-engine/runtime/AgentProfile";
import { CoreToolExecutor, type KgToolOptions } from "../../adapters/driven/tools/CoreToolExecutor";
import type { PlanToolDeps } from "../../adapters/driven/tools/plan/PlanTools";
import type { TaskCreateToolDeps } from "../../adapters/driven/tools/task-create/TaskCreateTool";
import type { TaskReportToolDeps } from "../../adapters/driven/tools/task-report/TaskReportTool";
import type { GrepToolDeps } from "../../adapters/driven/tools/grep/GrepTool";
import type { CodegraphToolDeps } from "../../adapters/driven/tools/codegraph/CodegraphTool";
import type { EditToolDeps } from "../../adapters/driven/tools/edit/EditTool";
import type { AuthStore } from "../auth-store";
import type { DefaultModelStore } from "../../adapters/driven/sqlite-session/DefaultModelStore";

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

/** 组装快照（kind 维 tools + systemPrompt 缓存对；启动/toggle 后重算）。 */
export interface AssemblySnapshot {
  readonly tools: readonly string[];
  readonly systemPrompt: string;
}

/** engineFor 的会话绑定入参（T2 turn diff 写钩子闭包绑定）。 */
export type EngineBind = { readonly mainInstanceId: string; readonly diff: TurnDiffState };

/** 会话绑定引擎工厂签名（registry buildRuntime 与测试 override 共用）。 */
export type SessionEngineFactory = (
  sessionId: string,
  mode?: string,
  seed?: readonly AgentMessage[],
  bind?: EngineBind,
) => AgentEnginePort;

/**
 * main 工具集装配过滤（W1/taskCreate/plan 同构：声明面 = 注册面一致）：
 * 未注入依赖的名从清单剔除（resolveTools 声明即注册硬校验不破）。
 * 纯函数（main-session plan 批抽出一一供未注入剔除面单测）。
 */
export function effectiveMainToolNames(
  declared: readonly string[],
  injected: { readonly kg: boolean; readonly codegraph: boolean; readonly taskCreate: boolean; readonly taskReport: boolean; readonly plan: boolean },
): string[] {
  return declared
    .filter((t) => injected.kg || (t !== "kg" && t !== "kg-update"))
    .filter((t) => injected.codegraph || t !== "codegraph")
    .filter((t) => injected.taskCreate || t !== "task_create")
    .filter((t) => injected.taskReport || t !== "task_report")
    .filter(
      (t) =>
        injected.plan || (t !== "plan_create" && t !== "plan_update" && t !== "plan_read"),
    );
}

export interface MainEngineFactoryCtx {
  readonly engineMode: EngineAssemblyMode;
  readonly scheduler: SchedulerService;
  /** SubAgent 模型两级链解析单点（engineFor spawn 透传恒无参调用 = worker 链）。 */
  readonly resolveSubagentModelId: () => string;
  readonly resourceService: ResourceService;
  /** main 组装快照现值读面（let 缓存被 refreshAssembly 重算——getter 保现值读取语义）。 */
  readonly mainAssemblyOf: () => AssemblySnapshot;
  readonly compactionSettings: () => CompactionSettings;
  readonly globalThinking: () => string | undefined;
  readonly toolCwdOf: () => string;
  /** 沙箱运行时现值读面（可选槽——装配层注入则包装 bash/写面；缺省不注入）。 */
  readonly sandboxOf?: () => import("../../adapters/driven/tools/SandboxEnvWrap").SandboxRuntime | undefined;
  readonly turnDiff: TurnDiffService;
  readonly browserPort: BrowserPort;
  /** 活跃主会话 executor 登记（refreshAssembly appendTools 目标；生命周期见 engineFor set 点注释）。 */
  readonly sessionExecutors: Map<string, CoreToolExecutor>;
  /** 主会话 plan 三工具服务面（mainPlanStack 切片；undefined = 不注册 + 清单剔除）。 */
  readonly planToolService: PlanToolDeps["service"] | undefined;
  readonly catalog: ModelCatalog;
  readonly authStore: AuthStore;
  readonly defaultModel: DefaultModelStore;
  /** discover 物化回调（MCP catalog 闭包群切片；本工厂恒绑 main-session kind）。 */
  readonly onMcpDiscover: (kind: ProfileKind, server: string, namespacedNames: readonly string[]) => void;
  // ── 组合根 deps 切片（注入面透传，语义注释见 BuildSessionStackDeps） ──
  readonly editDeps?: (sessionId: string) => EditToolDeps | undefined;
  readonly kgTools?: KgToolOptions | (() => KgToolOptions | undefined);
  readonly codegraphTool?: CodegraphToolDeps | (() => CodegraphToolDeps | undefined);
  readonly taskCreate?: TaskCreateToolDeps;
  readonly taskReport?: TaskReportToolDeps;
  readonly grep?: GrepToolDeps;
  readonly mcpRegistry?: McpRegistry;
  readonly mainSessionLlmOverride?: MainSessionLlmOverride;
}

/**
 * 会话绑定引擎工厂（engineFor）：测试注入实例 = 全部会话共享（单会话测试
 * 形态）；工厂 = 每会话独立；生产路径 = 真引擎 + 会话绑定工具执行器
 *（编排三工具回口携带会话归属——agent_spawn 经此路由到目标会话的调度
 * 入参）。（AD-2）+ ：新会话模型 = 构建期解析 kind 槽位 ?? 当前默认
 *（set_default/槽位 set 后新建会话跟随新值；既有会话不跟随——per-session
 * 覆盖链不变）；apiKey 经 getter 读 auth.json 现值（换 key 下一请求生效）；
 * resolveModelById = 目录活解析面（运行期换模 overlay 模型可达）。
 * spawn 透传模型 = 组合根两级链解析产物（resolveSubagentModelId，T12 起不再
 * 取会话当前模型——SubAgent 只认自身 profile 链）。
 * P1 T3：槽位 kind 字面量参数化——modelSlot/thinkingSlot 的 kind 从会话定格
 * mode 解析（profileKindOf；default → main-session，行为零变化；P2 多模式
 * 自动跟随注册表）。override 工厂（测试注入）不接 mode——结构兼容（参数
 * 少的函数可赋参数多的类型），Fake 引擎无槽位语义不受影响。
 */
export function buildMainEngineFactory(ctx: MainEngineFactoryCtx): SessionEngineFactory {
  const { engineMode } = ctx;
  if (engineMode.kind === "override") {
    return (sessionId: string) => engineMode.factory(sessionId);
  }
  return (sessionId, mode, seed, bind): AgentEnginePort => {
    const sessionOrchestration: AgentOrchestrationPort = {
      spawn: (task, profileKind, reportIntervalMs) =>
        ctx.scheduler.spawn(sessionId, task, profileKind, ctx.resolveSubagentModelId(), reportIntervalMs),
      send: (agentId, message) => ctx.scheduler.send(agentId, message),
      status: (agentId) => ctx.scheduler.status(agentId),
      kill: (agentId) => ctx.scheduler.kill(agentId),
      inspect: (agentId) => ctx.scheduler.inspect(agentId), // T3-B
      park: (agentId) => ctx.scheduler.park(agentId), // ⑤ 链 C：reason 缺省 user（chat 域入口）
      resume: (agentId) => ctx.scheduler.resume(agentId), // ⑤ 链 C
    };
    // W1：kg 挂点/双工具经 workspace 持有者读现值（未绑定 → 不注册/
    // 无挂点——edit 行为不变；kg/kg-update 同步从 profile 工具清单
    // 剔除，resolveTools 硬校验（声明即注册）不破，绑定后新会话获得）
    const editDeps = ctx.editDeps?.(sessionId);
    const kgTools = typeof ctx.kgTools === "function" ? ctx.kgTools() : ctx.kgTools;
    // W1-B：codegraph 工具同 kgTools W1 模式（工厂读现值；未绑定 → 不注册 + 清单剔除）
    const codegraphTool =
      typeof ctx.codegraphTool === "function" ? ctx.codegraphTool() : ctx.codegraphTool;
    // main-session plan 批：instanceId = sessionId 作用域注入（工具参数
    // 零 instanceId 防伪造——PlanTools 语义不变）；未注入（隔离测试形态）
    // → 不注册 + 清单剔除（声明面 = 注册面一致）
    const planDeps =
      ctx.planToolService === undefined
        ? undefined
        : { service: ctx.planToolService, instanceId: sessionId };
    const toolExecutor = new CoreToolExecutor({
      cwd: ctx.toolCwdOf(),
      orchestration: sessionOrchestration,
      grep: ctx.grep,
      // 沙箱（可选开启，KV sandbox_config；沙箱开关批）：off/自检失败 → undefined 纯透传。
      // workspaceRoot 取 toolCwdOf（buildSessionStack L345 同源口径）
      ...(ctx.sandboxOf !== undefined ? { sandbox: ctx.sandboxOf() } : {}),
      // T2 turn diff：env.writeFile 写前快照钩子（闭包绑 mainInstanceId
      // ——该 executor 每会话一个；hook 内部读旧内容落基线，异常吞咽）
      ...(bind !== undefined
        ? {
            writeHook: (p: string, content: string | Uint8Array) =>
              ctx.turnDiff.captureWrite(bind.diff, p, bind.mainInstanceId, content),
          }
        : {}),
      ...(editDeps !== undefined ? { edit: editDeps } : {}),
      ...(kgTools !== undefined ? { kg: kgTools } : {}),
      ...(codegraphTool !== undefined ? { codegraph: codegraphTool } : {}),
      // task_create（T2.4，AD-7）：仅主会话 executor（SubAgent 子进程
      // 本地栈不注入——生效集隔离，AD-2 创建按宿主）
      ...(ctx.taskCreate !== undefined ? { taskCreate: ctx.taskCreate } : {}),
      // task_report（D3）：仅主会话 executor（SubAgent 子进程本地栈与
      // 编排主 agent 不注入——生效集隔离，taskCreate 同构）
      ...(ctx.taskReport !== undefined ? { taskReport: ctx.taskReport } : {}),
      // 主会话 plan 三工具（main-session plan 批）：台账写面 + 广播包装
      ...(planDeps !== undefined ? { plan: planDeps } : {}),
      // 动态族：单 browser 工具注册（ownerId 缺省 "main"——主会话
      // tab 归属）；ChildMain 子进程经 RemoteBrowserPort 转发接入（H-3）
      browser: ctx.browserPort,
      // mcp 批：MCP 命名空间工具现值注入（构造时刻已发现的 server；
      // 后续到位经 refreshAssembly → appendTools 增量推活活跃会话）。
      // deferred 批：同批注入 meta 发现工具（懒加载入口——execute 触发
      // 物化链 onMcpDiscover；主会话 kind 固定 main-session）。
      ...(ctx.mcpRegistry !== undefined
        ? {
            mcp: {
              tools: [
                ...createMcpTools(ctx.mcpRegistry.discoveredTools(), ctx.mcpRegistry),
                ...createMcpDiscoverTools(ctx.mcpRegistry, {
                  isToolEnabled: (name) => ctx.resourceService.isToolEnabled("main-session", name),
                  onDiscover: (server, names) => ctx.onMcpDiscover("main-session", server, names),
                }).tools,
              ],
            },
          }
        : {}),
    });
    // mcp 批：活跃会话 executor 登记（refreshAssembly appendTools 目标）。
    // 生命周期 = 会话 id 不复用 + 每 daemon 进程一个 Map；卸载残留为
    // 小对象引用无句柄调用（可接受——避免 SessionRegistry 加卸载回调面）。
    ctx.sessionExecutors.set(sessionId, toolExecutor);
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
        systemPrompt: ctx.mainAssemblyOf().systemPrompt,
        // W1 绑定闭环：未绑定（kg 双工具未注册）时剔除 kg/kg-update——
        // profile 声明与 executor 注册面一致（resolveTools 硬校验不破）；
        // 绑定后新建会话自动恢复注册面。
        // task_create/plan 三名同款：未注入（测试形态）时剔除，声明与注册一致。
        tools: effectiveMainToolNames(ctx.mainAssemblyOf().tools, {
          kg: kgTools !== undefined,
          codegraph: codegraphTool !== undefined,
          taskCreate: ctx.taskCreate !== undefined,
          taskReport: ctx.taskReport !== undefined,
          plan: planDeps !== undefined,
        }),
        // 压缩参数可配置（KV 存储值 ?? DEFAULT_COMPACTION）；每会话装配读现值。
        compaction: ctx.compactionSettings(),
      },
      model: ctx.mainSessionLlmOverride?.model() ?? resolveConfigModel(
        ctx.resourceService.modelSlot(profileKindOf(mode)) ?? ctx.defaultModel.current(),
        ctx.catalog.modelsView(),
      ),
      apiKeys: () => ({ ...ctx.authStore.apiKeysSnapshot(), ...(ctx.mainSessionLlmOverride?.apiKeys?.() ?? {}) }),
      models: ctx.catalog.modelsView(),
      resolveModelById: (modelId) => resolveConfigModel(modelId, ctx.catalog.modelsView()),
      resolveThinking: (model) =>
        // R7 全局兜底：链尾追加全局默认（未配槽位且未配全局 → 默认关不变）
        resolveEffectiveThinking(
          [adapter?.thinkingOverride(), ctx.resourceService.thinkingSlot(profileKindOf(mode)), ctx.globalThinking()],
          model,
        ),
      resolveTools: (names) => toolExecutor.resolveTools(names),
      // deferred 批：Mcp 懒加载同 turn 生效钩子（state.tools 漂移检测 →
      // turn 边界替换 context.tools——discover 物化后模型下一请求即可
      // 调用；无 MCP 时零漂移零干扰）。链位序：extraHooks 在 compaction
      // 之后（AgentRuntime 装配序）——压缩触发时其替换 context 已含
      // state.tools 现值，短路无害。
      ...(ctx.mcpRegistry !== undefined ? { extraHooks: [new McpDeferredHooks()] } : {}),
      // 测试接缝：mainSessionLlmOverride 恒最高（缺省生产形态）
      ...(ctx.mainSessionLlmOverride !== undefined ? { streamFnOverride: ctx.mainSessionLlmOverride.streamFn } : {}),
      // 恢复回填：mainAgent 实例窗口销毁重建后回填它自己的历史（seed
      // 由 buildRuntime 经 seedMessagesOf 派生；新建会话 = undefined）。
      ...(seed !== undefined ? { initialMessages: seed } : {}),
    });
    return adapter;
  };
}

export interface SessionRuntimeFactoryCtx {
  readonly repository: SessionRepositoryPort;
  readonly clock: ClockPort;
  readonly events: EventPublisherPort;
  readonly scheduler: SchedulerService;
  readonly resourceService: ResourceService;
  readonly defaultModel: DefaultModelStore;
  readonly catalog: ModelCatalog;
  readonly engineFor: SessionEngineFactory;
  /** T3 推送归属反查注册（diff state → sessionId；buildSessionStack 持有的共享面）。 */
  readonly diffSessionIds: WeakMap<TurnDiffState, string>;
  readonly turnDiff: TurnDiffService;
  readonly mainAssemblyOf: () => AssemblySnapshot;
  readonly compactionSettings: () => CompactionSettings;
  /** mainPlanStack 已装配（instantiatedSnapshot 的 plan 注入旗标同源）。 */
  readonly hasMainPlan: boolean;
  /** 转正单点触发面（registry 晚绑闭包——闭包仅运行期触发，注册表已就位）。 */
  readonly promoteDraft: (sessionId: string) => void;
  // ── 组合根 deps 切片（注入面透传） ──
  readonly kgTools?: KgToolOptions | (() => KgToolOptions | undefined);
  readonly codegraphTool?: CodegraphToolDeps | (() => CodegraphToolDeps | undefined);
  readonly taskCreate?: TaskCreateToolDeps;
  readonly taskReport?: TaskReportToolDeps;
  readonly taskInjector?: (sessionId: string, task: string, audience?: "main" | "worker") => string;
  readonly mainSessionLlmOverride?: MainSessionLlmOverride;
}

/**
 * 会话运行时工厂（组合根唯一 new 面）：Session + ChatService 族 + 投影绑定。
 * buildSessionStack 在同装配序位以本工厂产物填 SessionRegistry deps.buildRuntime。
 */
export function buildSessionRuntimeFactory(ctx: SessionRuntimeFactoryCtx): (material: RuntimeMaterial) => SessionRuntime {
  return (material): SessionRuntime => {
    // 恢复回填（三层模型）：实例窗口（LLM 上下文）销毁重建后，从 Entry 树按
    // mainInstanceId 过滤回填该 mainAgent 自己的 user/assistant 历史——空闲卸载/
    // 重启后的「同一实例复活」延续上下文；新建会话/阶段切换新实例无历史 = 空 seed。
    // model 元数据取当前解析模型（与 engineFor 生产分支同序同值；assistant 回填元数据源）。
    const seedModel = ctx.mainSessionLlmOverride?.model() ?? resolveConfigModel(
      ctx.resourceService.modelSlot(profileKindOf(material.session.mode)) ?? ctx.defaultModel.current(),
      ctx.catalog.modelsView(),
    );
    const seed = seedMessagesOf(material.session.entryList(), material.session.mainInstanceId, {
      api: seedModel.api,
      provider: seedModel.provider,
      model: seedModel.id,
    });
    // T2 turn diff：会话级 diff 状态（挂 runtime——全内存零持久化；
    // engineFor 写钩子与 ChatService 轮次挂点同一状态闭包绑定）
    const diffState = createTurnDiffState();
    ctx.diffSessionIds.set(diffState, material.session.id); // T3 推送归属反查注册
    const engine = ctx.engineFor(material.session.id, material.session.mode, seed, {
      mainInstanceId: material.session.mainInstanceId,
      diff: diffState,
    });
    // thinking 批③跨冷恢复（AD-4③）：回放末值覆盖直写引擎内存态——
    // 不走 ChatService.setThinking 发布面（零新事件流零落盘铁律，恢复不重放）；
    // 区别于 model.set 不跨冷恢复现状（TR-AD-41 反例钉死，差异不动）。
    if (material.thinkingOverride !== undefined) engine.setThinking?.(material.thinkingOverride);
    const chatService = new ChatService({
      engine,
      events: ctx.events,
      clock: ctx.clock,
      session: material.session,
      restoredToolCalls: material.toolCalls,
      // 定向 steer 转投面——AgentOrchestrationPort.send（契约 v0.3 §3.2）
      // 同链路（目标状态前置判定归调度侧既有 send 链，编排泄零入 driving）
      sendToInstance: (agentId, message) => ctx.scheduler.send(agentId, message),
      // model.changed 的 from 兜底（AD-6：引擎未暴露观测值时
      // 回退全局默认，与 ModelService previous 口径一致）
      modelFallback: () => ctx.defaultModel.current(),
      // 主实例 instantiated 快照供给（AD-5）：读组装缓存
      // 缓存（与 engineFor 实际装配同源，消观测漂移；模型仍取创建时引擎
      // 观测值 ?? 全局默认）；起发布触发在注册表 promoteDraft（转正：
      // 首个用户条目；恢复路径不重发）。
      instantiatedSnapshot: (): ProfileSnapshotData => ({
        systemPrompt: ctx.mainAssemblyOf().systemPrompt,
        // 声明面=注册面铁律（code-review M33）：快照 tools 与引擎装配面同过
        // effectiveMainToolNames——未绑定/测试形态时不得快照广告未注册工具。
        tools: effectiveMainToolNames(ctx.mainAssemblyOf().tools, {
          kg: (typeof ctx.kgTools === "function" ? ctx.kgTools() : ctx.kgTools) !== undefined,
          codegraph: (typeof ctx.codegraphTool === "function" ? ctx.codegraphTool() : ctx.codegraphTool) !== undefined,
          taskCreate: ctx.taskCreate !== undefined,
          taskReport: ctx.taskReport !== undefined,
          plan: ctx.hasMainPlan,
        }),
        model: engine.currentModel?.() ?? ctx.defaultModel.current(),
        ...(MainSessionProfile.compaction !== undefined
          ? { compaction: ctx.compactionSettings() }
          : {}),
        hooks: MainSessionProfile.hooks.map((H) => H.hookName),
      }),
      // 转正单点触发面：零条目草稿首个用户条目落聚合 → 注册表
      // promoteDraft（恰好一次 instantiated + 补 created；闭包仅在运行期
      // 触发——createFresh 发生在 initialize/运行期，注册表已就位）
      onFirstUserEntry: () => ctx.promoteDraft(material.session.id),
      // W2-D R9/R10 主会话切片注入：复用 spawn 派发同一注入器（KgQueryService
      // .injectTaskSlice——sessionId 跨通道去重同键）；空串回退（未绑定工作
      // 空间时容器注入面回 ""）视为空命中原文透传。D8 W-R6：主会话链恒
      // main 受众（协议行 kg-update 直落措辞——与 spawn 链 worker 版分叉）。
      ...(ctx.taskInjector !== undefined
        ? { taskSliceInjector: (sid: string, text: string) => ctx.taskInjector!(sid, text, "main") || text }
        : {}),
      // T2 turn diff：轮次挂点（开轮重置/收轮冻结——挂点在编排层，不改
      // Session 聚合；endTurn fire-and-forget，冻结流水线后台完成）
      turnDiff: {
        onTurnBegin: (turnId, startedAt) => ctx.turnDiff.beginTurn(diffState, turnId, startedAt),
        onTurnEnd: (turnId, outcome, endedAt) => {
          void ctx.turnDiff.endTurn(diffState, outcome, endedAt);
        },
      },
    });
    // 会话投影消费者（AD-3 §3.2②；多会话 = 按 sessionId 分实例化，
    // architecture-feedback #20 建议采纳）：SubAgent Entry 落聚合 + 账本入账
    // + write-through（fan-out 投影路由按事件 sessionId 分发到本投影）。
    const projection = new SessionProjection({
      repository: ctx.repository,
      getSession: () => chatService.sessionView,
      getMainState: () => ({ agentState: chatService.agentState, toolCalls: chatService.toolCallData }),
      initialUsage: material.usage,
    });
    return { sessionId: material.session.id, chatService, projection, diff: diffState };
  };
}
