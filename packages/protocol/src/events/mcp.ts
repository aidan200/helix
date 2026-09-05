/**
 * mcp 族事件（mcp 批：MCP server 标准接入；契约 = PROTOCOL-CHANGELOG.md §26）。
 *
 * 帧分工（七帧）：
 * - mcp.servers.list.result：mcp.servers.list 点对点回执（TR-AD-21 模式，
 *   仅发发起连接；信封 sessionId = SYSTEM_SESSION_ID——全局命令会话无关）；
 * - mcp.servers.add.result / mcp.servers.update.result / mcp.servers.remove.result：
 *   CRUD 写面回执（点对点；工具面生效经 resources.changed → agent.config.changed
 *   既有刷新链，不在本帧重复广播）；
 * - mcp.servers.test.result：试连回执（点对点；applied/failed 两判别，不落盘）；
 * - mcp.tools.list.result：指定 server 工具清单回执（点对点）；
 * - mcp.status.changed：server 状态迁移广播（connecting → running/error；
 *   SYSTEM_SESSION_ID 全连接下发，与 web.status.changed 同构——设置页徽标
 *   实时数据源）。
 */
import type { EventFrame } from "../envelope";
import type { McpServerInput } from "../commands";

/** MCP server 运行状态（与 daemon McpRegistry 状态机对齐）。 */
export type McpServerRuntimeState = "idle" | "connecting" | "running" | "error" | "stopped";

/** server 配置详情（list 回执内嵌；形态 = McpServerInput 同形 + name 必填）。 */
export interface McpServerConfigDto extends McpServerInput {
  name: string;
}

/** server 运行态行（list 回执 / status.changed 广播共用形状）。 */
export interface McpServerStatusDto {
  name: string;
  state: McpServerRuntimeState;
  /** 已发现工具数（running 时 ≥ 0；其它态缺席）。 */
  toolCount?: number;
  /** state="error" 时的最近错误说明。 */
  lastError?: string;
}

/** 已发现工具行（tools.list 回执；name 为命名空间后全名 `${server}__${tool}`）。 */
export interface McpToolInfoDto {
  name: string;
  description: string;
}

/** mcp.servers.list.result 载荷：配置详情 + 运行态合并行。 */
export interface McpServersListResultPayload {
  servers: {
    config: McpServerConfigDto;
    status: McpServerStatusDto;
  }[];
}

/** mcp.servers.add / update / remove.result 载荷：写面回执。 */
export interface McpMutationResultPayload {
  status: "applied" | "connect_failed";
  /** 变更后该 server 运行态（connect_failed 时 state="error"，配置已落盘可重试）。 */
  server?: McpServerStatusDto;
  /** status="connect_failed" 时的失败原因。 */
  error?: string;
}

/** mcp.servers.test.result 载荷：试连回执（不落盘不接入）。 */
export interface McpTestResultPayload {
  status: "applied" | "failed";
  /** 试连发现的工具数（applied 时携带）。 */
  toolCount?: number;
  /** 失败原因（failed 时携带）。 */
  error?: string;
}

/** mcp.tools.list.result 载荷：指定 server 的工具清单。 */
export interface McpToolsListResultPayload {
  server: string;
  tools: McpToolInfoDto[];
}

/** mcp.status.changed 载荷：状态迁移广播（单 server 粒度）。 */
export interface McpStatusChangedPayload {
  server: McpServerStatusDto;
}

export interface McpServersListResultEvent
  extends EventFrame<McpServersListResultPayload> {
  channel?: "mcp";
  type: "mcp.servers.list.result";
}

export interface McpServersAddResultEvent
  extends EventFrame<McpMutationResultPayload> {
  channel?: "mcp";
  type: "mcp.servers.add.result";
}

export interface McpServersUpdateResultEvent
  extends EventFrame<McpMutationResultPayload> {
  channel?: "mcp";
  type: "mcp.servers.update.result";
}

export interface McpServersRemoveResultEvent
  extends EventFrame<McpMutationResultPayload> {
  channel?: "mcp";
  type: "mcp.servers.remove.result";
}

export interface McpServersTestResultEvent
  extends EventFrame<McpTestResultPayload> {
  channel?: "mcp";
  type: "mcp.servers.test.result";
}

export interface McpToolsListResultEvent
  extends EventFrame<McpToolsListResultPayload> {
  channel?: "mcp";
  type: "mcp.tools.list.result";
}

export interface McpStatusChangedEvent
  extends EventFrame<McpStatusChangedPayload> {
  channel?: "mcp";
  type: "mcp.status.changed";
}
