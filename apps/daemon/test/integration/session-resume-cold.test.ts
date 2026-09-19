import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine, type ScriptedTurn } from "../mocks/FakeAgentEngine";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";

/**
 * 会话复水双症状回归（fix/session-resume-cold-diff）：
 * - TP-SR-a 重启复水（症状B）：有历史会话 → daemon 重启（同 --home 新实例、
 *   冷 TurnDiffState）→ 重连握手 → welcome 不得误标 draft（前端 conn.ts draft
 *   分支会把 sessionId 置 null、会话视图重置回零条目草稿）且 sessionId =
 *   既有会话；session.snapshot 尾随重建（entries 非空、可续聊）。
 * - TP-SR-b 冷会话 diff.get 优雅空态（症状A）：重启后 TurnDiffState 全内存
 *   丢失（createTurnDiffState 空态——预期态而非错误）→ diff.get{live:true}
 *   应回空态结果帧（phase:"empty"，additive 回执变体）而非
 *   command.invalid_payload 错误回执（connection.error → UI toast 噪声）。
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
  dispose: () => Promise<void>;
}

async function makeRig(home: string, replies: ScriptedTurn[]): Promise<Rig> {
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
    dispose: async () => {
      await daemon.shutdown();
    },
  };
}

describe("TP-SR-a/b：daemon 重启后会话复水（welcome 语义 + 冷 diff.get 空态）", () => {
  test("有历史会话 → 重启 → 重连 → welcome 携带既有 sessionId 且不误标 draft；diff.get 优雅空态回执", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-srs-it-"));
    try {
      // ── 第一程：草稿建会话 + 一轮对话（会话转正有历史）──
      const rig1 = await makeRig(home, [{ text: "第一轮回复。" }]);
      const client1 = new TestClient(rig1.url);
      await client1.open();
      client1.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: rig1.token, protocolVersion: PROTOCOL_VERSION } });
      const welcome1 = await client1.waitFor((f) => f.type === "connection.welcome", "welcome1");
      // 首连零库 → draft 草稿态（probeCurrentDraft 真值）：经 subscribe 快照取会话 id
      let sessionId: string;
      if (welcome1.payload.draft === true) {
        client1.send({ v: 0, type: "session.subscribe", payload: {} });
        const snap = await client1.waitFor((f) => f.type === "session.snapshot", "snapshot1");
        sessionId = snap.sessionId!;
      } else {
        sessionId = welcome1.payload.sessionId as string;
      }
      client1.send({ v: 0, type: "chat.send", sessionId, payload: { text: "你好" } });
      await client1.waitFor((f) => f.type === "chat.turn.completed", "turn1 completed");
      await client1.close();
      await rig1.dispose(); // 优雅停机（drain 落盘）

      // ── 第二程：daemon 重启（同 home 新实例——冷 TurnDiffState）──
      const rig2 = await makeRig(home, [{ text: "重启后的回复。" }]);
      const client2 = new TestClient(rig2.url);
      try {
        await client2.open();
        client2.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: rig2.token, protocolVersion: PROTOCOL_VERSION } });
        const welcome2 = await client2.waitFor((f) => f.type === "connection.welcome", "welcome2");
        // 症状B判定：有历史的既有会话不得被误判为零条目内存草稿
        expect(welcome2.payload.draft).not.toBe(true);
        expect(welcome2.payload.sessionId).toBe(sessionId);

        // 快照尾随重建：entries 含停机前对话（可续聊判据）
        const snap2 = await client2.waitFor((f) => f.type === "session.snapshot", "snapshot2");
        expect(snap2.sessionId).toBe(sessionId);
        const entries2 = (snap2.payload as { snapshot: { entries: unknown[] } }).snapshot.entries;
        expect(entries2.length).toBeGreaterThanOrEqual(2);

        // 症状A判定：冷会话 diff.get（chip rehydrate 补拉面）→ 优雅空态回执，
        // 不得回 command.invalid_payload 错误帧（connection.error → UI toast）
        client2.send({ v: 0, type: "diff.get", sessionId, payload: { live: true } });
        const result = await client2.waitFor((f) => f.type === "diff.get.result", "diff.get.result（空态）");
        expect(result.sessionId).toBe(sessionId);
        expect(result.channel).toBe("session");
        expect(result.payload).toMatchObject({ files: [], summary: { adds: 0, dels: 0 }, phase: "empty" });
        const badErrors = client2.frames.filter(
          (f) => f.type === "connection.error" && (f.payload as { code?: string }).code === "command.invalid_payload",
        );
        expect(badErrors).toEqual([]); // 全程零 invalid_payload 噪声
      } finally {
        await client2.close();
        await rig2.dispose();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});
