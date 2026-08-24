import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Database } from "bun:sqlite";
import type { Daemon } from "../../src/infrastructure/container";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { createPaths } from "../../src/infrastructure/paths";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { PROTOCOL_VERSION } from "@helix/protocol";

/**
 * T2.2 组合根结构批装配面集成（test-design TP-2.2a/b/c，架构 §4.2）：
 * - TP-2.2a fan-out 带名注册表：名字序列恰等六名语义序（注册表序即语义
 *   唯一权威——「先事件行后状态行」口头契约转机械断言）；
 * - TP-2.2b 装配序契约：装配级事件总线承载 resources.changed，订阅在装配
 *   内注册先于任何 apply（以「装配完成后首个 toggle 即生效」间接验证，
 *   架构 §4.2.2 步 1→8）；
 * - TP-2.2c 事件通道边界三负断言：resources.changed 不进 WS 广播、不落
 *   domain_events、不进 fan-out 注册表（架构 §4.2.3）。
 */

/** 六名语义序（架构 §4.2.4；fan-out 派发序 = 注册表数组序）。 */
const FANOUT_NAMES = [
  "cli-stdout",
  "cli-current-session-feedback",
  "ws-event-stream",
  "event-row-persistence",
  "session-projection",
  "directory-runstate-bridge",
] as const;

interface Frame {
  v: number;
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

  async expect(type: string, timeoutMs = 3000): Promise<void> {
    await until(() => this.frames.some((f) => f.type === type), timeoutMs, `等待帧 ${type}`);
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
  daemon: Daemon;
  engine: FakeAgentEngine;
  dispose: () => Promise<void>;
}

async function makeRig(): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-t2-2-fanout-"));
  const builtinDir = mkdtempSync(path.join(tmpdir(), "helix-t2-2-skills-"));
  const engine = new FakeAgentEngine({});
  const daemon = await createTestDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    skipLock: true,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    toolCwd: home,
    builtinSkillsDir: builtinDir,
  });
  return {
    home,
    daemon,
    engine,
    dispose: async () => {
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
      rmSync(builtinDir, { recursive: true, force: true }); // 泄漏修复：builtin 隔离目录随 dispose 清
    },
  };
}

describe("TP-2.2a：fan-out 带名注册表（架构 §4.2.4）", () => {
  test("注册表名字序列恰等六名语义序（cli-stdout 最前；事件行先于状态行）", async () => {
    const rig = await makeRig();
    try {
      const names = rig.daemon.fanoutTargets.map((t) => t.name);
      expect(names).toEqual([...FANOUT_NAMES]);
      // 持久化-投影次序（先事件行后状态行）单点强化
      expect(names.indexOf("event-row-persistence")).toBeLessThan(names.indexOf("session-projection"));
      expect(names[0]).toBe("cli-stdout");
    } finally {
      await rig.dispose();
    }
  });
});

describe("TP-2.2b：装配序契约（架构 §4.2.2 总线最先 + 订阅先于 apply）", () => {
  test("装配完成后首个 toggle 即走 resources.changed 链且活跃 runtime 直改刷新", async () => {
    const rig = await makeRig();
    try {
      // 观察订阅（容器自身订阅在装配期注册；本订阅随后——两者都先于任何 apply）
      const received: { kind: string }[] = [];
      rig.daemon.resourceEvents.subscribe((event) => {
        received.push({ kind: event.kind });
      });

      // 装配完成后首个动作即 apply：事件必然到达（订阅已在装配内注册）
      const outcome = await rig.daemon.resource.toggle("main-session", "tool", "grep", false);
      expect(outcome).toEqual({ status: "applied" });
      expect(received).toEqual([{ kind: "main-session" }]);

      // 活跃 runtime state 直改刷新（TR-AD-24 既有语义经事件链等价）：
      // FakeAgentEngine 记录 setTools/setSystemPrompt 最近值
      expect(rig.engine.lastTools).toBeDefined();
      expect(rig.engine.lastTools).not.toContain("grep");
      expect(rig.engine.lastSystemPrompt).not.toContain("- grep:");

      // skipped（未知名）不发布（onApplied 语义等价）
      const skipped = await rig.daemon.resource.toggle("main-session", "tool", "no-such-tool", false);
      expect(skipped).toEqual({ status: "skipped", reason: "unknown-name" });
      expect(received).toHaveLength(1);
    } finally {
      await rig.dispose();
    }
  });
});

describe("TP-2.2c：resources.changed 事件通道边界（三负断言，架构 §4.2.3）", () => {
  test("不进 fan-out 注册表 / 不进 WS 广播 / 不落 domain_events", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t2-2-boundary-"));
    const builtinDir = mkdtempSync(path.join(tmpdir(), "helix-t2-2-skills-"));
    const engine = new FakeAgentEngine({});
    const daemon = await createTestDaemon({
      home,
      engine,
      skipConfig: true,
      port: 0,
      skipLock: true,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      toolCwd: home,
      builtinSkillsDir: builtinDir,
    });
    try {
      // ① 不进 fan-out 注册表：六名内无资源事件通道成员
      const names = daemon.fanoutTargets.map((t) => t.name);
      expect(names.some((n) => n.toLowerCase().includes("resource"))).toBe(false);

      // ③ 不进 WS 广播：订阅面连接 + toggle 后无 resources.changed 帧
      const token = readFileSync(createPaths(home).devTokenPath(), "utf8").trim();
      const client = new TestClient(daemon.ws.url);
      try {
        await client.open();
        client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } });
        await client.expect("connection.welcome");
        client.send({ v: 0, type: "session.subscribe", payload: {} });
        const outcome = await daemon.resource.toggle("main-session", "tool", "grep", false);
        expect(outcome).toEqual({ status: "applied" });
        await new Promise((r) => setTimeout(r, 200)); // 窗口：若误广播必已到达
        expect(client.frames.some((f) => String(f.type).includes("resources"))).toBe(false);
      } finally {
        await client.close();
      }
    } finally {
      await daemon.shutdown();
    }
    // ② 不落盘：写队列 drain 关闭后查 domain_events（资源事件非领域事件落盘通道成员）
    const probe = new Database(path.join(home, "helix.db"), { readonly: true });
    try {
      const row = probe.prepare("SELECT COUNT(*) AS n FROM domain_events WHERE type = 'resources.changed'").get() as {
        n: number;
      };
      expect(row.n).toBe(0);
    } finally {
      probe.close();
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(builtinDir, { recursive: true, force: true }); // 泄漏修复：builtin 隔离目录随收尾清
  });
});
