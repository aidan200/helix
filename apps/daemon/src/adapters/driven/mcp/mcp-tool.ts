import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { McpRegistry } from "./McpRegistry";
import type { McpToolDefinition } from "./types";

/**
 * mcp-tool 适配器（mcp 批）：MCP tools/list 产物 → AgentHarnessTool。
 *
 * 核心可行性（方案 §0 已证）：MCP inputSchema = 标准 JSON Schema，
 * pi-ai Tool.parameters（TSchema）与其同构（grep 工具手写 JSON Schema
 * 同款先例）——**零转换透传**，动态发现的 schema 直接进模型工具定义。
 *
 * 命名空间：`${server}__${tool}`（双下划线——shadcn 自身工具名含单下划线，
 * 弱分隔会撞）；description 加 `[mcp:${server}]` 前缀保证归属辨识（MCP
 * description 质量参差，前缀是页面/日志侧的稳定锚）。
 *
 * 执行面：纯薄转投 registry.callNamespacedTool——content 块拼接为文本
 * （image 块占位），isError 转异常（CoreToolExecutor 归一为结构化错误，
 * 同既有工具语义）。
 */

/** content 块拼接：text 块取 text，其余 JSON 序列化占位。 */
function textOfContent(content: unknown[]): string {
  const text = content
    .map((item) =>
      typeof item === "object" && item !== null && "text" in item
        ? String((item as { text: unknown }).text)
        : JSON.stringify(item),
    )
    .join("\n");
  return text || "(no content)";
}

/** 单工具适配（缺 inputSchema 时空对象 schema——无参工具形态；GrepTool 手写 JSON Schema 同款先例，daemon 不直接依赖 typebox）。 */
export function createMcpTool(
  server: string,
  definition: McpToolDefinition,
  registry: McpRegistry,
): AgentHarnessTool<ExecutionToolContext> {
  const namespaced = `${server}__${definition.name}`;
  const description = `[mcp:${server}] ${definition.description ?? definition.name}`;
  const parameters = (definition.inputSchema ?? {
    type: "object",
    properties: {},
  }) as never;
  return {
    name: namespaced,
    label: `${server}: ${definition.name}`,
    description,
    parameters,
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _context: ExecutionToolContext,
    ): Promise<AgentToolResult<unknown>> {
      const result = await registry.callNamespacedTool(namespaced, params);
      if (result.isError) {
        throw new Error(`${namespaced} 执行失败：${textOfContent(result.content)}`);
      }
      return {
        content: [{ type: "text", text: textOfContent(result.content) }],
        details: { server, tool: definition.name },
      };
    },
  };
}

/** 批量适配（McpRegistry.discoveredTools 产物 → AgentHarnessTool[]）。 */
export function createMcpTools(
  discovered: { server: string; definition: McpToolDefinition }[],
  registry: McpRegistry,
): AgentHarnessTool<ExecutionToolContext>[] {
  return discovered.map(({ server, definition }) => createMcpTool(server, definition, registry));
}

// ── deferred 批：meta 发现工具（懒加载装载面）──

/** meta 工具发现回调注入面（组合根接线：物化集登记 + 刷新链触发）。 */
export interface McpDiscoverToolDeps {
  /** 工具名启停读面（toggle 关闭的具名工具不物化不标记；缺省全开）。 */
  isToolEnabled?: (namespacedName: string) => boolean;
  /** 发现物化回调（物化集登记 + resources.changed 发布——刷新链推活跃会话 setTools）。 */
  onDiscover?: (server: string, namespacedNames: string[]) => void;
}

/**
 * meta 工具名（撞名防御）：server 原生工具占用 "discover" 时退
 * `${server}__mcp_discover`；两者均撞（几乎不可达）→ undefined（该
 * server 退化为急发路径——调用方跳过 meta 构造并可告警）。
 */
export function mcpDiscoverToolName(
  server: string,
  rawToolNames: readonly string[],
): string | undefined {
  if (!rawToolNames.includes("discover")) return `${server}__discover`;
  if (!rawToolNames.includes("mcp_discover")) return `${server}__mcp_discover`;
  return undefined;
}

/**
 * 单 server meta 发现工具（deferred 批懒加载入口）：
 * - 模型调用 → content 返回工具清单（name + description 行）；
 * - addedToolNames 标记物化工具（pi deferred 通道：Anthropic
 *   defer_loading / OpenAI additional-tools|tool-search；其余 provider
 *   忽略标记 = 物化后急发，降级不坏）；
 * - onDiscover 同步触发物化链（组合根：物化集 + refreshAssembly）。
 *
 * 参数 schema：无参（空对象——清单即全部信息；避免伪造参数误导模型）。
 */
export function createMcpDiscoverTool(
  server: string,
  rawToolNames: readonly string[],
  descriptions: ReadonlyMap<string, string>,
  deps: McpDiscoverToolDeps,
): AgentHarnessTool<ExecutionToolContext> {
  const name = mcpDiscoverToolName(server, rawToolNames);
  if (name === undefined) {
    throw new Error(`MCP server "${server}" 的 discover/mcp_discover 均被原生工具占用——无法生成 meta 工具`);
  }
  return {
    name,
    label: `${server}: discover`,
    description: `[mcp:${server}] 列出并装载 MCP server "${server}" 的全部可用工具（懒加载入口——装载后本会话可直接调用）`,
    parameters: { type: "object", properties: {} } as never,
    async execute(): Promise<AgentToolResult<unknown>> {
      const enabled = rawToolNames.filter((raw) => {
        const namespaced = `${server}__${raw}`;
        return deps.isToolEnabled?.(namespaced) ?? true;
      });
      const namespacedNames = enabled.map((raw) => `${server}__${raw}`);
      const lines = enabled.map(
        (raw) => `- ${server}__${raw}: ${descriptions.get(raw) ?? raw}`,
      );
      if (enabled.length === 0) {
        return {
          content: [{ type: "text", text: `MCP server "${server}" 当前无可装载工具（全部已停用或未发现）。` }],
          details: { server, count: 0 },
        };
      }
      // 物化链先行（工具池追加 + 刷新链）——标记随结果落地（transcript
      // 重放语义：未调用的物化工具 deferred，调用过转 immediate）。
      deps.onDiscover?.(server, namespacedNames);
      return {
        content: [
          {
            type: "text",
            text:
              `MCP server "${server}" 已装载 ${enabled.length} 个工具（本 turn 起可直接调用）：\n` +
              lines.join("\n"),
          },
        ],
        addedToolNames: namespacedNames,
        details: { server, count: enabled.length },
      };
    },
  };
}

/**
 * 批量 meta 构造（registry 现值）：deferred 位真（缺省）且 running 的
 * server 各一个；撞名不可解的 server 跳过（返回 skipped 供调用方告警）。
 */
export function createMcpDiscoverTools(
  registry: McpRegistry,
  deps: McpDiscoverToolDeps,
): { tools: AgentHarnessTool<ExecutionToolContext>[]; skipped: string[] } {
  const tools: AgentHarnessTool<ExecutionToolContext>[] = [];
  const skipped: string[] = [];
  for (const config of registry.listConfigs()) {
    if (config.enabled === false || config.deferred === false) continue;
    const tools_ = registry.toolsOf(config.name);
    if (tools_.length === 0) continue;
    if (mcpDiscoverToolName(config.name, tools_.map((t) => t.name)) === undefined) {
      skipped.push(config.name);
      continue;
    }
    const descriptions = new Map(tools_.map((t) => [t.name, t.description]));
    tools.push(
      createMcpDiscoverTool(
        config.name,
        tools_.map((t) => t.name),
        descriptions,
        deps,
      ),
    );
  }
  return { tools, skipped };
}
