import {
  type CallToolResult,
  McpClient as PiMcpClient,
  StdioTransport,
  type Tool,
} from "@earendil-works/pi-mcp";
import type { McpCallResult, McpServerConfig, McpToolDefinition } from "./types";
import { workspaceChildEnv } from "../../../infrastructure/workspacePaths";

/**
 * McpClient —— stdio JSON-RPC 常驻客户端薄壳（pi-mcp 驱动层替换批）。
 *
 * 协议/传输/进程回收全部由 @earendil-works/pi-mcp 承担（协议版本协商、
 * tools/list 分页合并、消息体积守卫、stdin error 兜底（TR-140 上游内建）、
 * 进程组 kill tree（负 pid 杀整组——npx/uvx 包装器不留孤儿，E-168 修复）、
 * stderr 64KB 环形上限）。本壳只保留 helix 编排面语义：
 *
 * - 懒重连：进程退出后下次调用 connect/listTools/callTool 重建连接
 *   （pi-mcp client close 后不可复用——每次连接全新 client + transport）；
 * - 主动 stop 不回调 onExit（registry 的意外退出降级只对非 stop 路径；
 *   removeServer/stopAll 时序竞态不依赖事件异步性，显式解绑 close 监听）；
 * - onExit 回调时 isReady() 恒 false（ready 先复位再回调——registry
 *   身份守卫注释钉住的时序前提）。
 *
 * 纯驱动层：无 @helix/protocol 依赖、无 daemon 状态；logger 为本地最小形状
 * （组合根将 infrastructure Logger 直接适配传入——结构兼容；driven 不
 * import infrastructure，同 WriteQueue onError 回调注入纪律）。
 */

/**
 * 驱动层测试接缝（F2 #29 竞态用例需要可控的 connect 时序）：协议/传输本体由
 * pi-mcp 承担，测试不 mock 模块（bun 的 mock.module 是进程级、会污染后续测试
 * 文件的真子进程用例）——经构造参数注入假 client/transport 即可。
 */
export interface McpClientSeams {
  readonly transportFactory?: (config: McpServerConfig, env: Record<string, string>) => StdioTransport;
  readonly clientFactory?: (config: McpServerConfig) => PiMcpClient;
}

/** 驱动层本地日志形状（info/warn/error 文本三方法；组合根适配）。 */
export interface McpLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** pi-mcp Tool → 镜像类型（含 outputSchema 声明面透传）。 */
function toToolDefinition(tool: Tool): McpToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  };
}

/** pi-mcp CallToolResult → 镜像类型（structuredContent 透传——程序化消费者直达）。 */
function toCallResult(result: CallToolResult): McpCallResult {
  return {
    content: result.content as unknown[],
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
  };
}

export class McpClient {
  private piClient?: PiMcpClient;
  private transport?: StdioTransport;
  private ready = false;
  private connecting?: Promise<void>;
  /** 停止代数（F2 #29）：stop() 递增；doConnect 建连在途跨代即判「已停止」，
   *  不得把落定的旧连接标 ready（否则 ready=true 且 piClient=undefined 僵死）。 */
  private stopEpoch = 0;
  private closeUnbind?: () => void;
  private readonly config: McpServerConfig;
  private readonly name: string;
  private readonly logger: McpLogger;
  private readonly onExit?: (code: number | null) => void;
  private readonly seams?: McpClientSeams;

  constructor(
    config: McpServerConfig,
    options?: {
      logger?: McpLogger;
      /** 进程退出回调（registry 降级状态面挂钩；构造方轮询亦可）。 */
      onExit?: (code: number | null) => void;
      /** 测试接缝（缺省走 pi-mcp 真实现）。 */
      seams?: McpClientSeams;
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
    this.seams = options?.seams;
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
    const tools = await this.piClient!.listTools();
    return tools.map(toToolDefinition);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.connect();
    return toCallResult(await this.piClient!.callTool(name, args));
  }

  /**
   * 停止（fire-and-forget 进程回收——进程组 kill tree 序列在 pi-mcp
   * StdioTransport.close 内：stdin end → 500ms 宽限 SIGTERM → SIGKILL）。
   * 同步签名保持 registry 同步消费面（removeServer/stopAll）。
   */
  stop(): void {
    this.stopEpoch += 1;
    const piClient = this.piClient;
    this.piClient = undefined;
    this.transport = undefined;
    this.ready = false;
    this.closeUnbind?.();
    this.closeUnbind = undefined;
    if (!piClient) return;
    void piClient.close().catch((err) => {
      this.logger.warn(`mcp[${this.name}] 停止清理异常：${(err as Error).message}`);
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  /** 底层 server 进程 pid（测试/诊断探针；未连接 undefined）。 */
  get pid(): number | undefined {
    return this.transport?.pid;
  }

  private async doConnect(): Promise<void> {
    if (this.piClient) return;
    const epoch = this.stopEpoch;
    const config = this.config;
    // 落点规范批（2026-10-10）：uvx/npx 类 server 的用户级缓存散落
    // （~/.cache/uv、~/.npm）重定向到 <cwd>/.helix/tool-cache；cwd 基准 =
    // config.cwd 显式值 > daemon 进程 cwd（未绑定 daemon 在不可写 cwd 时
    // mkdir 失败 → 空注入回落继承，不阻断连接）
    const injectedEnv = (() => {
      try {
        return workspaceChildEnv(config.cwd ?? process.cwd());
      } catch {
        return {};
      }
    })();
    // inheritEnv 缺省 true = process.env 合入 config.env（子进程环境继承
    // 语义，与旧实现 {...process.env, ...config.env} 等价）；注入键在
    // config.env 之下（用户显式配置优先）。
    const env = { ...injectedEnv, ...(config.env ?? {}) };
    const transport =
      this.seams?.transportFactory?.(config, env) ??
      new StdioTransport({
        command: config.command,
        args: config.args ?? [],
        cwd: config.cwd ?? process.cwd(),
        env,
        onStderr: (chunk) => {
          const text = chunk.trimEnd();
          if (text) this.logger.info(`mcp[${this.name}] stderr: ${text}`);
        },
      });
    // 每次连接全新 client：pi-mcp client close 后状态机不可复用，懒重连 = 整体重建。
    const piClient =
      this.seams?.clientFactory?.(config) ??
      new PiMcpClient({
        name: "helix",
        version: "0.1.0",
        requestTimeoutMs: config.timeoutMs ?? 30_000,
      });
    // close 监听先于 connect 挂好：连接期进程秒退也能落到意外退出回调。
    this.closeUnbind = piClient.onClose(() => {
      // 意外断线路径（stop 已解绑此监听）：ready 先复位再回调——registry
      // 身份守卫的 isReady() 恒 false 前提（McpRegistry onExit 注释钉住）。
      this.ready = false;
      this.piClient = undefined;
      this.transport = undefined;
      this.closeUnbind = undefined;
      this.logger.info(`mcp[${this.name}] 进程退出`);
      this.onExit?.(null);
    });
    piClient.onError((err) => {
      this.logger.error(`mcp[${this.name}] 进程错误：${err.message}`);
    });
    this.piClient = piClient;
    this.transport = transport;
    try {
      // initialize + notifications/initialized 由 pi-mcp connect 承担
      // （协议版本协商——server 侧回它支持的版本；capabilities 缺省最小
      // 声明：不传 roots，roots/list 请求按协议拒绝）。
      await piClient.connect(transport);
    } catch (err) {
      // initialize 失败：清连接防僵尸，错误上抛（调用方定 error 状态）
      this.stop();
      throw err instanceof Error ? err : new Error(String(err));
    }
    // 竞态守卫（F2 #29）：connect 在途时 stop() 已清空引用——旧连接即便落定也
    // 必须就地关掉并拒绝，绝不置 ready（已停止 client 的 ready 位会与
    // piClient=undefined 组成僵死态，后续调用恒 TypeError 且不自愈）。
    if (this.stopEpoch !== epoch || this.piClient !== piClient) {
      void piClient.close().catch((err) => {
        this.logger.warn(`mcp[${this.name}] 停止期连接回收异常：${(err as Error).message}`);
      });
      throw new Error(`mcp[${this.name}] 连接在途时已被停止（请求取消）`);
    }
    this.ready = true;
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
