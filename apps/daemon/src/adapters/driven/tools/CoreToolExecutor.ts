import type {
  AgentHarnessTool,
  AgentTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { TextContent } from "@earendil-works/pi-ai";
import {
  createBashTool,
  createEditTool as createPiEditTool,
  createReadTool as createPiReadTool,
  createWriteTool,
  NodeExecutionEnv,
} from "@earendil-works/pi-agent-core/node";
import type {
  ToolCallRequest,
  ToolExecutionResult,
  ToolExecutorPort,
} from "../../../application/ports/outbound/ToolExecutorPort";
import type { AgentOrchestrationPort } from "../../../application/ports/inbound/AgentOrchestrationPort";
import type { BrowserPort } from "../../../application/ports/outbound/BrowserPort";
import { createGrepTool, type GrepToolDeps } from "./grep/GrepTool";
import { createEditTool, type EditToolDeps } from "./edit/EditTool";
import { createReadTool } from "./read/ReadTool";
import { createEditLinesTool } from "./edit-lines/EditLinesTool";
import { createKgTool } from "./kg/KgTool";
import { createKgUpdateTool } from "./kg-update/KgUpdateTool";
import { createCodegraphTool, type CodegraphToolDeps } from "./codegraph/CodegraphTool";
import { createTaskCreateTool, type TaskCreateToolDeps } from "./task-create/TaskCreateTool";
import { createTaskReportTool, type TaskReportToolDeps } from "./task-report/TaskReportTool";
import { createTaskOpsTools, type TaskOpsToolDeps } from "./task-ops/TaskOpsTools";
import {
  createPlanCreateTool,
  createPlanReadTool,
  createPlanUpdateTool,
  type PlanToolDeps,
} from "./plan/PlanTools";
import { createWebSearchTool } from "./web/WebSearchTool";
import { createWebFetchTool } from "./web/WebFetchTool";
import { createBrowserTool } from "./web/BrowserTools";
import { createAgentSpawnTool, createAgentSendTool, createAgentStatusTool, createAgentInspectTool, createAgentParkTool, createAgentResumeTool } from "./agent/AgentOrchestrationTools";
import { type CoordToolDeps, createCoordClaimTool, createCoordQueryTool, createCoordReleaseTool } from "./coord/CoordTools";
import { imagesOfContent } from "../../../application/services/images";
import type { KgQueryService } from "../../../application/services/kg/KgQueryService";
import type { KnowledgeWriteOp, WriteResult } from "../../../domain/kg/types";
import { wrapEnvForDiff, type EnvWriteHook } from "./TurnDiffEnvWrap";
import { wrapEnvForSandbox, type SandboxRuntime } from "./SandboxEnvWrap";
import { wrapEnvForBashSense, type BashSenseRuntime } from "./BashSenseEnvWrap";
/**
 * CoreToolExecutor —— ToolExecutorPort 的真实现（architecture.md §3.4，
 * 落位 adapters/driven/tools，AD-17/AD-10）。
 *
 * 两件事：
 * 1. **执行**（ToolExecutorPort.execute）：service 层工具编排的出口——
 *    按名查找注册表工具并真实执行（bash/write 来自 `pi-agent-core/node`
 *    内置，ExecutionEnv 用其 Node 实现；edit/read/edit-lines 为自写
 *    （AD-12 同名覆盖 + 失败推荐管线/行号输出），同 env 同沙箱 cwd；
 *    grep 为自写，同 env 同沙箱 cwd）。
 * 2. **装配**（resolveTools）：把 profile 声明的工具集装配成 pi
 *    AgentTool 清单交给 AgentRuntime——内置工具是 AgentHarnessTool
 *    （execute 多一个 context 参数），经 bindToolContext 闭包绑定
 * （闭包绑定，~5 行/工具）。
 *
 * 封装边界：pi 工具符号只出现在本目录；pi-engine 与
 * 本目录互不 import，装配经组合根（AG 套件守护）。日后整体替换本目录
 * （如换工具实现）不动其他层。
 */

/**
 * AgentHarnessTool → AgentTool 的 context 绑定（签名差异闭包消解）：
 * 内置工具 execute 签名多一个 context 参数，Agent 期望 4 参形态，
 * 用闭包把 {env} 绑进去。
 */
export function bindToolContext<T extends ExecutionToolContext>(
  tool: AgentHarnessTool<T, any, any>,
  context: T,
): AgentTool<any> {
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) =>
      tool.execute(toolCallId, params, signal, onUpdate, context),
  } as AgentTool<any>;
}

/** kg 双工具注入面（T3.3；query/write 均为结构化面——KgQueryService/
 * KgWriteService 与测试替身同形）。 */
export interface KgToolOptions {
  readonly query: Pick<KgQueryService, "search" | "get" | "locate" | "affected" | "listCandidates">;
  /**
   * kg 写面（kg-update 注册开关，T2.2 起可选）：缺席 = 只注册只读 kg 工具
   * ——编排主 agent 会话（AD-10：编排器不持 kg 写工具）的装配形态；
   * 主会话/子进程注入 write 则双工具全注册（既有行为不变）。
   */
  readonly write?: { write(projectRoot: string, op: KnowledgeWriteOp): WriteResult };
  readonly workspaceRoot: string;
  readonly scanProjects: () => readonly string[];
  /**
   * 任务归属上下文（T4.2 机械注入，AD-10）：批次子进程接线层注入——
   * kg-update 三写路径的 taskId/originBatchId 默认值源（LLM 显式传参
   * 优先）。缺席 = 非任务上下文（主会话/chat 子进程）→ 零注入。
   */
  readonly taskContext?: () => { readonly taskId: string; readonly originBatchId: string } | undefined;
}

export interface CoreToolExecutorOptions {
  /** 工具沙箱 cwd（相对路径的解析根；daemon 侧为进程工作区，测试指向 tmp）。 */
  readonly cwd: string;
  /** shell 覆盖（透传 NodeExecutionEnv；测试/特殊环境用）。 */
  readonly shellPath?: string;
  readonly shellEnv?: Record<string, string>;
  /**
   * 编排端口：提供则注册 agent_spawn/agent_send/agent_status/agent_inspect
   * + agent_park/agent_resume（⑤ 链 C，仅 Main 声明）六工具
   * （经 port 回 SchedulerService，TR-AD-9）；缺省不注册（SubAgent 子进程
   * 装配/无编排场景的 profile 不声明这些名）。
   */
  readonly orchestration?: AgentOrchestrationPort;
  /**
   * 占用协调注入面（U4）：提供则注册 coord_claim/coord_release/coord_query
   * 三工具（仅 MainSessionProfile 声明——决策主体；SubAgent 执行者不拿
   * 决策工具）。缺省不注册。
   */
  readonly coord?: CoordToolDeps;
  /**
   * 浏览器连接端口（动态族）：提供则注册单 browser 工具（action 参数
   * 分发，纯薄转投，CDP 知识全在 port 实现）；缺省不注册——ChildMain
   * （SubAgent 子进程）只传 cwd，子进程无动态族。
   */
  readonly browser?: BrowserPort;
  /** browser open 的 tab 归属（owner 维度回收/观测；缺省 "main"）。 */
  readonly ownerId?: string;
  /**
   * grep 后端定格注入（AF-1 启动定格产物：组合根一次性 resolve+探针后
   * 经此注入 rg 路径；rg 单后端——缺省 = unavailable 定格，工具响亮失败。
   * ChildMain 子进程经 HELIX_RG_PATH env 透传消费）。
   */
  readonly grep?: GrepToolDeps;
  /**
   * 自写 edit/edit-lines 注入面（T3.1）：notifyWrite 写后通知（T2.2
   * KgSyncService 契约签名，未到位时容缺空操作）+ onEditApplied 成功路径
   * 挂点（T3.2 附着接线预留）。缺省 = 全容缺。
   */
  readonly edit?: EditToolDeps;
  /**
   * kg 双工具注入面（T3.3）：提供则注册 kg（只读 search/get）与
   * kg-update（即时落账/supersede）。主会话（buildSessionStack）与
   * SubAgent 子进程（ChildMain 本地栈）均注入；D8 W-R6 后工具集归属：
   * subagent-worker 只声明 kg、subagent-kg-writer（图谱产出型批次）声明
   * 双工具；注册面恒宽（声明面管控谁可见）；缺省不注册（既有测试形态）。
   */
  readonly kg?: KgToolOptions;
  /**
   * codegraph 工具注入面（W1-B，R5/R7）：提供则注册 codegraph（只读六 op）。
   * 主会话（buildSessionStack）与 SubAgent 子进程（ChildMain 本地栈）注入——
   * Orchestrator 不挂（R7，OrchestratorProfile 不声明该名）。缺省不注册
   * （既有测试形态/未绑定 workspace 时 profile 同步剔除该名）。
   */
  readonly codegraph?: CodegraphToolDeps;
  /**
   * plan 三工具注入面（T1.4，AD-6①；main-session plan 批扩双宿主）：
   * 实例工作台账写口（plan_create/plan_update/plan_read）。SubAgent 子进程
   * （ChildMain 本地栈）与主会话（buildSessionStack 主会话 executor——
   * instanceId = sessionId 作用域）均注入；instanceId 由装配面注入（工具
   * 参数零 instanceId，防伪造）。缺省不注册（既有测试形态——profile 声明
   * 三名时必须注入，resolveTools fail-fast；主会话未注入时 engineFor 同步
   * 剔除三名）。
   */
  readonly plan?: PlanToolDeps;
  /**
   * task_create 工具注入面（T2.4，AD-7 chat 第二创建入口）：TaskEngine
   * createTask 面 + 回执读面。仅主会话（buildSessionStack engineFor）注入
   * ——task_create 不进 SubAgent 生效集（批次 SubAgent 不能建任务，AD-2
   * 创建按宿主）；ChildMain 子进程本地栈不注入。缺省不注册（既有测试
   * 形态/SubAgent 装配——MainSessionProfile 声明该名时必须注入，
   * resolveTools fail-fast）。
   */
  readonly taskCreate?: TaskCreateToolDeps;
  /**
   * task_report 工具注入面（D3，chat 回流通用报告查询面）：任务读面
   *（TaskQueryService list/detail 投影）+ closure_records 读面 + 报告目录
   * 约定。仅主会话（buildSessionStack engineFor）注入——task_report 不进
   * SubAgent/编排主 agent 生效集（批次/编排面无查询其他任务报告职责）；
   * ChildMain 子进程本地栈不注入。缺省不注册（既有测试形态——
   * MainSessionProfile 声明该名时必须注入，resolveTools fail-fast）。
   */
  readonly taskReport?: TaskReportToolDeps;
  /**
   * 任务引擎回口工具族注入面（T2.2，AD-3③）：六工具（划批次落行/派发落章/
   * 阶段推进/阶段产物聚合/任务收口）+ 编排者台账读变体。仅编排主 agent
   * 会话（组合根 orchestrator-runtime 工厂）注入——不进主会话/SubAgent
   * 生效集（批次成败收口不在 LLM 面，硬约束判定归 TaskOrchestratorService
   * 代码机械执行）。jobId 由装配面绑定。缺省不注册。
   */
  readonly taskOps?: TaskOpsToolDeps;
  /**
   * MCP 命名空间工具注入面（mcp 批）：提供则注册全部动态发现工具
   * （`${server}__${tool}`，适配器产物 McpRegistry.currentTools 现值）。
   * 注册面不认识 MCP——只收 AgentHarnessTool[]（发现/适配在组合根）；
   * 运行期增量经 appendTools（McpRegistry 到位即推）。缺省不注册
   * （无 MCP server / 未就绪形态）。
   */
  readonly mcp?: { readonly tools: readonly AgentHarnessTool<ExecutionToolContext, any, any>[] };
  /**
   * env.writeFile 写前快照钩子（T2 turn diff 数据链）：提供则包装本
   * executor 的共享 env（writeFile 前触发——此时磁盘仍是旧内容，读旧
   * 内容快照/上报元数据）；hook 异常吞咽不影响写入；缺省不包装（行为
   * 零差）。主会话绑 mainInstanceId（buildSessionStack 闭包），SubAgent
   * 子进程绑 stdout file-write 行（ChildMain）。
   */
  readonly writeHook?: EnvWriteHook;
  /**
   * 沙箱运行时（可选槽——off/未注入 = 零包装零差）：注入则包装 env 的
   * exec（bash → /usr/bin/sandbox-exec）与写方法族（writeFile/appendFile/
   * renameFile/remove/createDir 路径判定）。包装在 writeHook（diff 快照）
   * 之外层：被拒的写不产生 diff 事实。装配面见 sandboxSetup.readSandboxRuntime
   * （配置读取 + 自检降级）；main（sessionEngineFactory）与 SubAgent 子进程
   * （ChildMain）两端同构注入。
   */
  readonly sandbox?: SandboxRuntime;
  /**
   * bash 写感知运行时（可选槽——U0b；未注入 = 零包装零差）：注入则包装
   * env 的 exec（前快照 → 原执行 → 后快照差集 → onObserved 出口）。
   * 包装在沙箱之外最外层（看到原始 command，快照口径覆盖沙箱执行）。
   * main（sessionEngineFactory → registry.recordMany）与 SubAgent 子进程
   * （ChildMain → wire bash-fact 行上报）两端同构注入。
   */
  readonly bashSense?: BashSenseRuntime;
}

export class CoreToolExecutor implements ToolExecutorPort {
  private readonly context: ExecutionToolContext;
  private readonly registry: Map<string, AgentHarnessTool<ExecutionToolContext, any, any>>;

  constructor(options: CoreToolExecutorOptions) {
    const baseEnv = new NodeExecutionEnv({
      cwd: options.cwd,
      shellPath: options.shellPath,
      shellEnv: options.shellEnv,
    });
    // T2 turn diff：写前快照钩子包装（缺省零包装零差；hook 异常吞咽）。
    // 沙箱包装在外层（先判定拒绝、后快照——被拒写不进 diff 事实）；
    // bash 感知最外层（原始 command 定快照计划，覆盖沙箱执行效果）
    const env = wrapEnvForBashSense(
      wrapEnvForSandbox(
        wrapEnvForDiff(baseEnv, options.writeHook),
        options.sandbox,
      ),
      options.bashSense,
    );
    this.context = { env };
    const tools: AgentHarnessTool<ExecutionToolContext, any, any>[] = [
      // pi 内置四工具基线注册（F-20：registry 按 name 平铺，内置无特权）
      createBashTool(),
      createPiReadTool(),
      createWriteTool(),
      createPiEditTool(),
      // 自写三件（AD-12）：同名覆盖 pi 内置 edit/read（后注册者胜）+
      // 新增 edit-lines 行锚编辑；write/bash 保留 pi 注册
      createReadTool(),
      createEditTool(options.edit),
      createEditLinesTool(options.edit),
      createGrepTool(options.grep),
      createWebSearchTool(),
      createWebFetchTool(),
    ];
    if (options.orchestration !== undefined) {
      tools.push(
        createAgentSpawnTool(options.orchestration),
        createAgentSendTool(options.orchestration),
        createAgentStatusTool(options.orchestration),
        createAgentInspectTool(options.orchestration), // T3-B
        createAgentParkTool(options.orchestration), // ⑤ 链 C：挂起（仅 Main 声明）
        createAgentResumeTool(options.orchestration), // ⑤ 链 C：恢复（仅 Main 声明）
      );
    }
    if (options.coord !== undefined) {
      // U4：coord 三工具（占用协调声明/查询面——身份绑定装配面注入）
      tools.push(
        createCoordClaimTool(options.coord),
        createCoordReleaseTool(options.coord),
        createCoordQueryTool(options.coord),
      );
    }
    if (options.browser !== undefined) {
      tools.push(createBrowserTool(options.browser, options.ownerId ?? "main"));
    }
    if (options.kg !== undefined) {
      // kg 双工具（T3.3）：kg 只读面恒注册；kg-update 即时落账面仅在 write
      // 注入时注册（T2.2 write 转可选——编排主 agent 只读形态不注册写面）
      tools.push(createKgTool({ query: options.kg.query }));
      if (options.kg.write !== undefined) {
        tools.push(
          createKgUpdateTool({
            query: options.kg.query,
            write: options.kg.write,
            workspaceRoot: options.kg.workspaceRoot,
            scanProjects: options.kg.scanProjects,
            ...(options.kg.taskContext !== undefined ? { taskContext: options.kg.taskContext } : {}),
          }),
        );
      }
    }
    if (options.codegraph !== undefined) {
      // codegraph（W1-B，R5）：只读六 op 薄壳（注册即只读——工具面零写路径）
      tools.push(createCodegraphTool(options.codegraph));
    }
    if (options.plan !== undefined) {
      // plan 三工具（T1.4，AD-6①）：实例工作台账（薄壳调 WorkLedgerService；
      // 仅 SubAgent 子进程本地栈注入，两域同构）
      tools.push(
        createPlanCreateTool(options.plan),
        createPlanUpdateTool(options.plan),
        createPlanReadTool(options.plan),
      );
    }
    if (options.taskCreate !== undefined) {
      // task_create（T2.4，AD-7）：chat 第二创建入口薄壳（与 /project 入口
      // 同一 createTask API；仅 MainAgent 生效集）
      tools.push(createTaskCreateTool(options.taskCreate));
    }
    if (options.taskReport !== undefined) {
      // task_report（D3）：chat 回流通用报告查询面（list/get 只读；
      // 仅 MainAgent 生效集——报告全文不进回执，MainAgent 用 read 按需读）
      tools.push(createTaskReportTool(options.taskReport));
    }
    if (options.taskOps !== undefined) {
      // 任务引擎回口工具族（T2.2，AD-3③）：仅编排主 agent 会话生效集
      tools.push(...createTaskOpsTools(options.taskOps));
    }
    if (options.mcp !== undefined && options.mcp.tools.length > 0) {
      // 第九族（mcp 批）：MCP 动态发现工具——组合根先行发现适配后注入
      //（注册面零 MCP 知识；后注册者胜同内置语义——MCP 追加在末尾，撞名时
      // MCP 覆盖内置；防撞靠 MCP 名带 `${server}__${tool}` 命名空间前缀的
      // 发现面纪律，内置名无前缀不会与之相撞）。
      tools.push(...options.mcp.tools);
    }
    const registry = new Map<string, AgentHarnessTool<ExecutionToolContext, any, any>>();
    for (const tool of tools) registry.set(tool.name, tool);
    this.registry = registry;
  }

  /**
   * 运行期追加工具（mcp 批）：MCP server 到位即推——组合根对活跃会话
   * executor 调用（配合 resources.changed 刷新链的 setTools 直改面）。
   * 同名覆盖（Map.set 幂等语义）；新会话不受影响（构造时现值注入）。
   */
  appendTools(tools: readonly AgentHarnessTool<ExecutionToolContext, any, any>[]): void {
    for (const tool of tools) this.registry.set(tool.name, tool);
  }

  /** profile 声明的工具集 → AgentRuntime 装配用 AgentTool 清单（组合根接线）。 */
  resolveTools(names: readonly string[]): AgentTool<any>[] {
    const resolved: AgentTool<any>[] = [];
    for (const name of names) {
      const tool = this.registry.get(name);
      if (!tool) {
        throw new Error(
          `工具 "${name}" 不在注册表（已注册：${[...this.registry.keys()].join(", ")}）——检查 profile 的 tools 声明`,
        );
      }
      resolved.push(bindToolContext(tool, this.context));
    }
    return resolved;
  }

  async execute(request: ToolCallRequest): Promise<ToolExecutionResult> {
    const tool = this.registry.get(request.toolName);
    if (!tool) {
      return {
        content: `未知工具 "${request.toolName}"（可用：${[...this.registry.keys()].join(", ")}）`,
        isError: true,
      };
    }
    try {
      const result: AgentToolResult<any> = await tool.execute(
        request.toolCallId,
        request.args as never,
        request.signal,
        undefined,
        this.context,
      );
      // 图片下行：工具结果 content 内的 image 块 → images data URL 数组
      //（textOfResult 不动——文本拼接仍是纯文本 + (image) 占位）
      const images = imagesOfContent(result.content);
      return {
        content: textOfResult(result),
        isError: false,
        ...(images.length > 0 ? { images } : {}),
      };
    } catch (error) {
      // 工具以异常表达失败（如 bash exit≠0）：转结构化 error 结果（不抛出——
      // 调用方（service/loop）决定如何记录与回注）
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }
}

/** AgentToolResult.content → 回注文本（text 块拼接；非文本块以占位符标记）。 */
function textOfResult(result: AgentToolResult<any>): string {
  return result.content
    .map((block) => (block as TextContent).type === "text" ? (block as TextContent).text : `(${(block as TextContent).type})`)
    .join("\n");
}
