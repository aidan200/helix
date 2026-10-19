/**
 * 评审 F2 #29：McpClient.stop() 与在途 doConnect 竞态。
 *
 * 缺陷态：stop() 清 piClient/ready 并解绑 closeUnbind 后，piClient.connect 若仍成功
 * 落定，doConnect 尾部无条件置 ready=true → 已停止 client 变 ready=true 且
 * piClient=undefined 的僵死态（后续 listTools/callTool 恒 TypeError 且不自愈）。
 *
 * 测试经 McpClient 的构造接缝注入假 client/transport（不 mock 模块——bun 的
 * mock.module 是进程级替换，会污染同进程后续的真子进程用例）。
 */
import { describe, expect, test } from "bun:test";

import { McpClient } from "../../src/adapters/driven/mcp/McpClient";
import type { McpServerConfig } from "../../src/adapters/driven/mcp/types";

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

const CONFIG: McpServerConfig = { name: "fake-server", command: "fake", args: [] };

function newClient(): McpClient {
  return new McpClient(CONFIG, {
    seams: {
      clientFactory: () => new FakePiClient() as never,
      transportFactory: () => ({ pid: 4242 }) as never,
    },
  });
}

const lastClient = (): FakePiClient => FakePiClient.instances[FakePiClient.instances.length - 1]!;

describe("McpClient.stop() 与在途 connect 竞态（评审 F2 #29）", () => {
  test("stop 在 connect 落定前发生 → 不得置 ready，且孤儿 client 被关闭（不自愈僵死）", async () => {
    const client = newClient();
    const connecting = client.connect();
    const pi = lastClient();

    client.stop(); // 连接仍在途
    pi.resolveConnect(); // 旧连接随后落定
    await connecting.catch(() => {
      // stop 态下请求被取消属预期；不允许的是静默进 ready
    });

    expect(client.isReady()).toBe(false);
    // 孤儿连接必须被关掉（否则 server 进程泄漏）
    expect(pi.closeCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("stop 后再次调用可自愈：新建连接并进入 ready（不再 piClient=undefined 的 TypeError 面）", async () => {
    const client = newClient();
    const connecting = client.connect();
    lastClient().resolveConnect();
    await connecting;
    expect(client.isReady()).toBe(true);
    client.stop();
    expect(client.isReady()).toBe(false);

    // 自愈：下一次调用重建连接（旧实现此处是 TypeError）
    const before = FakePiClient.instances.length;
    const again = client.connect();
    const fresh = lastClient();
    expect(FakePiClient.instances.length).toBe(before + 1);
    fresh.resolveConnect();
    await again;
    expect(client.isReady()).toBe(true);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
  });

  test("在途被 stop 的请求给出明确错误（不是 TypeError 层崩溃）", async () => {
    const client = newClient();
    const connecting = client.connect();
    const pi = lastClient();
    client.stop();
    pi.resolveConnect();
    await expect(connecting).rejects.toThrow(/停止/);
  });
});
