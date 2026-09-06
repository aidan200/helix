import { spawn, type ChildProcess } from "node:child_process";
import type { McpCallResult, McpServerConfig, McpToolDefinition } from "./types";

/**
 * McpClient —— stdio JSON-RPC 2.0 常驻客户端（mcp 批；v1 基座升级）。
 *
 * 与 v1（一次性 spawn-call-kill）的差异：连接保活（initialize 一次、
 * 多次 listTools/callTool 复用）+ 懒重连（进程退出后下次调用 connect
 * 重建）。断线语义：exit/error 时 rejectAll 在飞请求；ready 复位——
 * 后续调用触发重连（幂等 connect）。
 *
 * 协议面：initialize（protocolVersion 2024-11-05）+ notifications/initialized
 * + tools/list + tools/call（MCP stdio 传输子集；sse 不实现——shadcn/
 * magicui/官方主流均 stdio）。
 *
 * 纯驱动层：无 @helix/protocol 依赖、无 daemon 状态；logger 为本地最小形状
 * （组合根将 infrastructure Logger 直接适配传入——结构兼容；driven 不
 * import infrastructure，同 WriteQueue onError 回调注入纪律）。
 */

/** 驱动层本地日志形状（info/warn/error 文本三方法；组合根适配）。 */
export interface McpLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** 行缓冲解析（纯函数——单测面）：chunk 流 → 逐行回调，返回残余 buffer。 */
export function parseMcpLines(
  chunk: string,
  lineHandler: (line: string) => void,
  buffer = "",
): string {
  buffer += chunk;
  let index: number;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) lineHandler(line);
  }
  return buffer;
}

export class McpClient {
  private proc?: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private ready = false;
  private connecting?: Promise<void>;
  private readonly config: McpServerConfig;
  private readonly name: string;
  private readonly logger: McpLogger;
  private readonly onExit?: (code: number | null) => void;

  constructor(
    config: McpServerConfig,
    options?: {
      logger?: McpLogger;
      /** 进程退出回调（registry 降级状态面挂钩；构造方轮询亦可）。 */
      onExit?: (code: number | null) => void;
    },
  ) {
    this.config = config;
    this.name = config.name;
    this.logger = options?.logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    this.onExit = options?.onExit;
  }

  /** 建连（幂等——已就绪/在途连接直接复用）。initialize 失败即抛（调用方定状态）。 */
  async connect(): Promise<void> {
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.connect();
    const result = (await this.request("tools/list", {})) as {
      tools?: McpToolDefinition[];
    };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.connect();
    return (await this.request("tools/call", { name, arguments: args })) as McpCallResult;
  }

  stop(): void {
    if (!this.proc) return;
    this.rejectAll(new Error(`MCP server ${this.name} stopped`));
    this.proc.kill();
    this.proc = undefined;
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }

  private async doConnect(): Promise<void> {
    if (this.proc) return;
    const command = this.config.command;
    const args = this.config.args ?? [];
    const env = { ...process.env, ...this.config.env };
    const cwd = this.config.cwd ?? process.cwd();

    this.proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env, cwd });

    // stdin error 兜底监听：子进程死亡到 close 投递的竞态窗口内 write 会
    // 触发 EPIPE/ERR_STREAM_DESTROYED，stream error 无监听 = uncaught 击穿
    // daemon——挂监听吞掉（在飞请求由 close/超时就位拒绝，不丢语义）。
    this.proc.stdin?.on("error", (err) => {
      this.logger.warn(`mcp[${this.name}] stdin 写入错误（进程将退出）：${err.message}`);
    });
    this.proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.logger.info(`mcp[${this.name}] stderr: ${chunk.toString("utf-8").trimEnd()}`);
    });
    this.proc.on("error", (err) => this.onError(err));
    this.proc.on("close", (code) => this.onClose(code));

    try {
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        clientInfo: { name: "helix", version: "0.1.0" },
      });
      this.sendNotification("notifications/initialized", {});
      this.ready = true;
    } catch (err) {
      // initialize 失败：清进程防僵尸，错误上抛（调用方定 error 状态）
      this.stop();
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = parseMcpLines(chunk.toString("utf-8"), (line) => this.handleLine(line), this.buffer);
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.logger.warn(`mcp[${this.name}] 非 JSON 行：${line.slice(0, 200)}`);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message} (code ${message.error.code})`));
      } else {
        pending.resolve(message.result);
      }
    }
    // 通知/请求（server→client 方向）不处理——当前仅消费 tools 族响应
  }

  private onError(err: Error): void {
    this.logger.error(`mcp[${this.name}] 进程错误：${err.message}`);
    this.ready = false;
    this.rejectAll(err);
  }

  private onClose(code: number | null): void {
    this.logger.info(`mcp[${this.name}] 退出（code=${code ?? "null"}）`);
    this.ready = false;
    this.proc = undefined;
    this.rejectAll(new Error(`MCP server ${this.name} exited${code !== null ? ` with code ${code}` : ""}`));
    this.onExit?.(code);
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin) {
        reject(new Error(`MCP server ${this.name} 未运行`));
        return;
      }
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server ${this.name} 请求超时：${method}`));
      }, this.config.timeoutMs ?? 30000);
      this.pending.set(id, { resolve, reject, timeout });
      const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      this.proc.stdin.write(`${JSON.stringify(req)}\n`);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.proc || !this.proc.stdin) return;
    const note: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.proc.stdin.write(`${JSON.stringify(note)}\n`);
  }
}

/** 一次性试连（不注册不保活）：连接 → tools/list → 断开，返回工具清单。 */
export async function probeMcpServer(
  config: McpServerConfig,
  logger?: McpLogger,
): Promise<McpToolDefinition[]> {
  const client = new McpClient(config, { logger });
  try {
    return await client.listTools();
  } finally {
    client.stop();
  }
}
