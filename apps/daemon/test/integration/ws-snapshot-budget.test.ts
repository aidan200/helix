import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { PassThrough } from "node:stream";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";
import { SNAPSHOT_BUDGET_BYTES } from "../../src/adapters/driving/ws-server/DtoMapper";
import { openTaskLedgerDatabase } from "../../src/adapters/driven/sqlite-session/WriteQueue";

/**
 * 快照体量批（管家重连循环 bug 第二轮）集成回归：
 *
 * 事故形态（2026-09-20 探针实测，用户会话 17be1a88）：
 * - 大会话（多 MB entries + tool_calls 结果）session.subscribe 的 ack 快照
 *   单帧 15.51MB；welcome attach 快照 + replay subscribe ack 快照 = 每连接
 *   31MB → 慢客户端排水不及 → daemon 发送缓冲 > 8MB → close(4000)
 *   （探针复现：+77ms 收 15.51MB、+115ms close(4000)）→ 客户端 800ms 退避
 *   + 主线程阻塞 ≈ 2.0s 恒定周期自持循环。
 * - 伴随缺陷：大会话 subscribe 在 daemon 事件循环被 15.5MB 级序列化反复
 *   占线时 12s 无任何响应（连接活着、订阅静默）。
 *
 * 回归面：
 * ① 种子大会话（直写 helix.db session_state/tool_calls 行，daemon 冷启动后
 *   经真实懒恢复路径）→ session.subscribe ≤3s 得到快照回执（禁静默）且
 *   帧体 ≤ SNAPSHOT_BUDGET_BYTES + 余量；
 * ② 慢客户端（模拟前端 replay 双发 subscribe + webview 主线程阻塞不排水）
 *   不再触发 close(4000)（预算后双帧合计 ≈ 4.2MB < 8MB 背压限）。
 */

const KB = 1024;
const SEED_ID = "big-seed-1";

function bigText(kb: number, seed: string): string {
  const unit = `${seed}·`;
  return unit.repeat(Math.ceil((kb * KB) / unit.length));
}

/** 直写库种子：主轴 80×50KB 消息（4MB）+ SubAgent agent-1 通道（120×30KB 工具结果 + 40×20KB thinking ≈ 4.4MB）
 *  ——修复前单帧 ≈ 主轴尾窗 30 条 + **通道全量 4.4MB+**（事故形态：channels 不截断）；双发 > 8MB 背压限。 */
function seedBigSession(dbPath: string): void {
  const db = openTaskLedgerDatabase(dbPath);
  try {
    const AGENT = "agent-0000000000000000000000000001";
    const entries = [
      // 主实例消息（主轴）
      ...Array.from({ length: 80 }, (_, i) => ({
        id: `m-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        text: bigText(50, `m${i}`),
        turnId: null,
        isSteer: false,
        instanceId: "main",
        createdAt: new Date(1000 + i * 10).toISOString(),
      })),
      // SubAgent thinking 条目（通道——修复前全量下发面）
      ...Array.from({ length: 40 }, (_, i) => ({
        kind: "thinking",
        id: `a-${i}`,
        instanceId: AGENT,
        text: bigText(20, `a${i}`),
        durationMs: 10,
        createdAt: new Date(2000 + i * 10).toISOString(),
      })),
    ];
    db.prepare(
      "INSERT OR REPLACE INTO session_state (session_id, created_at, entries, turns, updated_at, main_instance_id, mode, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      SEED_ID,
      new Date(0).toISOString(),
      JSON.stringify(entries),
      "[]",
      new Date(3000 + 39 * 10).toISOString(),
      "main",
      null,
      "种子大会话",
    );
    db.prepare(
      "INSERT OR REPLACE INTO agent_lifecycle (session_id, instance_id, state, updated_at) VALUES (?, ?, ?, ?)",
    ).run(SEED_ID, "main", "idle", new Date(0).toISOString());
    db.prepare(
      "INSERT OR REPLACE INTO agent_lifecycle (session_id, instance_id, state, updated_at) VALUES (?, ?, ?, ?)",
    ).run(SEED_ID, AGENT, "done", new Date(0).toISOString());
    const insertTool = db.prepare(
      "INSERT OR REPLACE INTO tool_calls (id, session_id, instance_id, tool_name, args, status, result, error, images, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < 150; i++) {
      insertTool.run(
        `tc-${i}`,
        SEED_ID,
        "main",
        "grep",
        JSON.stringify({ q: `tc-${i}` }),
        "completed",
        bigText(25, `tc${i}`),
        null,
        null,
        new Date(4000 + i).toISOString(),
        new Date(4001 + i).toISOString(),
      );
    }
    // SubAgent 工具行（通道 tools 槽——事故形态主角）
    for (let i = 0; i < 120; i++) {
      insertTool.run(
        `atc-${i}`,
        SEED_ID,
        AGENT,
        "grep",
        JSON.stringify({ q: `atc-${i}` }),
        "completed",
        bigText(30, `atc${i}`),
        null,
        null,
        new Date(5000 + i * 10).toISOString(),
        new Date(5001 + i * 10).toISOString(),
      );
    }
  } finally {
    db.close();
  }
}

interface Rig {
  home: string;
  token: string;
  url: string;
  dispose: () => Promise<void>;
}

async function makeRig(): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-ws-budget-"));
  const daemon = await createTestDaemon({
    home,
    engine: new FakeAgentEngine({}),
    skipConfig: true,
    port: 0,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
  });
  // daemon 冷启动（零会话）后直写种子——订阅走真实懒恢复（restore →
  // buildView → toSnapshotDto → 背压检查面）
  seedBigSession(path.join(home, "helix.db"));
  const token = readFileSync(path.join(home, "dev-token"), "utf8");
  return {
    home,
    token,
    url: `ws://127.0.0.1:${daemon.ws.port}`,
    dispose: async () => {
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 收帧 WS 客户端（ws-server.test.ts 同款最小面）。 */
class FastClient {
  readonly rawFrames: string[] = [];
  private readonly ws: WebSocket;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      this.rawFrames.push(String(ev.data));
    };
  }
  async open(timeoutMs = 3000): Promise<void> {
    const t0 = Date.now();
    while (this.ws.readyState !== WebSocket.OPEN) {
      if (Date.now() - t0 > timeoutMs) throw new Error("WS 连接超时");
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }
  async expect(type: string, timeoutMs: number): Promise<{ atMs: number; frame: string }> {
    const t0 = Date.now();
    for (;;) {
      const hit = this.rawFrames.find((f) => {
        try {
          return (JSON.parse(f) as { type?: string }).type === type;
        } catch {
          return false;
        }
      });
      if (hit !== undefined) return { atMs: Date.now() - t0, frame: hit };
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待帧 ${type} 超时（已收 ${this.rawFrames.length} 帧）`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  close(): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

describe("快照体量集成：大会话 subscribe 有界响应（禁静默）", () => {
  test("7.75MB 种子会话：subscribe ≤3s 得到快照且帧体 ≤ 预算+余量", async () => {
    const rig = await makeRig();
    const client = new FastClient(rig.url);
    try {
      await client.open();
      client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token: rig.token, protocolVersion: PROTOCOL_VERSION } });
      await client.expect("connection.welcome", 5000);
      const t0 = Date.now();
      client.send({ v: PROTOCOL_VERSION, type: "session.subscribe", payload: { tier: "full" }, sessionId: SEED_ID });
      const snap = await client.expect("session.snapshot", 3000); // 完成标准：≤3s 响应（禁静默）
      expect(snap.atMs).toBeLessThan(3000);
      const size = Buffer.byteLength(snap.frame);
      // 预算 + 128KB 余量（DTO 元数据 + 信封）：预算前形态 ≈7.75MB（红证见探针 15.51MB 实测）
      expect(size).toBeLessThanOrEqual(SNAPSHOT_BUDGET_BYTES + 128 * KB);
      const dto = JSON.parse(snap.frame) as { payload: { snapshot: { entries: unknown[]; totalEntries: number; instances?: { instanceId: string; channels?: { tools?: unknown[]; truncated?: boolean } }[] } } };
      expect(dto.payload.snapshot.entries.length).toBeGreaterThan(0);
      expect(dto.payload.snapshot.totalEntries).toBe(230); // 80 消息 + 150 主工具（全量计数不缩水；SubAgent 条目不在主轴）
      // SubAgent 通道在场且被裁（修复前全量 ≈4.4MB；修复后 ≤ 预算内份额 + truncated 标记）
      const agent = dto.payload.snapshot.instances?.find((i) => i.instanceId.startsWith("agent-"));
      expect(agent).toBeDefined();
      expect((agent!.channels?.tools?.length ?? 0)).toBeGreaterThan(0);
      expect(agent!.channels!.truncated).toBe(true);
    } finally {
      client.close();
      await rig.dispose();
    }
  }, 20000);
});

/** 原始 TCP WS 客户端：最小握手 + 帧收发，可暂停读取（模拟 webview 主线程阻塞）。 */
class RawWsClient {
  private readonly sock: net.Socket;
  private letBuf: Buffer = Buffer.alloc(0);
  private httpBuf: Buffer = Buffer.alloc(0);
  private phase: "http" | "ws" = "http";
  private frag: { op: number; len: number; consumed: number } | null = null;
  readonly textBytes = { count: 0 };
  readonly closeFrames: { code: number }[] = [];
  socketClosed = false;

  constructor(port: number, private readonly onUpgrade: () => void) {
    this.sock = net.connect(port, "127.0.0.1");
    this.sock.on("error", () => {});
    this.sock.on("close", () => {
      this.socketClosed = true;
    });
    const key = Buffer.alloc(16, 0x61).toString("base64");
    this.sock.on("connect", () => {
      this.sock.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    this.sock.on("data", (chunk: string | Buffer) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      if (this.phase === "http") {
        this.httpBuf = Buffer.concat([this.httpBuf, buf]);
        const idx = this.httpBuf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        this.phase = "ws";
        this.letBuf = this.httpBuf.subarray(idx + 4);
        this.onUpgrade();
        this.parse();
        return;
      }
      this.letBuf = Buffer.concat([this.letBuf, buf]);
      this.parse();
    });
  }

  pause(): void {
    this.sock.pause();
  }

  resume(): void {
    this.sock.resume();
  }

  sendText(s: string): void {
    const payload = Buffer.from(s);
    const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const len = payload.length;
    let header: Buffer;
    if (len < 126) header = Buffer.from([0x81, 0x80 | len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
    this.sock.write(Buffer.concat([header, mask, masked]));
  }

  destroy(): void {
    this.sock.destroy();
  }

  private parse(): void {
    for (;;) {
      if (this.frag === null) {
        if (this.letBuf.length < 2) return;
        const op = this.letBuf[0]! & 0x0f;
        const len7 = this.letBuf[1]! & 0x7f;
        if (len7 === 126) {
          if (this.letBuf.length < 4) return;
          this.frag = { op, len: this.letBuf.readUInt16BE(2), consumed: 0 };
          this.letBuf = this.letBuf.subarray(4);
        } else if (len7 === 127) {
          if (this.letBuf.length < 10) return;
          this.frag = { op, len: Number(this.letBuf.readBigUInt64BE(2)), consumed: 0 };
          this.letBuf = this.letBuf.subarray(10);
        } else {
          this.frag = { op, len: len7, consumed: 0 };
          this.letBuf = this.letBuf.subarray(2);
        }
      }
      const take = Math.min(this.letBuf.length, this.frag.len - this.frag.consumed);
      if (take > 0) {
        if (this.frag.op === 0x1) this.textBytes.count += take;
        if (this.frag.op === 0x8 && this.frag.consumed === 0 && take >= 2) {
          this.closeFrames.push({ code: this.letBuf.readUInt16BE(0) });
        }
        this.frag.consumed += take;
        this.letBuf = this.letBuf.subarray(take);
      }
      if (this.frag.consumed >= this.frag.len) {
        this.frag = null;
        continue;
      }
      return;
    }
  }
}

describe("快照体量集成：慢客户端双发 subscribe 不再背压断连（循环杀手）", () => {
  test("暂停读取 2.5s（webview 主线程阻塞模拟）→ 无 close(4000)、连接存活", async () => {
    const rig = await makeRig();
    const port = Number(new URL(rig.url.replace("ws://", "http://")).port);
    const raw = new RawWsClient(port, () => {
      // 升级完成即发 hello + 三连 subscribe（模拟前端 onReconnect replay +
      // syncList 补订：active full + 大会话 monitor 降档 + 再订阅——事故形态
      // 下第三帧发送前的背压检查被前两帧 15.5MB/14.3MB 堆死 → close(4000)）
      raw.sendText(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token: rig.token, protocolVersion: PROTOCOL_VERSION } }));
      raw.sendText(JSON.stringify({ v: PROTOCOL_VERSION, type: "session.subscribe", payload: { tier: "full" }, sessionId: SEED_ID }));
      raw.sendText(JSON.stringify({ v: PROTOCOL_VERSION, type: "session.subscribe", payload: { tier: "monitor" }, sessionId: SEED_ID }));
      raw.sendText(JSON.stringify({ v: PROTOCOL_VERSION, type: "session.subscribe", payload: { tier: "full" }, sessionId: SEED_ID }));
      raw.pause(); // 停止排水（等效 webview 解析大快照阻塞主线程）
    });
    try {
      await new Promise((r) => setTimeout(r, 2500));
      raw.resume(); // 恢复读取：检查窗口内 daemon 是否已 close
      await new Promise((r) => setTimeout(r, 1000));
      expect(raw.closeFrames.filter((f) => f.code === 4000)).toHaveLength(0); // 预算后双帧 ≈4.2MB < 8MB 背压限
      expect(raw.socketClosed).toBe(false); // 连接存活（事故形态 +115ms 即 close(4000)，探针实录）
    } finally {
      raw.destroy();
      await rig.dispose();
    }
  }, 20000);
});
