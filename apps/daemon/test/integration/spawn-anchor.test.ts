import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Database } from "bun:sqlite";
import type { Daemon } from "../../src/infrastructure/container";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { toSnapshotDto } from "../../src/adapters/driving/ws-server/DtoMapper";
import type {
  InstanceRunner,
  InstanceRunnerCallbacks,
  InstanceClosureOutcome,
} from "../../src/application/services/InstanceRunner";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import type { AgentInstanceDto, SessionSnapshotDto } from "@helix/protocol";
import { PROTOCOL_VERSION, type FrameVersion } from "@helix/protocol";
import { FakeAgentEngine, type ScriptedTurn } from "../mocks/FakeAgentEngine";

/**
 * T2.1 RED（契约 = PROTOCOL-CHANGELOG.md §12.1 spawn 锚点权威组装；test-design
 * TP-CL1-2/TP-CL1-3；真 SQLite tmp + FakeAgentEngine）：
 *
 * 三分支机械规则（DtoMapper.instanceDto 组装链路 + agent.spawned 增量帧）：
 * ① 实例已有 Entry → 首条非 compaction 归属 Entry 前最后一条 main/compaction
 *    entry id（无 → null 流首）；
 * ② 无 Entry 运行中实例 → spawn 时刻值（spawn 处理点计算一次随实例视图携带，
 *    不按当前尾部重算）；
 * ③ 主实例 → 不携带。
 *
 * 覆盖剧本：
 * - 语义：主实例消息后 spawn → 锚 = spawn 前最后一条 main entry id；实例首
 *   Entry 前有 compaction → 锚 = compaction id；流首 spawn → null；
 * - 确定性：同一聚合多次组装（getSnapshot × N）锚点逐实例同值；
 * - 稳定域：spawn 后/实例首 Entry 后主线继续追加消息 → 锚不变；
 * - 增量帧：agent.spawned 帧携带 spawn 时刻锚（与快照同源同值）；
 * - 恢复重放：spawn + 产 Entry 后重启 → 快照锚与实时一致；主实例/无 Entry
 *   实例边界（重启后仍无 Entry → 退化尾部推导，契约记录在案 best-effort）。
 */

/** 手动驱动 runner：launch 记录；引擎事件/收口由测试显式注入（时序权威）。 */
class ManualRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  readonly launched: string[] = [];
  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }
  launch(instance: { instanceId: string }): void {
    this.launched.push(instance.instanceId);
  }
  emit(instanceId: string, event: AgentEngineEvent): void {
    this.callbacks?.onInstanceEvent(instanceId, event);
  }
  forceClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    this.callbacks?.onInstanceClosure(instanceId, outcome);
  }
}

/** SubAgent 产出一条 assistant 消息（message_start → message_end；投影落聚合 entry `${id}#1`）。 */
function emitAssistantMessage(runner: ManualRunner, instanceId: string, text: string): void {
  runner.emit(instanceId, { type: "message_start", role: "assistant", source: "prompt" });
  runner.emit(instanceId, { type: "message_end", role: "assistant", text });
}

/** 进程内快照 DTO（走真组装链：buildView → toSnapshotDto，与 WS 下发同源）。 */
function snapshotDto(daemon: Daemon): SessionSnapshotDto {
  const view = daemon.session.getSnapshot();
  return toSnapshotDto(view, view.model ?? "test/model", "idle");
}

function instanceDtoOf(daemon: Daemon, instanceId: string): AgentInstanceDto | undefined {
  return snapshotDto(daemon).instances?.find((i) => i.instanceId === instanceId);
}

/** T10a：spawn 返回 agent-<唯一串>——捕获而非硬编码（status=rejected 时直接失败）。 */
function spawnAgent(rig: Rig, task: string): string {
  const o = rig.daemon.orchestration.spawn(task);
  if (o.status === "rejected") throw new Error(`spawn 被拒：${task}`);
  expect(o.agentId).toMatch(/^agent-[0-9a-f]+$/);
  return o.agentId;
}

/** T10a：主实例 id = 会话 mainInstanceId（agent-<唯一串>，非 "main" 字面）。 */
function mainIdOf(daemon: Daemon): string {
  const sid = daemon.system.getStatus().sessionId;
  const id = daemon.registry.peek(sid)!.chatService.sessionView.mainInstanceId;
  expect(id).toMatch(/^agent-[0-9a-f]+$/);
  return id;
}

/** 确定性断言：同一聚合连续 N 次组装，锚点逐实例同值。 */
function expectDeterministicAnchor(daemon: Daemon, instanceId: string, expected: string | null): void {
  for (let i = 0; i < 3; i++) {
    expect(instanceDtoOf(daemon, instanceId)?.anchorEntryId).toBe(expected);
  }
}

interface Rig {
  home: string;
  daemon: Daemon;
  runner: ManualRunner;
  dispose: () => Promise<void>;
}

let rigs: Rig[] = [];
afterEach(async () => {
  const pending = rigs;
  rigs = [];
  for (const rig of pending) await rig.dispose();
});

async function makeRig(replies: ScriptedTurn[] = [], home?: string): Promise<Rig> {
  const homeDir = home ?? mkdtempSync(path.join(tmpdir(), "helix-t21-anchor-"));
  const runner = new ManualRunner();
  const daemon = await createTestDaemon({
    home: homeDir,
    engine: new FakeAgentEngine({ replies }),
    skipConfig: true,
    port: 0,
    subagentRunner: runner,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
  });
  const rig: Rig = {
    home: homeDir,
    daemon,
    runner,
    dispose: async () => {
      await daemon.shutdown();
      rmSync(homeDir, { recursive: true, force: true });
    },
  };
  rigs.push(rig);
  return rig;
}

/** 收集帧的 loopback WS 测试客户端（同 agent-ws 模式）。 */
class TestClient {
  readonly frames: { v: FrameVersion; type: string; instanceId?: string; payload: Record<string, unknown> }[] = [];
  private readonly ws: WebSocket;

  constructor(url: string, token: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "hello", payload: { token, protocolVersion: PROTOCOL_VERSION } }));
    };
    this.ws.onmessage = (ev: MessageEvent) => {
      this.frames.push(JSON.parse(String(ev.data)));
    };
  }

  async expect(type: string, timeoutMs = 5000): Promise<{ type: string; instanceId?: string; payload: Record<string, unknown> }> {
    await until(() => this.frames.some((f) => f.type === type), timeoutMs, `等待帧 ${type}`);
    return this.frames.find((f) => f.type === type)!;
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) await this.ws.close();
  }
}

function until(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`等待超时：${what}（${timeoutMs}ms）`));
      }
    }, 5);
  });
}

// ── 语义剧本（规则 ①/②/③）+ 确定性 + 稳定域 ─────────────────────────

describe("T2.1 锚点语义三分支（契约 v0.3 §1）", () => {
  test("流首 spawn（无任何 main entry）→ anchorEntryId=null；主实例不携带；多次组装同值", async () => {
    const rig = await makeRig();
    const agentId = spawnAgent(rig, "流首任务");

    expect(instanceDtoOf(rig.daemon, agentId)?.anchorEntryId).toBeNull();
    // 规则③：主实例不携带（undefined，键不存在）
    const main = instanceDtoOf(rig.daemon, mainIdOf(rig.daemon));
    expect(main).toBeDefined();
    expect("anchorEntryId" in main!).toBe(false);
    expectDeterministicAnchor(rig.daemon, agentId, null);
  });

  test("主实例消息后 spawn → 锚 = spawn 前最后一条 main entry id；主线继续追加锚不变（规则② spawn 时值）", async () => {
    const rig = await makeRig([{ text: "回复一" }, { text: "回复二" }]);
    await rig.daemon.chat.sendMessage("消息一"); // e1(user) + e2(assistant)

    const agentId = spawnAgent(rig, "锚点任务");
    expect(instanceDtoOf(rig.daemon, agentId)?.anchorEntryId).toBe("e2");

    // 稳定域：spawn 后主线继续追加（e3/e4），无 Entry 实例锚保持 spawn 时值
    await rig.daemon.chat.sendMessage("消息二");
    expectDeterministicAnchor(rig.daemon, agentId, "e2");
  });

  test("实例首 Entry 前有 compaction → 锚 = compaction id（规则①）；首 Entry 前锚保持 spawn 时值", async () => {
    const rig = await makeRig([
      { text: "回复一" },
      { text: "回复二", compaction: { tokensBefore: 100, tokensAfter: 40, summary: "压缩摘要" } },
    ]);
    await rig.daemon.chat.sendMessage("消息一"); // e1 + e2
    const agentId = spawnAgent(rig, "compaction 前锚点任务");
    expect(instanceDtoOf(rig.daemon, agentId)?.anchorEntryId).toBe("e2");

    // 主线第二轮 + turn 边界 compaction（e3/e4 + compaction entry）
    await rig.daemon.chat.sendMessage("消息二");
    // 规则②：实例尚无 Entry——锚保持 spawn 时值，不按当前尾部（compaction）重算
    expect(instanceDtoOf(rig.daemon, agentId)?.anchorEntryId).toBe("e2");

    // 实例产出首 Entry → 规则①接管：首 Entry 前最后一条 main/compaction = compaction
    emitAssistantMessage(rig.runner, agentId, "SubAgent 结论");
    const compactionId = snapshotDto(rig.daemon).entries.find((e) => e.kind === "compaction")?.id;
    expect(compactionId).toBeDefined();
    expectDeterministicAnchor(rig.daemon, agentId, compactionId!);
  });

  test("实例产 Entry 后锚 = 首 Entry 前最后 main entry；后续主线追加不影响（[0, firstIdx) 稳定域）", async () => {
    const rig = await makeRig([{ text: "回复一" }, { text: "回复二" }]);
    await rig.daemon.chat.sendMessage("消息一"); // e1 + e2
    const agentId = spawnAgent(rig, "稳定域任务");
    emitAssistantMessage(rig.runner, agentId, "SubAgent 首条结论");
    expect(instanceDtoOf(rig.daemon, agentId)?.anchorEntryId).toBe("e2");

    // 首 Entry 后 append 的 main entry 不进 [0, firstIdx) → 锚不变
    await rig.daemon.chat.sendMessage("消息二"); // e3 + e4
    expectDeterministicAnchor(rig.daemon, agentId, "e2");
  });
});

// ── 增量帧：agent.spawned 携带 spawn 时刻锚（契约 §1 下发面②） ────────

describe("T2.1 agent.spawned 增量帧锚点（真实 WS 连接）", () => {
  test("流首 spawn → 帧 anchorEntryId=null；主实例消息后 spawn → 帧锚=最后 main entry 且与快照同值", async () => {
    const rig = await makeRig([{ text: "回复一" }]);
    const token = readFileSync(path.join(rig.home, "dev-token"), "utf8").trim();

    // ① 流首 spawn → null
    const c1 = new TestClient(rig.daemon.ws.url, token);
    try {
      // T4：零条目草稿握手不 attach——显式订阅当前会话后再观测 spawn 帧
      const welcome1 = await c1.expect("connection.welcome");
      if (welcome1.payload.draft === true) {
        c1.send({ v: 0, type: "session.subscribe", payload: {} });
      }
      await c1.expect("session.snapshot");
      const agentId1 = spawnAgent(rig, "流首 WS 任务");
      const spawnedNull = await c1.expect("agent.spawned");
      expect(spawnedNull.instanceId).toBe(agentId1);
      expect(spawnedNull.payload["anchorEntryId"]).toBeNull();
      expect(instanceDtoOf(rig.daemon, agentId1)?.anchorEntryId).toBeNull(); // 帧 ↔ 快照同值
    } finally {
      await c1.close();
    }

    // ② 主实例消息后 spawn → 帧锚 = e2（spawn 前最后一条 main entry）
    await rig.daemon.chat.sendMessage("消息一"); // e1 + e2
    const c2 = new TestClient(rig.daemon.ws.url, token);
    try {
      await c2.expect("session.snapshot");
      const agentId2 = spawnAgent(rig, "有锚 WS 任务");
      const spawned = await c2.expect("agent.spawned");
      expect(spawned.instanceId).toBe(agentId2);
      expect(spawned.payload["anchorEntryId"]).toBe("e2");
      expect(instanceDtoOf(rig.daemon, agentId2)?.anchorEntryId).toBe("e2"); // 帧 ↔ 快照同值

      // ③ WS 快照面下发：重连握手快照 instances 携带同值锚
      emitAssistantMessage(rig.runner, agentId2, "WS 实例结论");
      const c3 = new TestClient(rig.daemon.ws.url, token);
      try {
        const snapFrame = await c3.expect("session.snapshot");
        const instances = (snapFrame.payload["snapshot"] as { instances?: AgentInstanceDto[] }).instances ?? [];
        const dto = instances.find((i) => i.instanceId === agentId2);
        expect(dto?.anchorEntryId).toBe("e2");
        const main = instances.find((i) => i.instanceId === mainIdOf(rig.daemon));
        expect(main !== undefined && "anchorEntryId" in main).toBe(false); // 主实例不携带
      } finally {
        await c3.close();
      }
    } finally {
      await c2.close();
    }
  }, 15000);
});

// ── T6：spawn 锚扫描面含 tool 调用记录（实时路径 ↔ 快照路径同源） ──
// bug 复现：SubAgent 卡片实时渲染在 agent_spawn 工具调用之前（切 session 走
// 快照后正常）——实时锚（computeSpawnAnchor）原只扫 domain entries，tool 执行
// 不落 Entry → spawn 时刻锚落在 spawn 工具调用之前。修复后两路径同源：domain
// entries + toolCall 记录按时间合并后取最后 main 锚 = agent_spawn 工具调用自身。

describe("T6 spawn 锚扫描面含 tool 调用记录（实时路径 = 快照路径合并流同源）", () => {
  test("主 turn 中 agent_spawn 工具 tool_execution_start 已记录后 spawn → 锚 = 该 toolCallId（非用户/早期 entry）", async () => {
    const rig = await makeRig([
      { toolCalls: [{ toolName: "agent_spawn", args: { task: "子任务" }, durationMs: 300 }], text: "完成" },
    ]);
    const run = rig.daemon.chat.sendMessage("派一个子代理"); // e1(user) 落聚合后开 turn（不 await——工具窗口内 spawn）
    // pi 事件序：tool_execution_start（同步建 ToolCallRecord）→ 工具 execute 内调 spawn
    await until(() => rig.daemon.session.getSnapshot().toolCalls.length > 0, 3000, "等待 toolCall 记录落地");
    const toolCallId = rig.daemon.session.getSnapshot().toolCalls[0]!.id;

    const agentId = spawnAgent(rig, "工具执行窗口内 spawn");
    // 锚 = agent_spawn 工具调用自身 entry id（快照路径同语义）；修复前 = e1（用户消息）
    expect(instanceDtoOf(rig.daemon, agentId)?.anchorEntryId).toBe(toolCallId);
    await run; // turn 收尾（assistant e2）
  }, 10000);

  test("边界：tool 轮次完成后 spawn → 锚 = tool 之后 assistant entry（合并流时间序，无 toolCall 面行为不退化）", async () => {
    const rig = await makeRig([
      { toolCalls: [{ toolName: "web_search", durationMs: 5 }], text: "回复一" },
    ]);
    await rig.daemon.chat.sendMessage("消息一"); // e1(user) + [tc-1 tool] + assistant（id 预分配跳号）
    // 合并流按时间升序：tool 记录插在 user/assistant 之间，最后 main 锚仍是
    // 主轴尾 entry（与修复前一致——从快照主轴取期望，不硬编码跳号后 id）
    const tailMainId = snapshotDto(rig.daemon).entries.at(-1)?.id;
    expect(tailMainId).toBeDefined();
    const agentId = spawnAgent(rig, "tool 完成后 spawn");
    expect(instanceDtoOf(rig.daemon, agentId)?.anchorEntryId).toBe(tailMainId!);
  });
});

// ── 恢复重放：同源同值 + 边界（契约 §1 恢复重放边界记录在案） ─────────

describe("T2.1 恢复重放锚点（真 SQLite tmp 重启）", () => {
  test("spawn + 产 Entry 后重启：快照锚与实时一致（同源断言）；主实例不携带", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t21-anchor-restore-"));
    const rig1 = await makeRig([{ text: "回复一" }], home);
    await rig1.daemon.chat.sendMessage("消息一"); // e1 + e2
    const agentId = spawnAgent(rig1, "恢复锚点任务");
    emitAssistantMessage(rig1.runner, agentId, "恢复前结论");
    const before = instanceDtoOf(rig1.daemon, agentId)?.anchorEntryId;
    expect(before).toBe("e2");
    await rig1.daemon.shutdown();

    // 重启恢复（同一 home：session_state + agent_lifecycle + domain_events 重放）
    const rig2 = await makeRig([], home);
    rig2.dispose = async () => {
      await rig2.daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    };
    const after = instanceDtoOf(rig2.daemon, agentId);
    expect(after).toBeDefined();
    expect(after?.anchorEntryId).toBe(before); // 恢复重放与实时路径同锚
    const main = instanceDtoOf(rig2.daemon, mainIdOf(rig2.daemon));
    expect(main !== undefined && "anchorEntryId" in main).toBe(false);
    expectDeterministicAnchor(rig2.daemon, agentId, before!);

    // 锚点不持久化（E-AgentInstance 禁忌）：domain_events 的 agent.spawned 载荷
    // 不含 anchorEntryId（帧锚点走 adapter 层 enrichment，非领域事件载荷）
    const db = new Database(path.join(home, "helix.db"), { readonly: true });
    try {
      const rows = db
        .prepare("SELECT payload FROM domain_events WHERE type = 'agent.spawned'")
        .all() as { payload: string }[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.payload).not.toContain("anchorEntryId");
    } finally {
      db.close();
    }
  }, 20000);

  test("边界：重启后仍无 Entry 的实例 spawn 时值不可重建 → 退化尾部推导值（契约记录在案）", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t21-anchor-boundary-"));
    const rig1 = await makeRig([{ text: "回复一" }], home);
    await rig1.daemon.chat.sendMessage("消息一"); // e1 + e2
    const agentId = spawnAgent(rig1, "无 Entry 边界任务"); // 不产 Entry（挂起）
    // 实时路径规则②：锚 = spawn 时值 e2
    expect(instanceDtoOf(rig1.daemon, agentId)?.anchorEntryId).toBe("e2");
    await rig1.daemon.shutdown();

    const rig2 = await makeRig([], home);
    rig2.dispose = async () => {
      await rig2.daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    };
    const restored = instanceDtoOf(rig2.daemon, agentId);
    expect(restored).toBeDefined();
    expect(restored?.state).toBe("failed"); // running → 重启收口（AD-10）
    // 退化规则①尾部推导：= 恢复后聚合内最后一条 main entry（重启 closure 注入
    // 的 steer 条目）——与 spawn 时值不同属契约已记录的 best-effort 边界
    const entries = snapshotDto(rig2.daemon).entries;
    const tailMainId = entries[entries.length - 1]?.id;
    expect(tailMainId).toBeDefined();
    expect(restored?.anchorEntryId).toBe(tailMainId);
  }, 20000);
});
