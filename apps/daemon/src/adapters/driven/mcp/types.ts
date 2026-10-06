/**
 * MCP 驱动层类型（mcp 批：标准 MCP server 接入）。
 *
 * 职责边界：MCP 协议事实的本地镜像——server 配置、tools/list 发现产物、
 * tools/call 结果、运行态。daemon 侧命名空间（`${server}__${tool}`）在
 * mcp-tool.ts 适配器落地，协议面 DTO（McpServerStatusDto 等）由 driving
 * 层映射，本层零 @helix/protocol 依赖（driven 不 import protocol 类型面
 * 的既有纪律——DTO 映射归 handler）。
 */

/** MCP server 配置（helix.db mcp_server 表行——config 列 JSON 载体，声明面已从 config.json mcpServers 段迁表）。 */
export interface McpServerConfig {
  /** server 标识键——同时是工具命名空间前缀（`${name}__${tool}`）。 */
  name: string;
  /** 启动命令（stdio 传输）。 */
  command: string;
  /** 启动参数。 */
  args?: string[];
  /** 子进程环境变量（合入 process.env）。 */
  env?: Record<string, string>;
  /** 子进程工作目录（缺省 = daemon cwd）。 */
  cwd?: string;
  /** 是否启用（缺省 true；false = 配置保留但不连接不接入）。 */
  enabled?: boolean;
  /** 单请求超时毫秒（缺省 30000）。 */
  timeoutMs?: number;
  /**
   * 懒加载开关（deferred 批，缺省 true）：true = 具体工具不进初始生效集，
   * 经 `${server}__discover` meta 工具按需装载（addedToolNames + 工具池
   * 物化）；false = 全量急发（mcp 批现状）。见 PROTOCOL-CHANGELOG §28。
   */
  deferred?: boolean;
}

/**
 * MCP tools/list 发现的工具定义（inputSchema = 标准 JSON Schema，透传 pi-ai）。
 *
 * outputSchema：MCP 结构化结果契约声明（pi-mcp 透传；pi-ai Tool 无此槽，
 * 消费面留 codemode 切片——当前仅类型镜像）。
 */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

/**
 * MCP tools/call 结果（content 块数组 + isError）。
 *
 * structuredContent：server 声明 outputSchema 时返回的结构化结果——
 * 透传至 AgentToolResult.structuredContent（程序化消费者直达，不进模型上下文）。
 */
export interface McpCallResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** server 运行态（registry 状态机；DTO 同形由 handler 映射）。 */
export interface McpServerStatus {
  name: string;
  state: "idle" | "connecting" | "running" | "error" | "stopped";
  /** running 时已发现工具数。 */
  toolCount?: number;
  /** state=error 时的最近错误。 */
  lastError?: string;
}

/** server 状态订阅回调（mcp.status.changed 广播的数据源）。 */
export type McpStatusListener = (status: McpServerStatus) => void;
