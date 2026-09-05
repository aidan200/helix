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
