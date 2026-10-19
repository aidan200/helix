import type {
  AgentHarnessTool,
  AgentToolResult,
  ExecutionToolContext,
} from "../../../adapters/driven/tools/vendor/pi-harness";
import type { McpRegistry } from "./McpRegistry";
import type { McpToolDefinition } from "./types";

/**
 * mcp-tool 适配器（mcp 批）：MCP tools/list 产物 → AgentHarnessTool。
 *
 * 核心可行性（方案 §0 已证）：MCP inputSchema = 标准 JSON Schema，
 * pi-ai Tool.parameters（TSchema）与其同构（grep 工具手写 JSON Schema
 * 同款先例）——透传进模型工具定义（唯一例外：sanitizer 钳制面，见
 * sanitizeMcpInputSchema——provider 兼容性收口，语义见函数头）。
 *
 * 命名空间：`${server}__${tool}`（双下划线——shadcn 自身工具名含单下划线，
 * 弱分隔会撞）；description 加 `[mcp:${server}]` 前缀保证归属辨识（MCP
 * description 质量参差，前缀是页面/日志侧的稳定锚）。
 *
 * 执行面：纯薄转投 registry.callNamespacedTool——content 块拼接为文本
 * （image 块占位），isError 转异常（CoreToolExecutor 归一为结构化错误，
 * 同既有工具语义）；structuredContent 透传 AgentToolResult.structuredContent
 * （程序化消费者直达，不进模型上下文——codemode 类编排场景的结构化源）。
 */

/**
 * content 块拼接：text 块取 text；image/audio/resource 块占位（二进制
 * base64 原文不进模型上下文——单调用可撑爆上下文）；其余 JSON 序列化。
 */
function textOfContent(content: unknown[]): string {
  const text = content
    .map((item) => {
      if (typeof item !== "object" || item === null) return JSON.stringify(item);
      const block = item as Record<string, unknown>;
      if ("text" in block) return String(block.text);
      const mimeType = typeof block.mimeType === "string" ? block.mimeType : "unknown";
      if (block.type === "image" || block.type === "audio") {
        return `[${block.type} mimeType=${mimeType}]`;
      }
      if (block.type === "resource") {
        const resource = (typeof block.resource === "object" && block.resource !== null
          ? block.resource
          : {}) as Record<string, unknown>;
        const uri = typeof resource.uri === "string" ? resource.uri : "unknown";
        const resMime = typeof resource.mimeType === "string" ? resource.mimeType : mimeType;
        return `[resource uri=${uri} mimeType=${resMime}]`;
      }
      return JSON.stringify(item);
    })
    .join("\n");
  return text || "(no content)";
}

/**
 * MCP inputSchema 钳制面（E-316，2026-10-19 zai 1210 实证）：递归把
 * JSON Schema 的 **tuple 形 `items`**（`"items": [schema, schema, …]`，
 * draft-04/07 位置校验合法形态）改写为对象形 `{anyOf: […]}`。
 *
 * 动机（实证链）：智谱 coding 端点（open.bigmodel.cn，glm-5.3）对 tools
 * 数组做严格 schema 校验，遇 tuple 形 items 直接拒——`400 code 1210
 * "API 调用参数有误"`。触发面即本文件的懒加载物化链：模型调用
 * `${server}__discover` → aseprite 真实工具（validate 含 layerFrames/
 * mustNotOverlap 两处 tuple items）注册 → 下一请求 tools 数组带上它们 →
 * 该会话及共享工具注册表的其余会话全部 1210（同 daemon 跨会话复现）。
 * 清洗后同 schema 实测 200（anyOf 对象形 + 保留 minItems/maxItems——
 * 位置严格性放宽为成员校验，provider 兼容性的最小代价）。
 *
 * 纯函数纪律：深拷贝改写（不动入参）、零 IO、递归全树（properties/
 * items/additionalProperties/anyOf 等一切容器）；非 items 数组不动
 *（enum 等合法数组形态）。空 tuple `items: []` → `{}`（空 schema = 任意）。
 */
export function sanitizeMcpInputSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitizeMcpInputSchema);
  }
  if (typeof node !== "object" || node === null) {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "items" && Array.isArray(value)) {
      out[key] = value.length > 0 ? { anyOf: value.map(sanitizeMcpInputSchema) } : {};
    } else {
      out[key] = sanitizeMcpInputSchema(value);
    }
  }
  return out;
}

/** 单工具适配（缺 inputSchema 时空对象 schema——无参工具形态；GrepTool 手写 JSON Schema 同款先例，daemon 不直接依赖 typebox）。 */
export function createMcpTool(
  server: string,
  definition: McpToolDefinition,
  registry: McpRegistry,
): AgentHarnessTool<ExecutionToolContext> {
  const namespaced = `${server}__${definition.name}`;
  const description = `[mcp:${server}] ${definition.description ?? definition.name}`;
  const parameters = sanitizeMcpInputSchema(definition.inputSchema ?? {
    type: "object",
    properties: {},
  }) as never;
  return {
    name: namespaced,
    label: `${server}: ${definition.name}`,
    description,
    parameters,
    // outputSchema 声明面（S1 类型镜像的落地）：MCP 工具声明了结构化输出时
    // 同步声明到 AgentTool——provider 侧结构化工具面 + codemode 沙箱编排的
    // 脚本值形状（structuredContent 优先于文本拼接）。
    ...(definition.outputSchema === undefined
      ? {}
      : { outputSchema: definition.outputSchema as never }),
    async execute(
      _toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<unknown>> {
      const result = await registry.callNamespacedTool(namespaced, params as Record<string, unknown>);
      if (result.isError) {
        throw new Error(`${namespaced} 执行失败：${textOfContent(result.content)}`);
      }
      return {
        content: [{ type: "text", text: textOfContent(result.content) }],
        details: { server, tool: definition.name },
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: result.structuredContent as never }),
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
 * - 0.87 起 pi agent-loop 每请求前自动宣告 context.tools 与 transcript 声明
 *   的差异（toolsAdded/toolsRemoved system message）——物化链 onDiscover →
 *   refreshAssembly 赋 agent.state.tools 后，模型自动可见新工具，无需
 *   0.85 时代的 addedToolNames 标记（已随 AgentToolResult 移除）；
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
      // 物化链先行（工具池追加 + 刷新链）——刷新后 loop 自动宣告工具差异
      //（transcript 重放语义：未调用的物化工具 deferred，调用过转 immediate）。
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
