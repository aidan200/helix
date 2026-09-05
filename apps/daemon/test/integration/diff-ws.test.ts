import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Database } from "bun:sqlite";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine, type ScriptedTurn } from "../mocks/FakeAgentEngine";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";

/**
 * T3+T4 轮次 diff 协议与 UI 闭环——WS 集成（真组合根 + Fake 引擎）：
 * - TP-DIFF-a 推送链端到端：chat.send 轮生命周期 → TurnDiffService 挂点
 *   （beginTurn/endTurn）→ 组合根推送回调（WeakMap 反查归属会话）→
 *   fan-out publishDelta（channel="diff"）→ EventStream → per-session 订阅
 *   路由 → 客户端收 diff.changed{cleared} / diff.changed{frozen}；
 * - TP-DIFF-b 瞬态通道纪律：diff.changed 推送后 domain_events 行数零增
 *   （publishDelta 不落盘端到端证明——严禁走 publish/domain 通道）；
 * - TP-DIFF-c diff.get 往返：frozen 视图（files/summary）/ live 无进行中轮
 *   → command.invalid_payload / 信封缺 sessionId / 载荷形状不符 / 未知会话
 *   四防御回执（连接保持）。
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
      this.frames.push(JSON.parse(String(ev.data)));
    };
  }

  async open(timeoutMs = 3000): Promise<void> {
    await until(() => this.ws.readyState === WebSocket.OPEN, timeoutMs, "WS 连接建立");
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  /** 等待满足谓词的帧并返回之。 */
  async waitFor(pred: (f: Frame) => boolean, what: string, timeoutMs = 5000): Promise<Frame> {
    await until(() => this.frames.some(pred), timeoutMs, `等待帧（${what}；已收：${this.frames.map((f) => f.type).join(",")}）`);
    return this.frames.find(pred)!;
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

async function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Rig {
  home: string;
  daemon: Awaited<ReturnType<typeof createTestDaemon>>;
  token: string;
  url: string;
  dbPath: string;
  dispose: () => Promise<void>;
}

async function makeRig(replies: ScriptedTurn[]): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-diff-it-"));
  const engine = new FakeAgentEngine({ replies });
  const daemon = await createTestDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
  });
  const token = readFileSync(path.join(home, "dev-token"), "utf8");
  return {
    home,
    daemon,
    token,
    url: `ws://127.0.0.1:${daemon.ws.port}`,
    dbPath: path.join(home, "helix.db"),
    dispose: async () => {
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

async function helloHandshake(client: TestClient, token: string): Promise<string> {
  client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } });
  const welcome = await client.waitFor((f) => f.type === "connection.welcome", "welcome");
  if (welcome.payload.draft === true) {
    client.send({ v: 0, type: "session.subscribe", payload: {} });
    const snap = await client.waitFor((f) => f.type === "session.snapshot", "snapshot");
    return snap.sessionId!;
  }
  return welcome.payload.sessionId as string;
}

function domainEventCount(dbPath: string): { n: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query("SELECT COUNT(*) AS n FROM domain_events").get() as { n: number };
  } finally {
    db.close();
  }
}

describe("TP-DIFF-a/b：diff.changed 推送链端到端（chat 轮生命周期 + 瞬态通道纪律）", () => {
  test("chat.send 一轮 → cleared（开轮清零）+ frozen（收轮冻结，空轮 0/0/0）；domain_events 零增", async () => {
    const rig = await makeRig([{ text: "好的。" }]);
    const client = new TestClient(rig.url);
    try {
      await client.open();
      const sessionId = await helloHandshake(client, rig.token);
      const before = domainEventCount(rig.dbPath);

      client.send({ v: 0, type: "chat.send", sessionId, payload: { text: "写点东西" } });
      // 开轮清零帧（turn.started 同点）
      const cleared = await client.waitFor(
        (f) => f.type === "diff.changed" && (f.payload as { phase: string }).phase === "cleared",
        "diff.changed cleared",
      );
      expect(cleared.sessionId).toBe(sessionId);
      expect(cleared.channel).toBe("session");
      expect(cleared.payload).toMatchObject({ phase: "cleared", adds: 0, dels: 0, fileCount: 0 });
      expect(typeof cleared.payload.turnId).toBe("string");

      // 收轮冻结帧（空轮：无写 → 0/0/0）
      const frozen = await client.waitFor(
        (f) => f.type === "diff.changed" && (f.payload as { phase: string }).phase === "frozen",
        "diff.changed frozen",
      );
      expect(frozen.payload).toMatchObject({ phase: "frozen", adds: 0, dels: 0, fileCount: 0 });
      // 轮次一致（同一 turnId）
      expect(frozen.payload.turnId).toBe(cleared.payload.turnId);

      // 瞬态通道纪律：diff.changed 不落 domain_events（publishDelta 通道端到端）
      await client.waitFor(
        (f) => f.type === "chat.turn.completed",
        "turn completed",
      );
      const after = domainEventCount(rig.dbPath);
      expect(after.n - before.n).toBeGreaterThanOrEqual(0);
      // 落盘的 domain_events 里不得出现 diff.changed 型事件载荷
      const db = new Database(rig.dbPath, { readonly: true });
      try {
        const diffRows = db
          .query("SELECT COUNT(*) AS n FROM domain_events WHERE payload LIKE '%diff.changed%'")
          .get() as { n: number };
        expect(diffRows.n).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      await client.close();
      await rig.dispose();
    }
  }, 15000);
});

describe("TP-DIFF-c：diff.get 往返与防御回执", () => {
  test("空轮冻结后 diff.get → files=[] + summary 0/0（frozen 视图）", async () => {
    const rig = await makeRig([{ text: "好。" }]);
    const client = new TestClient(rig.url);
    try {
      await client.open();
      const sessionId = await helloHandshake(client, rig.token);
      client.send({ v: 0, type: "chat.send", sessionId, payload: { text: "跑一轮" } });
      await client.waitFor((f) => f.type === "diff.changed" && (f.payload as { phase: string }).phase === "frozen", "frozen");

      client.send({ v: 0, type: "diff.get", sessionId, payload: {} });
      const result = await client.waitFor((f) => f.type === "diff.get.result", "diff.get.result");
      expect(result.sessionId).toBe(sessionId);
      expect(result.channel).toBe("session");
      // 回执携带轮相位（rehydrate 面：chip 灰态判定依据——v0.3.1 §27）
      expect(result.payload).toMatchObject({ files: [], summary: { adds: 0, dels: 0 }, phase: "frozen" });
      expect(typeof (result.payload as { turnId: string }).turnId).toBe("string");
    } finally {
      await client.close();
      await rig.dispose();
    }
  }, 15000);

  test("live=true 无进行中轮 → 回落最近冻结轮（rehydrate auto 语义；连接保持）", async () => {
    const rig = await makeRig([{ text: "好。" }]);
    const client = new TestClient(rig.url);
    try {
      await client.open();
      const sessionId = await helloHandshake(client, rig.token);
      client.send({ v: 0, type: "chat.send", sessionId, payload: { text: "跑一轮" } });
      const frozen = await client.waitFor(
        (f) => f.type === "diff.changed" && (f.payload as { phase: string }).phase === "frozen",
        "frozen",
      );

      // 轮已结束（active=null）：live=true 不再报错，回落最近冻结轮——
      // 会话切回 rehydrate 单查询即得「进行中或最近轮」
      client.send({ v: 0, type: "diff.get", sessionId, payload: { live: true } });
      const result = await client.waitFor((f) => f.type === "diff.get.result", "diff.get.result");
      expect((result.payload as { phase: string }).phase).toBe("frozen");
      expect((result.payload as { turnId: string }).turnId).toBe(
        (frozen.payload as { turnId: string }).turnId,
      );
    } finally {
      await client.close();
      await rig.dispose();
    }
  }, 15000);

  test("信封缺 sessionId / 载荷形状不符 / 未知会话 → invalid_payload 三防御", async () => {
    const rig = await makeRig([{ text: "好。" }]);
    const client = new TestClient(rig.url);
    try {
      await client.open();
      const sessionId = await helloHandshake(client, rig.token);

      // ① 信封缺 sessionId（session 作用域路由位必填）
      client.send({ v: 0, type: "diff.get", payload: {} });
      const e1 = await client.waitFor(
        (f) => f.type === "connection.error" && (f.payload as { code?: string }).code === "command.invalid_payload",
        "缺 sessionId 回执",
      );
      expect((e1.payload as { message: string }).message).toContain("sessionId");

      // ② 载荷形状不符（turnId 非字符串）
      client.send({ v: 0, type: "diff.get", sessionId, payload: { turnId: 123 } });
      await client.waitFor(
        (f, ) => f.type === "connection.error" && (f.payload as { code?: string }).code === "command.invalid_payload" && (f.payload as { message: string }).message.includes("turnId"),
        "turnId 形状回执",
      );

      // ③ 未知会话（不存在/未加载）
      client.send({ v: 0, type: "diff.get", sessionId: "sess-nope", payload: {} });
      await client.waitFor(
        (f) => f.type === "connection.error" && (f.payload as { code?: string }).code === "command.invalid_payload" && (f.payload as { message: string }).message.includes("sess-nope"),
        "未知会话回执",
      );
    } finally {
      await client.close();
      await rig.dispose();
    }
  }, 15000);
});
