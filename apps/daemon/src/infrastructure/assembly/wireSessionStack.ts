import path from "node:path";
import type { BrowserPort } from "../../application/ports/outbound/BrowserPort";
import type { ClockPort } from "../../application/ports/outbound/ClockPort";
import type { CustomProviderDef } from "../../application/ports/outbound/CustomProviderPort";
import type { InstanceRunner } from "../../application/services/InstanceRunner";
import type { AskService } from "../../application/services/AskService";
import type { ClosureFindingsSink } from "../../application/services/scheduler/ClosureRecorder";
import type { StewardMemoryService } from "../../application/steward/StewardMemoryService";
import type { WorkspaceService } from "../../application/services/workspace/WorkspaceService";
import type { CodegraphResolution } from "../../adapters/driven/codegraph-engine/resolve-codegraph";
import type { McpRegistry } from "../../adapters/driven/mcp/McpRegistry";
import type { GrepBackendFreeze } from "../../adapters/driven/tools/grep/freeze-backend";
import type { Logger } from "../logging";
import type { DaemonConfig } from "../config";
import type { HelixPaths } from "../paths";
import {
  buildSessionStack,
  type AssemblyBackfill,
  type EngineAssemblyMode,
  type MainSessionLlmOverride,
} from "./buildSessionStack";
import type { PersistenceStack } from "./buildPersistence";
import type { ModelStack } from "./buildModelStack";
import type { TaskStack } from "./buildTaskStack";
import type { FanoutPublisher } from "./wireEventFanout";
import type { ResourceEventBus } from "./resource-events";
import { buildEditToolDeps } from "./buildKnowledgeStack";
import { scanWorkspaceProjects } from "../../adapters/driven/workspace-scan";

/**
 * 装配接线片：会话栈（buildSessionStack）的依赖面组装（P5 体量门拆分，自
 * 组合根 container.ts 原样迁出）。组合根的一部分（AG-02④ 豁免面
 * infrastructure/assembly/**）。
 *
 * 接线形态：本片**不做构造决策**，只把组合根已备好的持久化族/模型域/任务栈/
 * workspace 持有者/启动定格产物与晚绑闭包组装成 buildSessionStack 入参——
 * 装配序与单例语义（谁先建、谁共享同一实例）仍由组合根编排，本片原位调用。
 *
 * 晚绑闭包二例（原 container 内引用，改为 provider 注入——闭包只在运行期触发，
 * 构造窗口零调用）：① memory_search 检索面读 stewardMemory 现值（vec0 缺席/
 * 开库失败 = undefined 不注册）；② task:* 会话归属 closure 转投编排服务
 * （编排服务在会话栈之后构造回填）。
 */
export interface WireSessionStackDeps {
  readonly paths: HelixPaths;
  readonly config: DaemonConfig;
  readonly logger: Logger;
  readonly clock: ClockPort;
  readonly persistence: PersistenceStack;
  readonly modelStack: ModelStack;
  readonly taskStack: TaskStack;
  readonly workspace: WorkspaceService;
  readonly askService: AskService;
  /** custom provider 子进程透传面（CustomProviderService.list 现值读口）。 */
  readonly customProvidersOf: () => readonly CustomProviderDef[];
  readonly browserPort: BrowserPort;
  readonly fanoutPublisher: FanoutPublisher;
  readonly resourceEvents: ResourceEventBus;
  readonly mcpRegistry: McpRegistry;
  readonly backfill: AssemblyBackfill;
  readonly grepFreeze: GrepBackendFreeze;
  readonly codegraphResolution: CodegraphResolution;
  // ── 装配形态与测试注入面（容器 AssembleDaemonDeps 透传） ──
  readonly engineMode: EngineAssemblyMode;
  readonly mainSessionLlmOverride?: MainSessionLlmOverride;
  readonly subagentRunnerOverride?: InstanceRunner;
  readonly toolCwd?: string;
  readonly builtinSkillsDir?: string;
  readonly sessionIdleUnloadMs?: number;
  readonly sessionIdlePollMs?: number;
  readonly findingsSinkOverride?: ClosureFindingsSink;
  /** 管家长期记忆现值读口（晚绑：本片之后构造）。 */
  readonly stewardMemoryOf: () => StewardMemoryService | undefined;
  /** 批次实例收口路由（晚绑：编排服务在本片之后构造回填）。 */
  readonly onInstanceClosure: (agentId: string) => void;
}

export async function wireSessionStack(deps: WireSessionStackDeps): Promise<Awaited<ReturnType<typeof buildSessionStack>>> {
  const { paths, config, logger, clock, persistence, modelStack, taskStack, workspace, askService, browserPort, fanoutPublisher, resourceEvents, mcpRegistry, backfill, grepFreeze, codegraphResolution } = deps;
  return buildSessionStack({
    paths,
    config,
    logger,
    repository: persistence.repository,
    resourceState: persistence.resourceState,
    clock,
    authStore: modelStack.authStore,
    catalog: modelStack.catalog,
    defaultModel: persistence.defaultModel,
    defaultThinking: persistence.defaultThinking, // R7 全局兜底批
    compactionConfig: persistence.compactionConfig, // 压缩参数可配置
    schedulingConfig: persistence.schedulingConfig, // SubAgent 调度预算（运行期可调，config.json 瘦身迁入）
    sandboxConfig: persistence.sandboxConfig, // 沙箱开关（装配期定格读取，沙箱开关批）
    askService, // 提权申请批：permission_request 工具仲裁（沙箱 on 时注册）
    // custom provider 子进程透传批：定义读面单源（CustomProviderService.list
    // ——launcher env 定格透传，详见 SubagentLauncherDeps.customProviders）
    customProvidersOf: () => deps.customProvidersOf(),
    browserPort,
    events: fanoutPublisher,
    publishResourceChanged: (kind) => resourceEvents.publish({ kind }),
    mcpRegistry,
    backfill,
    engineMode: deps.engineMode,
    mainSessionLlmOverride: deps.mainSessionLlmOverride,
    subagentRunnerOverride: deps.subagentRunnerOverride,
    toolCwd: deps.toolCwd,
    // W1F-F1：会话工具沙箱 cwd 动态解析接线（评审缺口修复：此前仅传启动
    // 定格面，生产恒回落启动 cwd）——经 workspace 持有者读现值（boundRoot()
    // 规范形；未绑定回落启动 cwd）；deps.toolCwd 显式注入（测试面）时恒
    // 优先（toolCwdOf 优先级链）。
    resolveToolCwd: () => workspace.boundRoot() ?? process.cwd(),
    // grep 启动定格产物（AF-1，rg 单后端）：rg 定格注入路径；unavailable
    // 定格注入原因清单（门面响亮失败文案用）。
    grep: {
      rgPath: grepFreeze.kind === "rg" ? grepFreeze.rgPath : undefined,
      unavailableReasons: grepFreeze.kind === "unavailable" ? grepFreeze.reasons : undefined,
    },
    // kg 挂点（T3.2 附着接线）：每会话闭合 sessionId（跨通道去重键）——
    // edit 成功路径附着 📎 块（notifyWrite 写后 sync 挂接按 2026-08-29
    // 用户裁决退役，不注入）。W1：经
    // workspace 持有者读现值（重绑后新会话跟随新栈；未绑定 → undefined
    // 无挂点，EditTool 行为不变）。
    editDeps: (sessionId) => {
      const stack = workspace.stack();
      const root = workspace.boundRoot();
      return stack !== null && root !== null
        ? buildEditToolDeps({
            workspaceRoot: root,
            attachment: stack.attachmentService,
            sessionId,
          })
        : undefined;
    },
    // kg 双工具装配面（T3.3）：主会话 executor 注册 kg/kg-update（SubAgent
    // 子进程侧由 ChildMain 本地栈自带）。W1：工厂形态经持有者读现值
    //（重绑后新会话跟随新栈；未绑定 → 不注册）。
    kgTools: () => {
      const stack = workspace.stack();
      const root = workspace.boundRoot();
      return stack !== null && root !== null
        ? {
            query: stack.queryService,
            write: stack.writeService,
            workspaceRoot: root,
            scanProjects: () => scanWorkspaceProjects(root),
            // 批2 WP-C：写入口语义查重闸（向量面在场才挂——可选件纪律）
            ...(stack.dedupService !== undefined ? { dedup: stack.dedupService } : {}),
          }
        : undefined;
    },
    // codegraph 工具装配面（W1-B，R5/R7）：主会话 executor 注册 codegraph
    //（SubAgent 子进程侧由 ChildMain 本地栈自带）。W1 同 kgTools：工厂经
    // 持有者读现值（重绑后新会话跟随；未绑定 → 不注册）。引擎适配器持有
    // 启动定格二进制（buildKnowledgeStack 同源）；二进制不可达时工具仍在，
    // 调用 degraded（EngineUnavailable），不阻断装配。
    codegraphTool: () => {
      const stack = workspace.stack();
      const root = workspace.boundRoot();
      return stack !== null && root !== null
        ? { engine: stack.codegraphEngine, workspaceRoot: root }
        : undefined;
    },
    // codegraph 二进制定格路径（W1-B）：透传 SubAgent 子进程 env（父子一致）
    ...(codegraphResolution.kind === "resolved" ? { codegraphPath: codegraphResolution.path } : {}),
    // rg 二进制定格路径（rg 唯一化）：透传 SubAgent 子进程 env（父子一致；
    // config 级 rg 无此透传则子进程只剩 bundle 级）
    ...(grepFreeze.kind === "rg" ? { rgPath: grepFreeze.rgPath } : {}),
    // task_create 工具装配面（T2.4，AD-7）：主会话 executor 注册 chat 第二
    // 创建入口——与 /project 入口同一 createTask API（TaskEngineService 注入）
    // + 回执读面（TaskQueryService 投影）；SubAgent 子进程本地栈不注入（生效集隔离）
    taskCreate: { engine: taskStack.taskEngine, query: taskStack.query },
    // 可用任务类型段数据源（audience 分类注入，批二）：MainAgent 提示的
    // 任务类型清单 = 任务注册表读面（与 task_create 的类型校验同一事实源）
    taskTypesOf: () => taskStack.orchestratorCore.skills.listTaskTypes(),
    // 项目常驻规则段数据源（global 声明节点触发面索引，U7 去全扫化）：
    // 纯查询面（会话足迹项目集 → 段或 null，足迹求值在 session 栈内）。
    // kg 栈按足迹项目集聚合渲染；空足迹/未绑定/无图谱 → null → 段省略。
    // 栈级快照不含此段，会话级应用点（engineFor/instantiatedSnapshot/
    // toggle 推送/subagentAssemblyFor）应用时刻取现值。
    residentRulesOf: (projectRoots: readonly string[]) =>
      workspace.stack()?.queryService.residentRulesSection(projectRoots) ?? null,
    // 批E：memory_search 检索面现值读口（编码 agent 记忆消费面工具化——
    // 批D 静态段注入退役）。stewardMemory 在下方构造（晚绑闭包——运行期
    // 触发时已就位）；缺席（vec0 不可解析/记忆存储开库失败）→ undefined →
    // engineFor 不注册。记忆未配置（enabled 关/端点悬空）不影响 service
    // 在场——工具注册面恒宽（toggle 推送兑底），广告面按 isAvailable
    // 现值门控（sessionEngineFactory）。scope 项目解析在 session 栈内
    // （writeFacts 足迹单项目归约——singleProjectDirOf 单点，与 progress
    // 写入 scope 同源）。
    memorySearchServiceOf: () => deps.stewardMemoryOf(),
    // task_report 工具装配面（D3）：主会话 executor 注册 chat 回流通用报告
    // 查询面——任务读面（TaskQueryService list/detail）+ closure_records 读面
    //（SessionRepositoryPort.queryClosureRecords）+ 报告目录约定（与
    // ClosureRecorder 兜底 reportsDirFor 同源同式 <home>/reports/<sessionId>）；
    // SubAgent 子进程本地栈与编排主 agent 不注入（生效集隔离）
    taskReport: {
      query: taskStack.query,
      closureRecords: (sessionId) => persistence.repository.queryClosureRecords(sessionId),
      reportDirFor: (sessionId) => path.join(paths.home, "reports", sessionId),
    },
    // 主会话 todo 双工具装配面（plan 三工具改名批）：instanceId = sessionId
    // 作用域；写面 = 父进程 LazyWorkLedger 直连 helix.db（同库 WAL 跨进程
    // 安全）；执行成功后装配层广播 session.plan.changed + 快照附 plan 读面
    //（SubAgent 子进程本地栈不受影响——两栈独立）
    mainPlan: {},
    // spawn 派发任务切片注入（F1.3；检索语义化批双轨 async 化）：任务文本
    //  → 图查询（关键词轨 ∪ 向量轨）→ digest+指针切片拼入 task 约束区；
    // 注入后 markInjected 入跨通道去重注册表（T3.2 同源）。嵌入往返（超时
    // 上限 800ms）随链落定，失败降级纯关键词轨。
    // W1：未绑定 → 空切片（无图查询面，零副作用）。audience（D8 W-R6）：
    // SubAgent spawn 链传 "worker"（协议行 findings 申报措辞），主会话
    // ChatService 链传/缺省 "main"（kg-update 直落措辞）——buildSessionStack 按消费链分叉。
    taskInjector: async (sessionId, task, audience, projectRoots) =>
      (await workspace.stack()?.queryService.injectTaskSlice(sessionId, task, audience, projectRoots)) ?? "",
    // findings 落账管道（F3.0，T4.1）：findings 文件 canonical → KgWriteService 唯一
    // 写入口落账（绝不旁路）；目标项目解析 = workspace 全扫描（与 kg-update
    // 工具同口径：显式名命中 / 唯一项目自动 / 多项目不猜）。测试可注入替身。
    // W1：未绑定 → 落账拒绝（KG_E_STATE，不吞声）+ 空扫描。
    findingsSink: deps.findingsSinkOverride ?? {
      write: (projectRoot, op) =>
        workspace.stack()?.writeService.write(projectRoot, op) ?? {
          ok: false,
          error: { code: "KG_E_STATE", message: "未绑定工作空间：findings 落账跳过（请先选择工作空间）" },
        },
      scanProjects: () => {
        const root = workspace.boundRoot();
        return root !== null ? scanWorkspaceProjects(root) : [];
      },
      // 迭代锚回落（缺口修复：findings 缺 iterationId 时回落库内锚——与 kg-update
      // 工具 resolveIterationId 同语义；未绑定返回 null 不报错）
      latestIteration: (projectRoot) => workspace.stack()?.queryService.latestIteration(projectRoot) ?? null,
    },
    builtinSkillsDir: deps.builtinSkillsDir,
    sessionIdleUnloadMs: deps.sessionIdleUnloadMs,
    sessionIdlePollMs: deps.sessionIdlePollMs,
    // T2.2：任务批次实例收口路由——task:* 会话归属 closure 转投编排服务
    //（晚绑闭包：编排服务在本块之后构造回填）
    taskClosureSink: (agentId) => deps.onInstanceClosure(agentId),
  });
}
