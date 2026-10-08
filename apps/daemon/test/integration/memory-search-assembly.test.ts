/**
 * 批E：编码 agent 记忆消费面工具化——组装链接线集成（container E2E）。
 *
 * 断言面：
 * 1. 静态注入退役（批D 负断言钉死）：主会话与 SubAgent 组装产物的系统提示
 *    不再含「用户偏好与工作状态」静态召回段；
 * 2. 工具面双注册：记忆装配（memory.* 配置 + vec0 可解析）时主会话
 *    instantiated 快照 tools 含 memory_search（声明面=注册面——
 *    effectiveMainToolNames 门控）；SubAgent spawn 快照 tools 同含
 *    （worker 家族声明面，ChildMain 本地栈恒注册）；
 * 3. 未配置记忆的 daemon：主会话工具面剔除 memory_search（不广告未注册
 *    工具）；零注入痕迹（段整体省略不炸主链路）。
 *
 * 装置：daemon 启动前 pre-seed home（helix.db 三行 KV + steward_memory.db
 * 真库条目）——检索语义归工具单测；本文件只钉组装面接线。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Database } from "bun:sqlite";
import { getLoadablePath } from "sqlite-vec";
import { SCHEMA_SQL } from "../../src/adapters/driven/sqlite-session/schema";
import { SqliteVecMemoryStore } from "../../src/adapters/driven/steward-memory/SqliteVecMemoryStore";
import { MEMORY_SCOPE_GLOBAL } from "../../src/application/steward/StewardMemoryService";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import type { InstanceRunner, InstanceRunnerCallbacks } from "../../src/application/services/InstanceRunner";
import type { Daemon } from "../../src/infrastructure/container";
import { PROTOCOL_VERSION } from "@helix/protocol";

/** 批D 静态段头（负断言锚点——工具化后不得再出现于任何组装产物）。
 * 锚点取段头专属形态（「## 用户偏好与工作状态（长期记忆只读召回」）：
 * 「用户偏好与工作状态」短语本身是记忆域正当描述（memory_search 工具
 * snippet/四查纪律句合法携带），不能作负断言锚。 */
const RETIRED_SECTION_HEADER = "## 用户偏好与工作状态（长期记忆只读召回";

/** 预置记忆条目文本（负断言锚点——条目在库里也不得静态注入提示词）。 */
const TEXT_SEED = "全局偏好：交付前先跑全量测试再收口";

/** pre-seed home：KV 三行（开关 + 端点引用 + 端点表）+ 记忆真库一条。 */
function seedMemoryHome(home: string): void {
  const db = new Database(path.join(home, "helix.db"));
  db.exec(SCHEMA_SQL);
  const insert = db.prepare("INSERT OR REPLACE INTO runtime_config (key, value) VALUES (?, ?)");
  insert.run("memory.enabled", "1");
  insert.run("memory.endpointId", "ep-fake");
  insert.run(
    "embedding_endpoints",
    JSON.stringify([{ id: "ep-fake", name: "fake", baseUrl: "http://localhost:1", model: "fake-embed" }]),
  );
  db.close();

  const store = new SqliteVecMemoryStore(path.join(home, "steward_memory.db"), getLoadablePath());
  store.append([
    {
      kind: "preference",
      text: TEXT_SEED,
      source: "steward-turn",
      createdAt: Date.now() - 3_600_000,
      vector: Float32Array.from([1, 0, 0]),
      projectScope: MEMORY_SCOPE_GLOBAL,
    },
  ]);
  store.close();
}

/** 挂起 runner（只观测 spawn 快照落盘，不驱动收口）。 */
class HangingRunner implements InstanceRunner {
  setCallbacks(_callbacks: InstanceRunnerCallbacks): void {
    /* 本文件不消费实例回调 */
  }
  launch(): void {
    /* 挂起 */
  }
  kill(): void {
    /* 幂等空操作 */
  }
}

async function until(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`until 超时：${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface PromptSnapshot {
  readonly systemPrompt: string;
  readonly tools: readonly string[];
}

/** 轮询 domain_events 取实例的 agent.instantiated 快照。 */
async function snapshotOf(
  home: string,
  sessionId: string,
  match: (payload: Record<string, unknown>) => boolean,
): Promise<PromptSnapshot> {
  const repo = new SqliteSessionRepository(new WriteQueue(path.join(home, "helix.db")));
  let found: PromptSnapshot | undefined;
  try {
    await until(
      () => {
        const hit = repo.queryEvents({ sessionId }).find((e) => e.type === "agent.instantiated" && match(e.payload as Record<string, unknown>));
        if (hit !== undefined) {
          const snap = (hit.payload as { profileSnapshot: { systemPrompt: string; tools: readonly string[] } }).profileSnapshot;
          found = { systemPrompt: snap.systemPrompt, tools: snap.tools };
          return true;
        }
        return false;
      },
      5000,
      "agent.instantiated 落盘",
    );
    return found!;
  } finally {
    await (repo as unknown as { dispose?: () => void }).dispose?.();
  }
}

/** 主会话 instantiated 快照（profileKind=main-session 过滤）。 */
function mainSessionSnapshot(home: string, sessionId: string): Promise<PromptSnapshot> {
  return snapshotOf(home, sessionId, (p) => p.profileKind === "main-session");
}

interface Rig {
  readonly home: string;
  readonly daemon: Daemon;
  readonly workspace: string;
  dispose(): Promise<void>;
}

const rigs: Rig[] = [];

async function makeRig(opts: { seedMemory?: boolean } = {}): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-memory-search-"));
  const workspace = path.join(home, "ws");
  if (opts.seedMemory !== false) seedMemoryHome(home);
  const daemon = await createTestDaemon({
    home,
    engine: () => new FakeAgentEngine(),
    skipConfig: true,
    port: 0,
    subagentRunner: new HangingRunner(),
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    kgWorkspaceRoot: workspace,
    toolCwd: workspace,
  });
  const rig: Rig = {
    home,
    daemon,
    workspace,
    dispose: async () => {
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    },
  };
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  while (rigs.length > 0) await rigs.pop()!.dispose();
});

describe("memory_search 工具化·组装链接线（container E2E）", () => {
  test("① 静态段退役 + 主会话工具面注册：提示零静态记忆段；tools 含 memory_search", async () => {
    const rig = await makeRig();
    // 促转正：经 WS 首条消息（draft 链）触发 instantiated 落盘
    const token = (await (await fetch(`http://127.0.0.1:${rig.daemon.ws.port}/helix-dev-token`)).text()).trim();
    const ws = new WebSocket(rig.daemon.ws.url);
    const frames: { type: string; payload: Record<string, unknown> }[] = [];
    ws.onmessage = (ev: MessageEvent) => frames.push(JSON.parse(String(ev.data)));
    await until(() => ws.readyState === WebSocket.OPEN, 3000, "WS 连接");
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } }));
    await until(() => frames.some((f) => f.type === "connection.welcome"), 3000, "welcome");
    const sid = frames.find((f) => f.type === "connection.welcome")!.payload.sessionId as string;
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "chat.send", payload: { draft: true, text: "促转正首条消息" } }));
    const snap = await mainSessionSnapshot(rig.home, sid);
    ws.close();

    // 批D 静态段负断言钉死：库里明明有 global 条目，也不得进系统提示
    expect(snap.systemPrompt).not.toContain(RETIRED_SECTION_HEADER);
    expect(snap.systemPrompt).not.toContain(TEXT_SEED);
    // 工具面：记忆装配 → 主会话声明面=注册面一致
    expect(snap.tools).toContain("memory_search");
  }, 20000);

  test("② SubAgent spawn：快照 tools 含 memory_search（worker 家族声明面）；提示零静态段", async () => {
    const rig = await makeRig();
    const sid = rig.daemon.system.getStatus().sessionId;
    const spawned = rig.daemon.orchestration.spawn("工具面声明验证", "subagent-worker");
    if (spawned.status !== "run") throw new Error(`spawn 被拒：${JSON.stringify(spawned)}`);
    const snap = await snapshotOf(rig.home, sid, (p) => (p as { instanceId?: string }).instanceId === spawned.agentId);

    expect(snap.tools).toContain("memory_search");
    expect(snap.systemPrompt).not.toContain(RETIRED_SECTION_HEADER);
    expect(snap.systemPrompt).not.toContain(TEXT_SEED);
  }, 20000);

  test("③ 未配置记忆的 daemon：主会话工具面剔除 memory_search（不广告未注册工具）；零注入痕迹", async () => {
    const rig = await makeRig({ seedMemory: false });
    const token = (await (await fetch(`http://127.0.0.1:${rig.daemon.ws.port}/helix-dev-token`)).text()).trim();
    const ws = new WebSocket(rig.daemon.ws.url);
    const frames: { type: string; payload: Record<string, unknown> }[] = [];
    ws.onmessage = (ev: MessageEvent) => frames.push(JSON.parse(String(ev.data)));
    await until(() => ws.readyState === WebSocket.OPEN, 3000, "WS 连接");
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } }));
    await until(() => frames.some((f) => f.type === "connection.welcome"), 3000, "welcome");
    const sid = frames.find((f) => f.type === "connection.welcome")!.payload.sessionId as string;
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "chat.send", payload: { draft: true, text: "促转正首条消息" } }));
    const snap = await mainSessionSnapshot(rig.home, sid);
    ws.close();

    expect(snap.tools).not.toContain("memory_search");
    expect(snap.systemPrompt).not.toContain(RETIRED_SECTION_HEADER);
  }, 20000);
});
