import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Database } from "bun:sqlite";
import { createDaemon } from "../../src/infrastructure/container";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { Session } from "../../src/domain/session/Session";
import { ToolCallRecord } from "../../src/domain/tools/ToolCallRecord";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { PersistedDomainState } from "../../src/application/ports/outbound/SessionRepositoryPort";

/**
 * CL-8 持久化集成（I 层）：
 * - TP-CL8-1 四类状态重启重建（会话聚合/agent 生命周期/steer 队列/工具调用记录）；
 * - TP-CL8-2 I 半：db 路径 = <home>/helix.db、WAL、真实 ~/.helix 未被触碰；
 * - TP-CL8-3 流式 delta 不落盘、里程碑事件落盘（write-through 事件后即可查）；
 * - TP-CL8-9 domain_events 按 session/agent/类型/时间四维过滤查询；
 * - TP-CL4-10 steer 队列经单写队列落盘（queued 可查 → drained 后出账）。
 */

/** 真实 home 快照（测试组结束断言未触碰）。 */
const realHelix = path.join(homedir(), ".helix");
let realHomeBefore: Map<string, number> | "absent" = "absent";

beforeAll(() => {
  if (existsSync(realHelix)) {
    realHomeBefore = new Map(
      readdirSync(realHelix).map((name) => [name, statSync(path.join(realHelix, name)).mtimeMs]),
    );
  }
});

afterAll(() => {
  if (realHomeBefore === "absent") {
    expect(existsSync(realHelix)).toBe(false);
  } else {
    const now = new Map(
      readdirSync(realHelix).map((name) => [name, statSync(path.join(realHelix, name)).mtimeMs]),
    );
    expect([...now.entries()]).toEqual([...(realHomeBefore as Map<string, number>).entries()]);
  }
});

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), "helix-cl8-"));
}

describe("TP-CL8-1：四类状态经 repository 存取重建", () => {
  test("save（含工具三态/steer 挂起/生命周期）→ restore 四类逐项等价", async () => {
    const home = tmpHome();
    try {
      const queue = new WriteQueue(path.join(home, "helix.db"));
      const repo = new SqliteSessionRepository(queue);

      const session = Session.create("s-cl8-1", "2024-01-01T00:00:00.000Z");
      session.appendUserEntry("跑个命令", "2024-01-01T00:00:01.000Z");
      session.beginTurn("e1", "2024-01-01T00:00:02.000Z");
      session.applySteer("改用 grep", "2024-01-01T00:00:03.000Z"); // pendingSteer 挂起

      const ok = ToolCallRecord.create("tc-ok", "bash", { command: "echo hi" });
      ok.markRunning("2024-01-01T00:00:04.000Z");
      ok.complete("hi", "2024-01-01T00:00:05.000Z");
      const bad = ToolCallRecord.create("tc-bad", "read", { path: "/x" });
      bad.markRunning("2024-01-01T00:00:06.000Z");
      bad.fail("no such file", "2024-01-01T00:00:07.000Z");

      const state: PersistedDomainState = {
        session: session.toSnapshot(),
        agentState: "steering",
        toolCalls: [ok.toData(), bad.toData()],
      };
      await repo.save(state);

      const restored = await repo.restore("s-cl8-1");
      expect(restored).toBeDefined();
      // ① 会话聚合（Entry 树/轮次）
      expect(restored!.session.entries.map((e) => [e.id, e.role, e.text, e.isSteer])).toEqual([
        ["e1", "user", "跑个命令", false],
        ["e2", "user", "改用 grep", true],
      ]);
      expect(restored!.session.turns[0]!.status).toBe("generating");
      // ② agent 生命周期
      expect(restored!.agentState).toBe("steering");
      // ③ steer 队列（未消费）
      expect(restored!.session.pendingSteer).toEqual([{ entryId: "e2", text: "改用 grep" }]);
      // ④ 工具调用记录（结果/错误/时间全保真）
      expect(restored!.toolCalls).toEqual([ok.toData(), bad.toData()]);

      // 重建行为延续
      const rebuilt = Session.restoreFrom(restored!.session);
      expect(rebuilt.steerQueueSize).toBe(1);
      expect(rebuilt.openTurn).not.toBeNull();
      await queue.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("listSessionIds 按创建序返回；restore 不存在返回 undefined", async () => {
    const home = tmpHome();
    try {
      const queue = new WriteQueue(path.join(home, "helix.db"));
      const repo = new SqliteSessionRepository(queue);
      for (const id of ["s-a", "s-b", "s-c"]) {
        const s = Session.create(id, new Date(Date.parse("2024-01-01T00:00:00.000Z") + id.charCodeAt(2)).toISOString());
        s.appendUserEntry(`问-${id}`, "2024-01-01T00:00:01.000Z");
        await repo.save({ session: s.toSnapshot(), agentState: "idle", toolCalls: [] });
      }
      expect(await repo.listSessionIds()).toEqual(["s-a", "s-b", "s-c"]);
      expect(await repo.restore("nope")).toBeUndefined();
      await queue.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("TP-CL8-2 I 半 + TP-CL8-3 + TP-CL4-10：daemon 落盘接线", () => {
  test("流式期间 DB 无 delta、里程碑即时可见；steer 入队即落盘、drain 后出账", async () => {
    const home = tmpHome();
    try {
      const engine = new FakeAgentEngine({
        replies: [
          {
            toolCalls: [{ toolName: "bash", args: { command: "echo hi" }, result: "hi", durationMs: 60 }],
            text: "流式回复正文内容，一段足够长的文字。",
            chunkDelayMs: 10,
          },
        ],
        steerReplies: [{ text: "（按注入调整）好的。" }],
      });
      const daemon = await createDaemon({
        home,
        engine,
        skipConfig: true,
        port: 0, // 随机端口：并行测试不撞 7333（T1.6 WS 装配后必传）
        skipLock: true,
        cliInput: new PassThrough(),
        cliOutput: new PassThrough(),
      });

      // db 路径断言（TP-CL8-2 I 半）：<home>/helix.db + WAL
      const dbPath = path.join(home, "helix.db");
      expect(existsSync(dbPath)).toBe(true);
      const probe = new Database(dbPath, { readonly: true });
      expect((probe.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");

      const run = daemon.chat.sendMessage("跑命令并回答");
      // 等到流式 delta 开始（此时工具批与里程碑已落盘）
      await new Promise<void>((resolve) => {
        let deltas = 0;
        const off = daemon.session.subscribe((e) => {
          if ("delta" in e && ++deltas >= 2) {
            off();
            resolve();
          }
        });
      });

      // TP-CL8-3：流式期间查 DB——里程碑事件在、无任何 delta 落盘
      const types = (
        probe.prepare("SELECT type FROM domain_events ORDER BY id").all() as { type: string }[]
      ).map((r) => r.type);
      expect(types).toContain("message.completed"); // user 消息里程碑
      expect(types).toContain("turn.started");
      expect(types).toContain("agent.state.changed");
      expect(types).toContain("tool.call.started"); // 工具里程碑
      expect(types.every((t) => !t.includes("delta"))).toBe(true); // 无 delta 事件类型
      // 半截流式不落盘：DB 内文本不含流式正文片段
      const payloadHit = (
        probe.prepare("SELECT COUNT(*) AS c FROM domain_events WHERE payload LIKE ?").get("%流式回复%") as {
          c: number;
        }
      ).c;
      const entryHit = (
        probe.prepare("SELECT COUNT(*) AS c FROM session_state WHERE entries LIKE ?").get("%流式回复%") as {
          c: number;
        }
      ).c;
      expect(payloadHit).toBe(0);
      expect(entryHit).toBe(0);
      // 工具记录已入投影表
      expect((probe.prepare("SELECT COUNT(*) AS c FROM tool_calls").get() as { c: number }).c).toBe(1);

      // TP-CL4-10：运行中 steer → steer.queued 事件 + steer 队列落盘
      const steerOutcome = await daemon.chat.sendMessage("改一下");
      expect(steerOutcome.mode).toBe("steered");
      await new Promise((r) => setTimeout(r, 20)); // 等 write-through 落盘（微任务+串行链）
      const steerQueued = (
        probe.prepare("SELECT COUNT(*) AS c FROM domain_events WHERE type = 'steer.queued'").get() as { c: number }
      ).c;
      expect(steerQueued).toBe(1);
      const pendingRows = (
        probe.prepare("SELECT entry_id, text FROM steer_queue").all() as { entry_id: string; text: string }[]
      ).map((r) => [r.entry_id, r.text]);
      expect(pendingRows).toEqual([["e2", "改一下"]]);

      await run; // 整个 run（含 drain 轮）结束
      // drain 后 steer 队列出账
      expect((probe.prepare("SELECT COUNT(*) AS c FROM steer_queue").get() as { c: number }).c).toBe(0);
      expect((probe.prepare("SELECT COUNT(*) AS c FROM domain_events WHERE type = 'steer.drained'").get() as { c: number }).c).toBe(1);

      await daemon.shutdown();
      probe.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
});

describe("TP-CL8-9：domain_events 四维过滤查询", () => {
  test("session/agent/类型/时间各维过滤返回正确子集", async () => {
    const home = tmpHome();
    try {
      const queue = new WriteQueue(path.join(home, "helix.db"));
      const repo = new SqliteSessionRepository(queue);

      const at = (n: number) => new Date(Date.parse("2024-01-01T00:00:00.000Z") + n * 1000).toISOString();
      const mk = (type: string, sessionId: string, n: number): DomainEvent => ({
        type: type as DomainEvent["type"],
        sessionId,
        payload: { n },
        occurredAt: at(n),
      });

      // 两会话 × 两 agent kind × 多类型 × 时间梯度
      await queue.appendEvent(mk("message.completed", "s1", 1), "main");
      await queue.appendEvent(mk("message.completed", "s1", 2), "main");
      await queue.appendEvent(mk("turn.started", "s1", 3), "sub");
      await queue.appendEvent(mk("turn.completed", "s2", 4), "main");
      await queue.appendEvent(mk("message.completed", "s2", 5), "main");
      await queue.appendEvent(mk("steer.queued", "s2", 9), "sub");

      // 维度 1：session
      const s1 = repo.queryEvents({ sessionId: "s1" });
      expect(s1.map((e) => (e.payload as { n: number }).n)).toEqual([1, 2, 3]);
      // 维度 2：agent kind
      const sub = repo.queryEvents({ agentKind: "sub" });
      expect(sub.map((e) => (e.payload as { n: number }).n)).toEqual([3, 9]);
      // 维度 3：类型
      const msgs = repo.queryEvents({ type: "message.completed" });
      expect(msgs.map((e) => (e.payload as { n: number }).n)).toEqual([1, 2, 5]);
      // 维度 4：时间（since/until，ISO 语义）
      expect(repo.queryEvents({ since: at(3), until: at(5) }).map((e) => (e.payload as { n: number }).n)).toEqual([3, 4, 5]);
      // 组合维度
      expect(
        repo.queryEvents({ sessionId: "s2", type: "message.completed" }).map((e) => (e.payload as { n: number }).n),
      ).toEqual([5]);
      expect(repo.queryEvents({ sessionId: "s1", agentKind: "main", type: "message.completed" }).length).toBe(2);
      // 无过滤 = 全量
      expect(repo.queryEvents().length).toBe(6);
      await queue.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
