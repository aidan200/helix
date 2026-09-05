import { McpClient, probeMcpServer, type McpLogger } from "./McpClient";
import type {
  McpCallResult,
  McpServerConfig,
  McpServerStatus,
  McpStatusListener,
  McpToolDefinition,
} from "./types";
import type { McpServerPort } from "../../../application/ports/outbound/McpServerPort";

/**
 * McpRegistry —— 多 server 注册表（mcp 批：标准 MCP 接入的运行期可变面）。
 *
 * 职责：server 生命周期（add/remove/预热）+ 工具发现聚合 + 命名空间路由
 * （callTool 按 `${server}__${tool}` 前缀拆分）+ 状态订阅（mcp.status.changed
 * 广播数据源）。**纯驱动层无状态快照语义**——「工具面生效」由组合根经
 * resources.changed 刷新链完成（本层只发现在，不碰 ResourceService）。
 *
 * 并发语义：addServer 同名幂等覆盖（断旧连重连）；单 server 失败不阻塞
 * 其它（各 server 独立 try/catch，error 状态留痕）。
 */

interface ServerEntry {
  config: McpServerConfig;
  client: McpClient;
  status: McpServerStatus;
  /** 已发现工具（running 时非空数组；命名空间前工具名——适配器加前缀）。 */
  tools: McpToolDefinition[];
}

export class McpRegistry implements McpServerPort {
  private readonly servers = new Map<string, ServerEntry>();
  private readonly listeners = new Set<McpStatusListener>();
  private readonly logger: McpLogger;

  constructor(options?: { logger?: McpLogger }) {
    this.logger = options?.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  /** 状态订阅（返回退订函数）。 */
  onStatusChange(listener: McpStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publishStatus(status: McpServerStatus): void {
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (err) {
        this.logger.warn(`mcp 状态监听器异常：${(err as Error).message}`);
      }
    }
  }

  private setStatus(entry: ServerEntry, patch: Partial<McpServerStatus>): void {
    entry.status = { ...entry.status, ...patch };
    this.publishStatus(entry.status);
  }

  /**
   * 新增/覆盖 server：断旧连（同名）→ 连接 → tools/list 发现 → running。
   * 连接失败：entry 保留（state=error，lastError 留痕）——配置已落盘的
   * server 可重试（下次 addServer/update 或预热扫描）。
   */
  async addServer(config: McpServerConfig): Promise<McpServerStatus> {
    this.removeServer(config.name, { silent: true });
    if (config.enabled === false) {
      const entry: ServerEntry = {
        config,
        client: new McpClient(config, { logger: this.logger }),
        status: { name: config.name, state: "idle" },
        tools: [],
      };
      this.servers.set(config.name, entry);
      this.publishStatus(entry.status);
      return entry.status;
    }
    const entry: ServerEntry = {
      config,
      client: new McpClient(config, {
        logger: this.logger,
        onExit: (code) => {
          // 常驻进程意外退出（非 stop 主动路径）：降级 error——下次调用懒重连
          const current = this.servers.get(config.name);
          if (current && current.client.isReady() === false && current.status.state === "running") {
            this.setStatus(current, {
              state: "error",
              lastError: `server 进程意外退出（code=${code ?? "null"}），下次调用自动重连`,
            });
          }
        },
      }),
      status: { name: config.name, state: "connecting" },
      tools: [],
    };
    this.servers.set(config.name, entry);
    this.publishStatus(entry.status);
    return this.discover(entry);
  }

  /** 连接 + 发现（addServer 主路径与重试共用）。 */
  private async discover(entry: ServerEntry): Promise<McpServerStatus> {
    try {
      const tools = await entry.client.listTools();
      entry.tools = tools;
      this.setStatus(entry, { state: "running", toolCount: tools.length, lastError: undefined });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.client.stop();
      this.setStatus(entry, { state: "error", lastError: message, toolCount: undefined });
    }
    return entry.status;
  }

  /** 移除 server：断连 + 清 entry + stopped 状态广播（幂等——未知名 no-op 返回 false）。 */
  removeServer(name: string, options?: { silent?: boolean }): boolean {
    const entry = this.servers.get(name);
    if (!entry) return false;
    entry.client.stop();
    this.servers.delete(name);
    if (!options?.silent) {
      this.publishStatus({ name, state: "stopped" });
    }
    return true;
  }

  /**
   * 试连（不落盘不注册）：返回发现工具摘要；失败抛错（调用方定回执）。
   * 返回形状对齐 McpServerPort.testServer（description 缺省串——port 承诺
   * 非 undefined，DTO 边界单点收敛）。
   */
  async testServer(config: McpServerConfig): Promise<{ name: string; description: string }[]> {
    const tools: McpToolDefinition[] = await probeMcpServer(config, this.logger);
    return tools.map((t) => ({ name: t.name, description: t.description ?? "" }));
  }

  /** 全部 server 配置（含 enabled=false）。 */
  listConfigs(): McpServerConfig[] {
    return [...this.servers.values()].map((e) => e.config);
  }

  /** 全部 server 状态快照。 */
  getStatuses(): McpServerStatus[] {
    return [...this.servers.values()].map((e) => ({ ...e.status }));
  }

  /** 指定 server 已发现工具（命名空间前工具名 + description）。 */
  toolsOf(name: string): { name: string; description: string }[] {
    const entry = this.servers.get(name);
    if (!entry) return [];
    return entry.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
    }));
  }

  /**
   * 全部 running server 的工具定义（适配器输入）：
   * `{ server, definition }[]`——命名空间在适配器落地。
   */
  discoveredTools(): { server: string; definition: McpToolDefinition }[] {
    const out: { server: string; definition: McpToolDefinition }[] = [];
    for (const entry of this.servers.values()) {
      if (entry.status.state !== "running") continue;
      for (const definition of entry.tools) {
        out.push({ server: entry.config.name, definition });
      }
    }
    return out;
  }

  /**
   * 命名空间工具调用（适配器 execute 的转投目标）：
   * `shadcn__search_items` → server "shadcn" 的 `search_items`。
   * 未知前缀/工具名抛错（CoreToolExecutor 转 isError）。
   */
  async callNamespacedTool(
    namespaced: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const sep = namespaced.indexOf("__");
    if (sep <= 0) {
      throw new Error(`MCP 工具名 "${namespaced}" 缺少命名空间（期望 ${"<server>"}__${"<tool>"} 形态）`);
    }
    const serverName = namespaced.slice(0, sep);
    const toolName = namespaced.slice(sep + 2);
    const entry = this.servers.get(serverName);
    if (!entry) {
      throw new Error(`MCP server "${serverName}" 不存在（工具 ${namespaced}）`);
    }
    if (entry.config.enabled === false) {
      throw new Error(`MCP server "${serverName}" 已停用（enabled=false）`);
    }
    return entry.client.callTool(toolName, args);
  }

  /** 全停（daemon shutdown 收尾）。 */
  stopAll(): void {
    for (const entry of this.servers.values()) {
      entry.client.stop();
    }
    this.servers.clear();
  }
}
