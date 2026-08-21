import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createDaemon, type Daemon } from "../../src/infrastructure/container";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

/**
 * T9 图片上下行 WS 集成（契约 v0.10）：
 * - 上行：chat.send 携带 images → FakeAgentEngine 收到 ImageContent（数量/
 *   mimeType）+ chat.message.completed 帧 entry.images + 快照重建含 images；
 * - 超限回执：>4 张 → connection.error 点对点中文报错，零副作用（不落消息
 *   不驱动引擎）。
 */

interface Frame {
  v: FrameVersion;
  type: string;
  payload: Record<string, unknown>;
  sessionId?: string;
  channel?: string;
}

class TestClient {
  readonly frames: Frame[] = [];
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev: MessageEvent) => {
      this.frames.push(JSON.parse(String(ev.data)) as Frame);
    };
  }

  async open(timeoutMs = 3000): Promise<void> {
    await until(() => this.ws.readyState === WebSocket.OPEN, timeoutMs, "WS 连接建立");
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  async expect(type: string, timeoutMs = 3000): Promise<Frame> {
    await until(() => this.frames.some((f) => f.type === type), timeoutMs, `等待帧 ${type}（已收：${this.frames.map((f) => f.type).join(",")}）`);
    return this.frames.find((f) => f.type === type)!;
  }

  async close(): Promise<void> {
    this.ws.close();
  }
}

async function until(cond: () => boolean, timeoutMs = 2000, what = "条件成立"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时（${timeoutMs}ms）：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "helix-t9-images-"));
}

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const TINY_JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

interface Rig {
  home: string;
  daemon: Daemon;
  engine: FakeAgentEngine;
  token: string;
  url: string;
}

async function makeRig(home: string): Promise<Rig> {
  const engine = new FakeAgentEngine({ replies: [{ text: "已看到图片。" }] });
  const daemon = await createDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    subagentRunner: {
      setCallbacks: () => {},
      launch: () => {},
      send: () => {},
    },
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
  });
  const token = readFileSync(path.join(home, "dev-token"), "utf8");
  return { home, daemon, engine, token, url: `ws://127.0.0.1:${daemon.ws.port}` };
}

function hello(token: string): unknown {
  return { v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } };
}

describe("T9 图片上行 WS 集成（契约 v0.10）", () => {
  test("chat.send 带图：引擎收到 ImageContent + 事件/快照 entry.images 全链不丢", async () => {    const home = tmpHome();
    const rig = await makeRig(home);
    const client = new TestClient(rig.url);
    try {
      await client.open();
      client.send(hello(rig.token));
      await client.expect("connection.welcome");

      // 草稿首条带图（契约 B §1.5 建会话链 + v0.10 images）
      client.send({
        v: PROTOCOL_VERSION,
        type: "chat.send",
        payload: { text: "看这两张图", draft: true, images: [TINY_PNG, TINY_JPEG] },
      });
      const snapshot = await client.expect("session.snapshot");

      // 引擎收到 ImageContent（数量/顺序/mimeType——FakeAgentEngine capture）
      const captured = rig.engine.lastPromptImages;
      expect(captured).toHaveLength(2);
      expect(captured?.[0]).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(captured?.[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });

      await client.expect("chat.turn.completed");

      // 快照（投影重建）entries 含 images——草稿链客户端切会话即见 user 气泡缩略图数据源；
      // assistant 消息不携带 images（不产图）
      const snap = (snapshot.payload as { snapshot: { entries: { kind: string; role?: string; images?: string[] }[] } }).snapshot;
      const userEntry = snap.entries.find((e) => e.kind === "message" && e.role === "user");
      expect(userEntry?.images).toEqual([TINY_PNG, TINY_JPEG]);
      const assistantEntry = snap.entries.find((e) => e.kind === "message" && e.role === "assistant");
      expect(assistantEntry?.images).toBeUndefined();
    } finally {
      await client.close();
      await rig.daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("超限回执：>4 张 → connection.error 中文报错，零副作用", async () => {    const home = tmpHome();
    const rig = await makeRig(home);
    const client = new TestClient(rig.url);
    try {
      await client.open();
      client.send(hello(rig.token));
      await client.expect("connection.welcome");

      const before = client.frames.length;
      client.send({
        v: PROTOCOL_VERSION,
        type: "chat.send",
        payload: { text: "五张图", draft: true, images: [TINY_PNG, TINY_PNG, TINY_PNG, TINY_PNG, TINY_PNG] },
      });
      const err = await client.expect("connection.error");
      const payload = err.payload as { code: string; message: string };
      expect(payload.code).toBe("command.invalid_payload");
      expect(payload.message).toContain("图片附件最多 4 张");

      // 零副作用：未驱动引擎、未建会话（无 snapshot/created 跟进帧）
      expect(rig.engine.lastPromptImages).toBeUndefined();
      const followUps = client.frames.slice(before).filter((f) => f.type === "session.snapshot");
      expect(followUps).toHaveLength(0);
    } finally {
      await client.close();
      await rig.daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("T9 图片下行 WS 集成（工具截图展示）", () => {
  test("工具结果 images → tool.call.result 帧 entry.images + 快照重建含 images", async () => {
    const home = tmpHome();
    const engine = new FakeAgentEngine({
      replies: [
        {
          text: "截图完成。",
          toolCalls: [
            {
              toolName: "browser",
              args: { action: "screenshot", tabId: "t1", file: "/tmp/s.png" },
              result: '{"saved":"/tmp/s.png"}',
              images: [TINY_PNG],
            },
          ],
        },
      ],
    });
    const daemon = await createDaemon({
      home,
      engine,
      skipConfig: true,
      port: 0,
      subagentRunner: { setCallbacks: () => {}, launch: () => {}, send: () => {} },
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    const token = readFileSync(path.join(home, "dev-token"), "utf8");
    const client = new TestClient(`ws://127.0.0.1:${daemon.ws.port}`);
    try {
      await client.open();
      client.send(hello(token));
      await client.expect("connection.welcome");

      client.send({ v: PROTOCOL_VERSION, type: "chat.send", payload: { text: "截个图", draft: true } });
      const snapshot = await client.expect("session.snapshot");
      const sid = (snapshot.payload as { snapshot: { sessionId: string } }).snapshot.sessionId;

      // tool.call.result 帧 entry.images（工具卡缩略图数据源）
      const toolResult = await client.expect("tool.call.result");
      const entry = (toolResult.payload as { entry: { name: string; images?: string[] } }).entry;
      expect(entry.name).toBe("browser");
      expect(entry.images).toEqual([TINY_PNG]);

      await client.expect("chat.turn.completed");

      // 快照重建（session.subscribe 重推）投影含 images（重启/重连恢复面）
      const before = client.frames.length;
      client.send({ v: PROTOCOL_VERSION, type: "session.subscribe", sessionId: sid, payload: {} });
      await until(
        () => client.frames.slice(before).some((f) => f.type === "session.snapshot"),
        3000,
        "重推快照",
      );
      const refetch = client.frames.slice(before).find((f) => f.type === "session.snapshot")!;
      const snap = (refetch.payload as { snapshot: { entries: { kind: string; name?: string; images?: string[] }[] } }).snapshot;
      const toolEntry = snap.entries.find((e) => e.kind === "tool-call" && e.name === "browser");
      expect(toolEntry?.images).toEqual([TINY_PNG]);
    } finally {
      await client.close();
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
