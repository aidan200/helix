/**
 * MCP server 管理出口端口（outbound，mcp 批）。
 *
 * 域形状接口：零 MCP 协议符号——方法面只有 server/工具名等业务概念，
 * stdio JSON-RPC 细节全部收敛在 driven 实现（adapters/driven/mcp/
 * McpRegistry）。driving 层（handlers/mcp.ts）经本 port 消费，组合根
 * 注入 McpRegistry 单例（结构满足，BrowserPort 同构先例）。
 *
 * 配置持久化不在本 port——声明面 = helix.db mcp_server 表（整段替换
 * 写经 WriteQueue 单写通道，序列化/规范化在 McpConfigStore；config.json
 * 不再承载 MCP 声明面）。handler 经 McpCommandContext 的窄写面（组合根
 * 闭包包 saveServers）操作，与 registry 生命周期解耦（落盘与连接是
 * 两个关注点）。
 */

/** server 配置行（config 声明面；add/update/test 共用输入形状）。 */
export interface McpServerConfigInput {
  /** server 标识键——同时是工具命名空间前缀（`${name}__${tool}`）。 */
  readonly name: string;
  /** 启动命令（stdio）。 */
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** 缺省 true；false = 配置保留但不连接不接入。 */
  readonly enabled?: boolean;
  /** 单请求超时毫秒（缺省 30000）。 */
  readonly timeoutMs?: number;
}

/** server 运行态行（与协议 McpServerStatusDto 同形；DTO 映射归 handler）。 */
export interface McpServerStatusInfo {
  readonly name: string;
  readonly state: "idle" | "connecting" | "running" | "error" | "stopped";
  readonly toolCount?: number;
  readonly lastError?: string;
}

/** 已发现工具摘要行（tools.list 读面；inputSchema 不出驱动层）。 */
export interface McpToolSummary {
  readonly name: string;
  readonly description: string;
}

export type McpStatusListener = (status: McpServerStatusInfo) => void;

/** add/update/remove 写面回执（与协议 McpMutationResultPayload 内核同形）。 */
export interface McpMutationOutcome {
  readonly status: "applied" | "connect_failed";
  readonly server?: McpServerStatusInfo;
  readonly error?: string;
}

export interface McpServerPort {
  /** 新增/覆盖 server：连接 → 发现 → running；失败降级 error（配置保留可重试）。 */
  addServer(config: McpServerConfigInput): Promise<McpServerStatusInfo>;
  /** 移除 server：断连 + 摘工具 + stopped 广播（未知名返回 false）。 */
  removeServer(name: string): boolean;
  /** 试连（不注册不落盘）：返回工具摘要清单；失败抛错。 */
  testServer(config: McpServerConfigInput): Promise<McpToolSummary[]>;
  /** 全部 server 配置（含 enabled=false）。 */
  listConfigs(): readonly McpServerConfigInput[];
  /** 全部 server 状态快照。 */
  getStatuses(): readonly McpServerStatusInfo[];
  /** 指定 server 已发现工具摘要（命名空间前工具名）。 */
  toolsOf(name: string): readonly McpToolSummary[];
  /** 状态订阅（返回退订函数）。 */
  onStatusChange(listener: McpStatusListener): () => void;
}
