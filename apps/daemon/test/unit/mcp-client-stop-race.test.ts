/**
 * 评审 F2 #29：McpClient.stop() 与在途 doConnect 竞态。
 *
 * 缺陷态：stop() 清 piClient/ready 并解绑 closeUnbind 后，piClient.connect 若仍成功
 * 落定，doConnect 尾部无条件置 ready=true → 已停止 client 变 ready=true 且
 * piClient=undefined 的僵死态（后续 listTools/callTool 恒 TypeError 且不自愈）。
 *
 * 本文件以 mock.module 替换 @earendil-works/pi-mcp 驱动层（协议/传输全在驱动层，
 * 本壳只保编排语义）——用可控 deferred 把 connect 的落定时机握在测试手里。
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";

/** 受控 pi-mcp client 假体：connect() 由测试侧 deferred 决定何时落定。 */
class FakePiClient {
  static instances: FakePiClient[] = [];
  readonly closeCalls: number[] = [];
  resolveConnect!: () => void;
  rejectConnect!: (err: Error) => void;
  private readonly connectGate: Promise<void>;
  private closeHandler: (() => void) | undefined;
  listToolsCalls = 0;

  constructor() {
    FakePiClient.instances.push(this);
    this.connectGate = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
  }

  async connect(): Promise<void> {
    await this.connectGate;
  }

  onClose(handler: () => void): () => void {
    this.closeHandler = handler;
    return () => {
      this.closeHandler = undefined;
    };
  }

  onError(): void {
    // no-op（错误日志面不在断言范围）
  }

  async close(): Promise<void> {
    this.closeCalls.push(Date.now());
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema: unknown }[]> {
    this.listToolsCalls += 1;
    return [{ name: "echo", inputSchema: { type: "object" } }];
  }

  async callTool(): Promise<{ content: unknown[] }> {
    return { content: [] };
  }
}

class FakeTransport {
  pid = 4242;
  async close(): Promise<void> {
    // no-op
  }
}

mock.module("@earendil-works/pi-mcp", () => ({ McpClient: FakePiClient, StdioTransport: FakeTransport }));

let McpClientCtor: typeof import("../../src/adapters/driven/mcp/McpClient").McpClient;

beforeAll(async () => {
  ({ McpClient: McpClientCtor } = await import("../../src/adapters/driven/mcp/McpClient"));
});

const CONFIG = { name: "fake-server", command: "fake", args: [] as string[] };

describe("McpClient.stop() 与在途 connect 竞态（评审 F2 #29）", () => {
  test("stop 在 connect 落定前发生 → 不得置 ready，且孤儿 client 被关闭（不自愈僵死）", async () => {
    const client = new McpClientCtor(CONFIG as never);
    const connecting = client.connect();
    const pi = FakePiClient.instances[FakePiClient.instances.length - 1]!;

    client.stop(); // 连接仍在途
    pi.resolveConnect(); // 旧连接随后落定
    await connecting.catch(() => {
      // stop 态下请求被取消属预期（错误文案见下）；不允许的是静默进 ready
    });

    expect(client.isReady()).toBe(false);
    // 孤儿连接必须被关掉（否则 server 进程泄漏）
    expect(pi.closeCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("stop 后再次调用可自愈：新建连接并进入 ready（不再 piClient=undefined 的 TypeError 面）", async () => {
    const client = new McpClientCtor(CONFIG as never);
    const connecting = client.connect();
    FakePiClient.instances[FakePiClient.instances.length - 1]!.resolveConnect();
    await connecting;
    expect(client.isReady()).toBe(true);
    client.stop();
    expect(client.isReady()).toBe(false);

    // 自愈：下一次调用重建连接（旧实现此处是 TypeError）
    const before = FakePiClient.instances.length;
    const again = client.connect();
    const fresh = FakePiClient.instances[FakePiClient.instances.length - 1]!;
    expect(FakePiClient.instances.length).toBe(before + 1);
    fresh.resolveConnect();
    await again;
    expect(client.isReady()).toBe(true);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
  });

  test("在途被 stop 的请求给出明确错误（不是 TypeError 层崩溃）", async () => {
    const client = new McpClientCtor(CONFIG as never);
    const connecting = client.connect();
    const pi = FakePiClient.instances[FakePiClient.instances.length - 1]!;
    client.stop();
    pi.resolveConnect();
    await expect(connecting).rejects.toThrow(/停止/);
  });
});
