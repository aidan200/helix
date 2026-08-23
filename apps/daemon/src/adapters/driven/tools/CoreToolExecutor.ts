import type {
  AgentHarnessTool,
  AgentTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { TextContent } from "@earendil-works/pi-ai";
import {
  createBashTool,
  createEditTool,
  createReadTool,
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
import { createWebSearchTool } from "./web/WebSearchTool";
import { createWebFetchTool } from "./web/WebFetchTool";
import { createBrowserTool } from "./web/BrowserTools";
import { createAgentSpawnTool, createAgentSendTool, createAgentStatusTool, createAgentInspectTool } from "./agent/AgentOrchestrationTools";
import { imagesOfContent } from "../../../application/services/images";

/**
 * CoreToolExecutor —— ToolExecutorPort 的真实现（architecture.md §3.4，
 * 落位 adapters/driven/tools，AD-17/AD-10）。
 *
 * 两件事：
 * 1. **执行**（ToolExecutorPort.execute）：service 层工具编排的出口——
 *    按名查找注册表工具并真实执行（bash/edit/read/write 四工具来自
 *    `pi-agent-core/node` 内置，ExecutionEnv 用其 Node 实现；grep 为
 *    自写，同 env 同沙箱 cwd）。
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

export interface CoreToolExecutorOptions {
  /** 工具沙箱 cwd（相对路径的解析根；daemon 侧为进程工作区，测试指向 tmp）。 */
  readonly cwd: string;
  /** shell 覆盖（透传 NodeExecutionEnv；测试/特殊环境用）。 */
  readonly shellPath?: string;
  readonly shellEnv?: Record<string, string>;
  /**
   * 编排端口：提供则注册 agent_spawn/agent_send/agent_status/agent_inspect 四工具
   * （经 port 回 SchedulerService，TR-AD-9）；缺省不注册（SubAgent 子进程
   * 装配/无编排场景的 profile 不声明这四名）。
   */
  readonly orchestration?: AgentOrchestrationPort;
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
   * 经此注入 rg 路径与降级 warning 面；缺省 = 定格内置 TS——ChildMain
   * 子进程装配不走组合根定格，恒为 ts）。
   */
  readonly grep?: GrepToolDeps;
}

export class CoreToolExecutor implements ToolExecutorPort {
  private readonly context: ExecutionToolContext;
  private readonly registry: ReadonlyMap<string, AgentHarnessTool<ExecutionToolContext, any, any>>;

  constructor(options: CoreToolExecutorOptions) {
    const env = new NodeExecutionEnv({
      cwd: options.cwd,
      shellPath: options.shellPath,
      shellEnv: options.shellEnv,
    });
    this.context = { env };
    const tools: AgentHarnessTool<ExecutionToolContext, any, any>[] = [
      createBashTool(),
      createReadTool(),
      createWriteTool(),
      createEditTool(),
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
      );
    }
    if (options.browser !== undefined) {
      tools.push(createBrowserTool(options.browser, options.ownerId ?? "main"));
    }
    const registry = new Map<string, AgentHarnessTool<ExecutionToolContext, any, any>>();
    for (const tool of tools) registry.set(tool.name, tool);
    this.registry = registry;
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
