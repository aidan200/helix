import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Api, AssistantMessage, Context, JsonValue, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Database } from "bun:sqlite";
import { PROTOCOL_VERSION } from "@helix/protocol";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { MainSessionProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/MainSessionProfile";
import { effectiveMainToolNames } from "../../src/infrastructure/assembly/buildSessionStack";

/**
 * I 层：主会话 todo 双工具（plan 三工具改名批）——全链集成
 * （真组合根 + production 引擎形态 + mainSessionLlmOverride 剧本 streamFn +
 * 真 SQLite @ tmp + loopback WS）。
 *
 * 覆盖：
 * ① 装配面——MainSessionProfile 声明两名；deps.plan 注入后 resolveTools
 *    两名可解析（剧本真调通即证）；未注入时清单自动剔除（纯函数面）；
 * ② 主会话 todo 链——todo_write/todo_read 真落库（work_item 行
 *    instance_id = sessionId）、sessionId 作用域隔离（同 daemon 两会话）、
 *    全量替换重开（覆盖即意图）、abandoned 空 note 拒绝；
 * ③ 事件发布面——工具执行成功后 session.plan.changed（形状断言：sessionId
 *    + plan 行 + ledger 计数摘要）；失败时不发（帧数不增）；
 * ④ snapshot 携带 plan（重订阅 → session.snapshot.payload.snapshot.plan）；
 * ⑤ deleteSession 后 work_item 行清理（F3.6 写链顺带，防孤儿）。
 */

// ── 剧本 LLM（tools-loop 同款形态：每次引擎调用取一段；工具调用真执行真回注）──

type ScriptEntry =
  | { kind: "tool"; toolName: string; args: Record<string, JsonValue> }
  | { kind: "reply"; text: string };

const fakeModel = {
  id: "model",
  name: "Fake Model",
  api: "anthropic-messages" as Api,
  provider: "fake",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

function baseAssistant(content: AssistantMessage["content"], stopReason: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "fake",
    model: "model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, total: 0 } },
    stopReason: stopReason as AssistantMessage["stopReason"],
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

function toolResultTexts(context: Context): string[] {
  return (context.messages as { role: string; content: { type: string; text?: string }[] }[])
    .filter((m) => m.role === "toolResult")
    .map((m) => m.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join(""));
}

/** 剧本化 streamFn：每次调用取一段（tool → 发起调用；reply → 基于真实结果收口）。 */
function makeScriptedLlm(entries: ScriptEntry[]): StreamFn {
  return (_model, context, _options) => {
    const entry = entries.shift() ?? { kind: "reply" as const, text: "（剧本耗尽）" };
    const message =
      entry.kind === "tool"
        ? baseAssistant(
            [
              {
                type: "toolCall",
                id: `call-${Math.random().toString(36).slice(2, 8)}`,
                name: entry.toolName,
                arguments: entry.args,
              },
            ],
            "toolUse",
          )
        : baseAssistant([{ type: "text", text: entry.text || toolResultTexts(context as Context).join("|") }], "stop");
    const stream = createAssistantMessageEventStream();
    void (async () => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
    })();
    return stream;
  };
}

// ── rig（TestClient 形态镜像 agent-config-ws / session-switch-snapshot）──

interface Frame {
  v: unknown;
  type: string;
  sessionId?: string;
  channel?: string;
  payload: Record<string, unknown>;
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

  async open(timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    while (this.ws.readyState !== WebSocket.OPEN) {
      if (Date.now() - started > timeoutMs) throw new Error("WS 连接超时");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  async until(pred: (f: Frame) => boolean, what: string, timeoutMs = 8000): Promise<Frame> {
    const started = Date.now();
    for (;;) {
      const hit = this.frames.find(pred);
      if (hit !== undefined) return hit;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`等待 ${what} 超时（已收：${this.frames.map((f) => f.type).join(",")}）`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** 基线之后的首个命中帧（区分同型新旧帧）。 */
  async untilAfter(baseline: number, pred: (f: Frame) => boolean, what: string, timeoutMs = 8000): Promise<Frame> {
    const started = Date.now();
    for (;;) {
      const hit = this.frames.slice(baseline).find(pred);
      if (hit !== undefined) return hit;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`等待 ${what} 超时（已收：${this.frames.map((f) => f.type).join(",")}）`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  close(): void {
    this.ws.close();
  }
}

const tmpRoots: string[] = [];

function tmpHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-main-plan-it-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

interface LedgerDto {
  total: number;
  done: number;
  inProgress: number;
}
interface PlanRowDto {
  seq: number;
  content: string;
  status: string;
  note: string | null;
}
interface PlanChangedPayload {
  sessionId: string;
  plan: PlanRowDto[] | null;
  ledger: LedgerDto | null;
}

interface Rig {
  home: string;
  daemon: Awaited<ReturnType<typeof createTestDaemon>>;
  token: string;
  url: string;
  dispose: () => Promise<void>;
  /** work_item 行读面（独立只读连接，WAL 并读）。 */
  workItems: (instanceId: string) => PlanRowDto[];
}

async function makeRig(entries: ScriptEntry[]): Promise<Rig> {
  const home = tmpHome();
  const daemon = await createTestDaemon({
    home,
    skipConfig: true,
    port: 0,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    toolCwd: tmpHome(),
    builtinSkillsDir: tmpHome(),
    mainSessionLlmOverride: {
      model: () => fakeModel,
      streamFn: makeScriptedLlm(entries),
      apiKeys: () => ({ fake: "sk-test" }),
    },
  });
  const token = readFileSync(path.join(home, "dev-token"), "utf8");
  const db = new Database(path.join(home, "helix.db"), { readonly: true });
  return {
    home,
    daemon,
    token,
    url: `ws://127.0.0.1:${daemon.ws.port}`,
    dispose: async () => {
      db.close();
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    },
    workItems: (instanceId) =>
      db
        .prepare("SELECT seq, content, status, note FROM work_item WHERE instance_id = ? ORDER BY seq")
        .all(instanceId) as PlanRowDto[],
  };
}

/** hello + subscribe（草稿握手不推快照——subscribe 后快照必达，agent-config-ws 同法）。 */
async function helloSubscribe(client: TestClient, token: string): Promise<string> {
  client.send({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } });
  const welcome = await client.until((f) => f.type === "connection.welcome", "welcome");
  client.send({ v: 0, type: "session.subscribe", payload: {} });
  await client.until((f) => f.type === "session.snapshot", "snapshot");
  return welcome.payload.sessionId as string;
}

const planFramesOf = (client: TestClient): PlanChangedPayload[] =>
  client.frames.filter((f) => f.type === "session.plan.changed").map((f) => f.payload as unknown as PlanChangedPayload);

// ── ① 装配面 ────────────────────────────────────────────────

describe("① 主会话装配面（todo 双工具）", () => {
  test("MainSessionProfile 声明含 todo 两名（与 SubAgent 两域同构）", () => {
    for (const name of ["todo_write", "todo_read"]) {
      expect(MainSessionProfile.tools).toContain(name);
    }
  });

  test("effectiveMainToolNames：plan/coord 注入时保留；未注入时剔除（声明面 = 注册面一致；批E memory_search 旗标恒传 true——记忆门控另测）", () => {
    const declared = MainSessionProfile.tools;
    const kept = effectiveMainToolNames(declared, { kg: true, codegraph: true, taskCreate: true, taskReport: true, plan: true, coord: true, memorySearch: true, permissionRequest: true });
    expect(kept).toEqual([...declared]);
    const dropped = effectiveMainToolNames(declared, { kg: true, codegraph: true, taskCreate: true, taskReport: true, plan: false, coord: true, memorySearch: true, permissionRequest: true });
    for (const name of ["todo_write", "todo_read"]) {
      expect(dropped).not.toContain(name);
    }
    // 其余名不受 plan 剔除影响
    expect(dropped.filter((t) => !t.startsWith("todo_")).length).toBe(
      declared.filter((t) => !t.startsWith("todo_")).length,
    );
    // taskReport 未注入 → task_report 剔除（taskCreate/plan/coord 同构：声明面 = 注册面一致）
    const noReport = effectiveMainToolNames(declared, { kg: true, codegraph: true, taskCreate: true, taskReport: false, plan: true, coord: true, memorySearch: true, permissionRequest: true });
    expect(noReport).not.toContain("task_report");
    // coord 未注入 → coord 三名剔除（U4）
    const noCoord = effectiveMainToolNames(declared, { kg: true, codegraph: true, taskCreate: true, taskReport: true, plan: true, coord: false, memorySearch: true, permissionRequest: false });
    for (const name of ["coord_claim", "coord_release", "coord_query"]) {
      expect(noCoord).not.toContain(name);
    }
  });

  test("effectiveMainToolNames：memory_search 未可用时剔除（批E 广告面门控 = isAvailable 现值——不广告不可用工具）", () => {
    const declared = MainSessionProfile.tools;
    const kept = effectiveMainToolNames(declared, { kg: true, codegraph: true, taskCreate: true, taskReport: true, plan: true, coord: true, memorySearch: true, permissionRequest: true });
    expect(kept).toContain("memory_search");
    const unavailable = effectiveMainToolNames(declared, { kg: true, codegraph: true, taskCreate: true, taskReport: true, plan: true, coord: true, memorySearch: false, permissionRequest: true });
    expect(unavailable).not.toContain("memory_search");
    // 其余名不受 memory_search 剔除影响
    expect(unavailable.filter((t) => t !== "memory_search").length).toBe(
      declared.filter((t) => t !== "memory_search").length,
    );
  });

  test("effectiveMainToolNames：permission_request 未注入时剔除；注入时保留（提权申请批）", () => {
    const declared = MainSessionProfile.tools;
    const kept = effectiveMainToolNames(declared, { kg: true, codegraph: true, taskCreate: true, taskReport: true, plan: true, coord: true, memorySearch: true, permissionRequest: true });
    expect(kept).toContain("permission_request");
    const dropped = effectiveMainToolNames(declared, { kg: true, codegraph: true, taskCreate: true, taskReport: true, plan: true, coord: true, memorySearch: true, permissionRequest: false });
    expect(dropped).not.toContain("permission_request");
  });
});

// ── ②③④⑤ 主会话 plan 链（真 SQLite + WS 全链）──────────────────

describe("②③④⑤ 主会话 todo 链：落库/作用域/全量替换/事件/snapshot/清理", () => {
  test("todo_write → work_item 落库（instance_id = sessionId）+ session.plan.changed 广播（形状断言）", async () => {
    const rig = await makeRig([
      { kind: "tool", toolName: "todo_write", args: { todos: [
        { content: "拉通链路", status: "pending" },
        { content: "写失败测试", status: "pending" },
        { content: "落地实现", status: "pending" },
      ] } },
      { kind: "reply", text: "清单已建" },
    ]);
    const client = new TestClient(rig.url);
    try {
      await client.open();
      const sessionId = await helloSubscribe(client, rig.token);

      client.send({ v: PROTOCOL_VERSION, type: "chat.send", sessionId, payload: { text: "开工，先建清单" } });

      // 事件面：session.plan.changed（channel=session、信封 sessionId=归属会话）
      const planFrame = await client.until((f) => f.type === "session.plan.changed", "session.plan.changed");
      expect(planFrame.sessionId).toBe(sessionId);
      expect(planFrame.channel).toBe("session");
      const payload = planFrame.payload as unknown as PlanChangedPayload;
      expect(payload.sessionId).toBe(sessionId);
      expect(payload.plan?.map((x) => [x.seq, x.content, x.status, x.note])).toEqual([
        [1, "拉通链路", "pending", null],
        [2, "写失败测试", "pending", null],
        [3, "落地实现", "pending", null],
      ]);
      expect(payload.ledger).toEqual({ total: 3, done: 0, inProgress: 0 });

      // 落库面：instance_id = sessionId（主会话作用域，不与 agent-N 撞名）
      expect(rig.workItems(sessionId).map((x) => [x.seq, x.content, x.status])).toEqual([
        [1, "拉通链路", "pending"],
        [2, "写失败测试", "pending"],
        [3, "落地实现", "pending"],
      ]);
      await client.until((f) => f.type === "chat.turn.completed" && f.sessionId === sessionId, "turn.completed");
    } finally {
      client.close();
      await rig.dispose();
    }
  }, 20_000);

  test("todo_write 全量替换推进 + abandoned 空 note 拒绝（失败不发事件）+ todo_read 收口自查", async () => {
    const rig = await makeRig([
      { kind: "tool", toolName: "todo_write", args: { todos: [
        { content: "甲", status: "pending" }, { content: "乙", status: "pending" },
      ] } },
      { kind: "tool", toolName: "todo_write", args: { todos: [
        { content: "甲", status: "in_progress" }, { content: "乙", status: "pending" },
      ] } },
      { kind: "tool", toolName: "todo_write", args: { todos: [
        { content: "甲", status: "done", note: "产物见 /tmp/a" }, { content: "乙", status: "pending" },
      ] } },
      { kind: "tool", toolName: "todo_write", args: { todos: [ // 空 note → error
        { content: "甲", status: "done", note: "产物见 /tmp/a" }, { content: "乙", status: "abandoned" },
      ] } },
      { kind: "tool", toolName: "todo_read", args: {} },
      { kind: "reply", text: "完成" },
    ]);
    const client = new TestClient(rig.url);
    try {
      await client.open();
      const sessionId = await helloSubscribe(client, rig.token);
      client.send({ v: PROTOCOL_VERSION, type: "chat.send", sessionId, payload: { text: "推进清单" } });

      // 首写 → 1 帧；两次全量替换（in_progress / done）→ 各 1 帧
      await client.until(
        (f) => f.type === "session.plan.changed" && (f.payload as unknown as PlanChangedPayload).ledger?.done === 1,
        "done=1 的 plan.changed",
      );

      // abandoned 空 note：工具 error 结果（帧内 entry.state=error），不产生新 plan.changed
      const errFrame = await client.until(
        (f) =>
          f.type === "tool.call.result" &&
          ((f.payload as { entry?: { name?: string; state?: string } }).entry?.name === "todo_write" &&
            (f.payload as { entry?: { state?: string } }).entry?.state === "error"),
        "abandoned 空 note 的 error 工具结果",
      );
      expect(JSON.stringify(errFrame.payload)).toContain("note");
      // 行未动（#2 仍 pending）
      expect(rig.workItems(sessionId).map((x) => x.status)).toEqual(["done", "pending"]);

      // todo_read 收口自查（读后也发一帧幂等快照——成功即发布语义）。
      // 确定性计数（turn.completed 后全帧收齐，WS 单连接 FIFO 保序）：总 4 帧
      // = 首写 + 全量替换×2 + read；abandoned 空 note 失败路径不发（否则多一帧）。
      await client.until((f) => f.type === "chat.turn.completed", "turn.completed");
      const ledgers = planFramesOf(client).map((x) => x.ledger);
      expect(ledgers).toEqual([
        { total: 2, done: 0, inProgress: 0 }, // todo_write 首写
        { total: 2, done: 0, inProgress: 1 }, // 全量替换 #1 in_progress
        { total: 2, done: 1, inProgress: 0 }, // 全量替换 #1 done
        { total: 2, done: 1, inProgress: 0 }, // todo_read 幂等快照（#2 未动）
      ]);
    } finally {
      client.close();
      await rig.dispose();
    }
  }, 20_000);

  test("全量替换重开：todo_write 覆盖即意图（未决也可重开——旧重建门退役；WS 链 + 落库双证）", async () => {
    const rig = await makeRig([
      { kind: "tool", toolName: "todo_write", args: { todos: [
        { content: "旧一", status: "pending" }, { content: "旧二", status: "pending" },
      ] } },
      { kind: "tool", toolName: "todo_write", args: { todos: [
        { content: "旧一", status: "in_progress" }, { content: "旧二", status: "pending" },
      ] } },
      { kind: "tool", toolName: "todo_write", args: { todos: [
        { content: "旧一", status: "done" }, { content: "旧二", status: "in_progress" },
      ] } },
      { kind: "tool", toolName: "todo_write", args: { todos: [
        { content: "旧一", status: "done" }, { content: "旧二", status: "abandoned", note: "被 #1 覆盖" },
      ] } },
      { kind: "tool", toolName: "todo_write", args: { todos: [
        { content: "新阶段一", status: "pending" },
      ] } }, // 全量替换 → 重开成功（覆盖即意图，无需全 resolved）
      { kind: "reply", text: "重开完成" },
    ]);
    const client = new TestClient(rig.url);
    try {
      await client.open();
      const sessionId = await helloSubscribe(client, rig.token);
      client.send({ v: PROTOCOL_VERSION, type: "chat.send", sessionId, payload: { text: "推进并重开清单" } });
      await client.until((f) => f.type === "chat.turn.completed", "turn.completed");

      // 重开后行 = 新一份 seq 1..1 pending（旧行清、原子重开）
      expect(rig.workItems(sessionId).map((x) => [x.seq, x.content, x.status])).toEqual([
        [1, "新阶段一", "pending"],
      ]);
      // 最后一帧 plan.changed 反映重开后清单
      const last = planFramesOf(client).at(-1)!;
      expect(last.plan?.map((x) => x.content)).toEqual(["新阶段一"]);
      expect(last.ledger?.total).toBe(1);
    } finally {
      client.close();
      await rig.dispose();
    }
  }, 30_000);

  test("sessionId 作用域隔离：同 daemon 两会话各自清单互不可见（行级 instance_id 分仓）", async () => {
    // 会话 A 建两行；草稿链建会话 B 建一行——A 行不动、B 行独立
    const rig = await makeRig([
      { kind: "tool", toolName: "todo_write", args: { todos: [
        { content: "A-一", status: "pending" }, { content: "A-二", status: "pending" },
      ] } },
      { kind: "reply", text: "A 完成" },
      { kind: "tool", toolName: "todo_write", args: { todos: [
        { content: "B-一", status: "pending" },
      ] } },
      { kind: "reply", text: "B 完成" },
    ]);
    const client = new TestClient(rig.url);
    try {
      await client.open();
      const sessionA = await helloSubscribe(client, rig.token);
      client.send({ v: PROTOCOL_VERSION, type: "chat.send", sessionId: sessionA, payload: { text: "A 开工" } });
      await client.until((f) => f.type === "chat.turn.completed", "A turn.completed");
      expect(rig.workItems(sessionA)).toHaveLength(2);

      // 草稿链建会话 B（首条消息即 B 的首轮——剧本第三段 todo_write B）
      client.send({ v: PROTOCOL_VERSION, type: "chat.send", payload: { draft: true, text: "B 开工" } });
      const bFrame = await client.until(
        (f) => f.type === "session.plan.changed" && f.sessionId !== sessionA,
        "B 的 plan.changed",
      );
      const sessionB = bFrame.sessionId!;
      await client.until(
        (f) => f.type === "chat.turn.completed" && f.sessionId === sessionB,
        "B turn.completed",
      );

      // B 的清单只含 B 行；A 行不受 B 建清单影响
      const bPayload = bFrame.payload as unknown as PlanChangedPayload;
      expect(bPayload.sessionId).toBe(sessionB);
      expect(bPayload.plan?.map((x) => x.content)).toEqual(["B-一"]);
      expect(rig.workItems(sessionA).map((x) => x.content)).toEqual(["A-一", "A-二"]);
      expect(rig.workItems(sessionB).map((x) => x.content)).toEqual(["B-一"]);
    } finally {
      client.close();
      await rig.dispose();
    }
  }, 30_000);

  test("④ snapshot 携带 plan：重订阅 → session.snapshot.payload.snapshot.plan 全行 + ledger", async () => {
    const rig = await makeRig([
      { kind: "tool", toolName: "todo_write", args: { todos: [
        { content: "快照一", status: "pending" }, { content: "快照二", status: "pending" },
      ] } },
      { kind: "tool", toolName: "todo_write", args: { todos: [
        { content: "快照一", status: "in_progress" }, { content: "快照二", status: "pending" },
      ] } },
      { kind: "tool", toolName: "todo_write", args: { todos: [
        { content: "快照一", status: "done", note: "完成注记" }, { content: "快照二", status: "pending" },
      ] } },
      { kind: "reply", text: "完成" },
    ]);
    const client = new TestClient(rig.url);
    try {
      await client.open();
      const sessionId = await helloSubscribe(client, rig.token);
      client.send({ v: PROTOCOL_VERSION, type: "chat.send", sessionId, payload: { text: "开工" } });
      await client.until((f) => f.type === "chat.turn.completed", "turn.completed");

      // 重订阅 → 新快照携带 plan/ledger（重连/恢复种子）
      const baseline = client.frames.length;
      client.send({ v: PROTOCOL_VERSION, type: "session.subscribe", sessionId, payload: {} });
      const snap = await client.untilAfter(baseline, (f) => f.type === "session.snapshot", "重订阅后的新快照");
      const snapshot = (
        snap.payload as {
          snapshot: { plan: PlanRowDto[] | null; ledger: LedgerDto | null };
        }
      ).snapshot;
      expect(snapshot.plan?.map((x) => [x.seq, x.status, x.note])).toEqual([
        [1, "done", "完成注记"],
        [2, "pending", null],
      ]);
      expect(snapshot.ledger).toEqual({ total: 2, done: 1, inProgress: 0 });
    } finally {
      client.close();
      await rig.dispose();
    }
  }, 20_000);

  test("⑤ deleteSession 后 work_item 行清理（F3.6 写链顺带，防孤儿）", async () => {
    const rig = await makeRig([
      { kind: "tool", toolName: "todo_write", args: { todos: [
        { content: "待清理", status: "pending" },
      ] } },
      { kind: "reply", text: "完成" },
    ]);
    const client = new TestClient(rig.url);
    try {
      await client.open();
      const sessionId = await helloSubscribe(client, rig.token);
      client.send({ v: PROTOCOL_VERSION, type: "chat.send", sessionId, payload: { text: "建清单" } });
      await client.until((f) => f.type === "session.plan.changed", "plan.changed");
      await client.until((f) => f.type === "chat.turn.completed", "turn.completed");
      expect(rig.workItems(sessionId)).toHaveLength(1);

      client.send({ v: PROTOCOL_VERSION, type: "session.delete", sessionId, payload: {} });
      await client.until((f) => f.type === "session.list_changed", "list_changed");
      // 写链 drain 后行清（轮询小窗口等待落盘可见）
      for (let i = 0; i < 100; i++) {
        if (rig.workItems(sessionId).length === 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(rig.workItems(sessionId)).toEqual([]);
    } finally {
      client.close();
      await rig.dispose();
    }
  }, 20_000);
});
