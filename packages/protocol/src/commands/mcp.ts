/** MCP 接入域命令族：mcp.servers.* 六命令（全局命令，信封 sessionId 省略）。 */
import type { CommandFrame } from "../envelope";
import type { EmptyPayload } from "./session";

// ── mcp 批：MCP server 标准接入（六命令；全局命令信封 sessionId 省略，同 web 族；
//    契约 = PROTOCOL-CHANGELOG.md §26）──

/** MCP server 配置输入（add/update/test 共用；name 为标识键）。 */
export interface McpServerInput {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  timeoutMs?: number;
  /**
   * 懒加载开关（deferred 批）：true = 工具不进初始生效集，经
   * `<server>__discover` meta 工具按需装载（addedToolNames + 工具池
   * 物化——pi deferred tools 通道）；false = 全量急发（现状语义）。
   * 缺省 true。additive 可选位（CHANGELOG §28）。
   */
  deferred?: boolean;
}

/**
 * mcp.servers.list 载荷：全部 server 状态读面（全局命令；无参）。
 * 回执 = mcp.servers.list.result 点对点（TR-AD-21 模式）：配置详情 +
 * 运行态（status/toolCount/lastError）；状态实时变化经 mcp.status.changed 广播。
 */
export interface McpServersListCommand extends CommandFrame<EmptyPayload> {
  type: "mcp.servers.list";
}

/** mcp.servers.add 载荷：新增 server（落盘 + 连接 + 发现 + 刷新链）。 */
export interface McpServersAddCommand extends CommandFrame<McpServerInput> {
  type: "mcp.servers.add";
}

/** mcp.servers.update 载荷：按 name 覆盖配置（重连刷新）。 */
export interface McpServersUpdateCommand extends CommandFrame<McpServerInput> {
  type: "mcp.servers.update";
}

/** mcp.servers.remove 载荷：断连 + 摘工具 + 落盘 + 刷新链。 */
export interface McpServersRemoveCommand extends CommandFrame<{ name: string }> {
  type: "mcp.servers.remove";
}

/** mcp.servers.test 载荷：试连（不落盘不接入——配置页「测试连接」）。 */
export interface McpServersTestCommand extends CommandFrame<McpServerInput> {
  type: "mcp.servers.test";
}

/** mcp.tools.list 载荷：指定 server 的工具清单（name/description）。 */
export interface McpToolsListCommand extends CommandFrame<{ server: string }> {
  type: "mcp.tools.list";
}

/**
 * 命令信封联合（判别式：type 字段窄化）。成员与 COMMAND_TYPES 常量一一
 * 对应，由 catalog.test.ts 双向一致性断言机械守护——不记手维护批次计数链
 * （曾漂移失真）；批次史见 PROTOCOL-CHANGELOG.md。
 */
