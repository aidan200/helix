/**
 * 编码 agent 长期记忆只读召回批 D 组装面集成（container 接线 E2E）。
 *
 * 断言面（brief 测试要求①②③——组装链视角）：
 * 1. 主会话（零足迹冷启动）：agent.instantiated 快照 systemPrompt 含
 *    「用户偏好与工作状态」召回段 + 权威声明句；无项目上下文 → 仅 global
 *    （项目条目不注入——与常驻规则「空足迹不注入」的语义分叉：记忆段
 *    global 恒注入，用户画像跨项目成立）；
 * 2. SubAgent（派发会话足迹后 spawn）：快照含段 + global 条目 + 本项目
 *    fact；他项目条目与 progress 不注入；
 * 3. 未配置记忆的 daemon（memory.* 缺席）：零注入痕迹（段整体省略）。
 *
 * 装置：daemon 启动前 pre-seed home（helix.db 三行 KV + steward_memory.db
 * 真库条目）——agentRecallSection 不调 embedding，端点条目只需存在即可
 * 满足 isAvailable 闸（开关 ∧ endpointId 有效 ∧ 存储装配）。
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

const SECTION_HEADER = "用户偏好与工作状态";

/** 预置记忆条目文本（断言锚点）。 */
const TEXT_GLOBAL_PREF = "全局偏好：交付前先跑全量测试再收口";
const TEXT_PROJ_A_FACT = "projA 用 bun 跑测试";
const TEXT_PROJ_B_FACT = "projB 专属事实不应出现在编码 agent 提示";
const TEXT_PROGRESS = "会话进展快照不应注入编码 agent";

/** pre-seed home：KV 三行（开关 + 端点引用 + 端点表）+ 记忆真库四条。 */
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

  const workspace = path.join(home, "ws");
  const projA = path.join(workspace, "projA");
  const projB = path.join(workspace, "projB");
  const now = Date.now();
  const store = new SqliteVecMemoryStore(path.join(home, "steward_memory.db"), getLoadablePath());
  const v = Float32Array.from([1, 0, 0]);
  store.append([
    { kind: "preference", text: TEXT_GLOBAL_PREF, source: "steward-turn", createdAt: now - 3_600_000, vector: v, projectScope: MEMORY_SCOPE_GLOBAL },
    { kind: "fact", text: TEXT_PROJ_A_FACT, source: "steward-turn", createdAt: now - 3_600_000, vector: v, projectScope: "projA" },
    { kind: "fact", text: TEXT_PROJ_B_FACT, source: "steward-turn", createdAt: now - 3_600_000, vector: v, projectScope: "projB" },
    { kind: "progress", text: TEXT_PROGRESS, source: "session-progress", createdAt: now, vector: v, projectScope: "projA", sessionId: "sess-seed" },
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
  readonly sessionId: string;
  readonly instanceId: string;
  readonly systemPrompt: string;
}

/** 轮询 domain_events 取实例的 agent.instantiated 快照 systemPrompt。 */
async function snapshotSystemPrompt(
  home: string,
  sessionId: string,
  instanceId: string,
): Promise<string> {
  const repo = new SqliteSessionRepository(new WriteQueue(path.join(home, "helix.db")));
  let found: string | undefined;
  try {
    await until(
      () => {
        const hit = repo
          .queryEvents({ sessionId })
          .find((e) => e.type === "agent.instantiated" && (e.payload as { instanceId?: string }).instanceId === instanceId);
        if (hit !== undefined) {
          found = (hit.payload as { profileSnapshot: { systemPrompt: string } }).profileSnapshot.systemPrompt;
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
async function mainSessionPrompt(home: string, sessionId: string): Promise<string> {
  const repo = new SqliteSessionRepository(new WriteQueue(path.join(home, "helix.db")));
  let found: string | undefined;
  try {
    await until(
      () => {
        const hit = repo
          .queryEvents({ sessionId })
          .find(
            (e) =>
              e.type === "agent.instantiated" &&
              (e.payload as { profileKind?: string }).profileKind === "main-session",
          );
        if (hit !== undefined) {
          found = (hit.payload as { profileSnapshot: { systemPrompt: string } }).profileSnapshot.systemPrompt;
          return true;
        }
        return false;
      },
      5000,
      "主会话 agent.instantiated 落盘",
    );
    return found!;
  } finally {
    await (repo as unknown as { dispose?: () => void }).dispose?.();
  }
}

interface Rig {
  readonly home: string;
  readonly daemon: Daemon;
  readonly workspace: string;
  dispose(): Promise<void>;
}

const rigs: Rig[] = [];

async function makeRig(opts: { seedMemory?: boolean } = {}): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-agent-memory-"));
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

describe("编码 agent 记忆召回·组装链接线（container E2E）", () => {
  test("① 主会话零足迹冷启动：段出现且仅 global（权威声明 + 项目条目不注入）", async () => {
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
    const prompt = await mainSessionPrompt(rig.home, sid);
    ws.close();

    expect(prompt).toContain(SECTION_HEADER);
    expect(prompt).toContain("知识图谱"); // 权威声明句
    expect(prompt).toContain(TEXT_GLOBAL_PREF);
    // 零足迹 → 仅 global：项目条目与 progress 全部不注入
    expect(prompt).not.toContain(TEXT_PROJ_A_FACT);
    expect(prompt).not.toContain(TEXT_PROJ_B_FACT);
    expect(prompt).not.toContain(TEXT_PROGRESS);
  }, 20000);

  test("② SubAgent 派发足迹后 spawn：global + 本项目入选、他项目与 progress 排除", async () => {
    const rig = await makeRig();
    const sid = rig.daemon.system.getStatus().sessionId;
    // 注足迹（模拟主会话写过 projA 文件——writeFacts 精确记账通道）
    rig.daemon.writeFacts.record({
      instanceId: sid,
      sessionId: sid,
      path: path.join(rig.workspace, "projA", "src", "a.ts"),
      at: Date.now(),
      confidence: "precise",
    });
    const spawned = rig.daemon.orchestration.spawn("足迹后 spawn 验证", "subagent-worker");
    if (spawned.status !== "run") throw new Error(`spawn 被拒：${JSON.stringify(spawned)}`);
    const prompt = await snapshotSystemPrompt(rig.home, sid, spawned.agentId);

    expect(prompt).toContain(SECTION_HEADER);
    expect(prompt).toContain("知识图谱");
    expect(prompt).toContain(TEXT_GLOBAL_PREF);
    expect(prompt).toContain(TEXT_PROJ_A_FACT);
    expect(prompt).not.toContain(TEXT_PROJ_B_FACT);
    expect(prompt).not.toContain(TEXT_PROGRESS);
  }, 20000);

  test("③ 未配置记忆的 daemon：零注入痕迹（段整体省略不炸主链路）", async () => {
    const rig = await makeRig({ seedMemory: false });
    const sid = rig.daemon.system.getStatus().sessionId;
    const spawned = rig.daemon.orchestration.spawn("无记忆配置验证", "subagent-worker");
    if (spawned.status !== "run") throw new Error(`spawn 被拒：${JSON.stringify(spawned)}`);
    const prompt = await snapshotSystemPrompt(rig.home, sid, spawned.agentId);
    expect(prompt).not.toContain(SECTION_HEADER);
  }, 20000);
});
