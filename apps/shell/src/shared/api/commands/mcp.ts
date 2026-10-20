/**
 * shared/api/commands/mcp —— mcp 域（MCP server 配置 CRUD/试连 + 工具清单读面）。
 *
 * 单源归属（E-84 修订 · 体量门 P3）：本模块 = 该域命令构造器的唯一实现
 * 位置（自 shared/api/commands.ts 按命令域机械迁出，零语义改动）；公共
 * API 面经 shared/api/commands.ts barrel 精确再导出（import 路径不变）。
 * 形状直引 @helix/protocol（AG-13）。
 */

import { PROTOCOL_VERSION } from "@helix/protocol";
import type {
  McpServerInput,
  McpServersAddCommand,
  McpServersListCommand,
  McpServersRemoveCommand,
  McpServersTestCommand,
  McpServersUpdateCommand,
  McpToolsListCommand,
} from "@helix/protocol";

// ── mcp 族命令（mcp 批：MCP server 标准接入；六命令全全局命令）────
// 回执 = mcp.*.result 点对点；状态迁移经 mcp.status.changed 全局广播
//（设置页 server 徽标实时数据源）。

/** mcp.servers.list：全部 server 配置+运行态读面。 */
export function mcpServersListCommand(): McpServersListCommand {
  return { v: PROTOCOL_VERSION, type: "mcp.servers.list", payload: {} };
}

/** mcp.servers.add：新增 server（落盘+连接+发现；applied/connect_failed 两判别）。 */
export function mcpServersAddCommand(payload: McpServerInput): McpServersAddCommand {
  return { v: PROTOCOL_VERSION, type: "mcp.servers.add", payload };
}

/** mcp.servers.update：按 name 覆盖配置（断旧连重连）。 */
export function mcpServersUpdateCommand(payload: McpServerInput): McpServersUpdateCommand {
  return { v: PROTOCOL_VERSION, type: "mcp.servers.update", payload };
}

/** mcp.servers.remove：断连+摘工具+落盘。 */
export function mcpServersRemoveCommand(payload: { name: string }): McpServersRemoveCommand {
  return { v: PROTOCOL_VERSION, type: "mcp.servers.remove", payload };
}

/** mcp.servers.test：试连（不落盘不接入；applied/failed 两判别）——配置
 *  页「测试连接」。 */
export function mcpServersTestCommand(payload: McpServerInput): McpServersTestCommand {
  return { v: PROTOCOL_VERSION, type: "mcp.servers.test", payload };
}

/** mcp.tools.list：指定 server 已发现工具清单（命名空间后全名）。 */
export function mcpToolsListCommand(payload: { server: string }): McpToolsListCommand {
  return { v: PROTOCOL_VERSION, type: "mcp.tools.list", payload };
}
