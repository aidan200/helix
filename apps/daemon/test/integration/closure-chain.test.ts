import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";
import type { Model } from "@earendil-works/pi-ai";
import { createTestDaemon } from "../helpers/createTestDaemon";
import type { TestDaemonOptions } from "../helpers/createTestDaemon";
import type { Daemon } from "../../src/infrastructure/container";
import type { InstanceRunner, InstanceRunnerCallbacks, InstanceClosureOutcome } from "../../src/application/services/InstanceRunner";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { KgDatabase, kgDbPath } from "../../src/adapters/driven/sqlite-kg/KgDatabase";
import { SqliteKnowledgeStore } from "../../src/adapters/driven/sqlite-kg/SqliteKnowledgeStore";
import { KgWriteService } from "../../src/application/services/kg/KgWriteService";
import type { KnowledgeWriteOp } from "../../src/domain/kg/types";

/**
 * T2.3 closure 双通道 integration（test-design §2.1 F1.5/F1.6 + §4.1-3；
 * AD-8：SteerQueue 注入唯一入口进主线 + agent.completed 用户通道）。
 *
 * 真组合根（createDaemon + FakeAgentEngine 主线 + ScriptedRunner SubAgent）：
 * ① 收口后主线新 turn 立即开（idle 语义）且上下文含 "agent-N closure: …"；
 * ② agent.completed 事件携带五字段 ClosureDto + O-5 双产物（closure_records
 *    行 + <home>/reports/<session>/<agentId>.md 文件，重启后可读）；
 * ③ 用户 steer 先入、closure 注入后入 → 同队列 FIFO 按序 drain（不丢失）；
 * ④ SubAgent 内部工具调用只进 per-instance 事件流（挂 instanceId 落盘），
 *    主线聚合与 MainAgent 上下文零混入；
 * ⑤ kill 全链（FB-3：runner.kill 先行）+ closure failed 注入主线。
 */

/** 测试驱动收口时序的 SubAgent runner 替身（经 container 注入口装配）。 */
class ScriptedRunner implements InstanceRunner {
  private callbacks?: InstanceRunnerCallbacks;
  private readonly closed = new Set<string>();
  readonly launched: { instanceId: string; task: string }[] = [];
  readonly sends: { instanceId: string; text: string }[] = [];
  readonly kills: string[] = [];

  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }
  launch(instance: { instanceId: string }, task: string): void {
    this.launched.push({ instanceId: instance.instanceId, task });
    // 不自动收口（挂起语义）：closure 由测试 forceClosure 驱动
  }
  send(instanceId: string, text: string): void {
    this.sends.push({ instanceId, text });
  }
  kill(instanceId: string): Promise<unknown> {
    this.kills.push(instanceId);
    return Promise.resolve("graceful");
  }
  emitEngineEvent(instanceId: string, event: AgentEngineEvent): void {
    this.callbacks?.onInstanceEvent(instanceId, event);
  }
  forceClosure(instanceId: string, outcome: InstanceClosureOutcome): void {
    if (this.closed.has(instanceId)) return;
    this.closed.add(instanceId);
    this.callbacks?.onInstanceClosure(instanceId, outcome);
  }
}

const DONE = (summary: string) => ({
  status: "done" as const,
  summary,
  reportPath: null,
  findings: [{ kind: "sediment", changeType: "新增" }] as unknown[],
  taskId: "T2.3",
});

interface Rig {
  home: string;
  sessionId: string;
  engine: FakeAgentEngine;
  runner: ScriptedRunner;
  daemon: Daemon;
  dispose: () => Promise<void>;
}

async function makeRig(engineOptions: { replies?: never[] } = {}): Promise<Rig> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-t23-closure-"));
  const engine = new FakeAgentEngine(engineOptions.replies ? { replies: engineOptions.replies } : {});
  const runner = new ScriptedRunner();
  const daemon = await createTestDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    subagentRunner: runner,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
    // D8 W-R3 后 cwd（主树/worktree）可能携带真实 kg 项目——绑定 tmp home 隔离
    //（任务切片注入零命中，TR-TEST-4 密闭性）。
    kgWorkspaceRoot: home,
  });
  return {
    home,
    sessionId: daemon.system.getStatus().sessionId,
    engine,
    runner,
    daemon,
    dispose: async () => {
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function until(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (cond()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`until 超时：${label}（${timeoutMs}ms）`));
      }
    }, 5);
  });
}

/** 主线会话快照（SessionPort 观测面）。 */
function snapshot(rig: Rig) {
  return rig.daemon.session.getSnapshot();
}

/** daemon db 只读连接（WAL 并发读；落盘断言输入）。 */
function readonlyDb(rig: Rig): Database {
  return new Database(path.join(rig.home, "helix.db"), { readonly: true });
}

/** 某类型领域事件行（落盘后；payload 已解析）。 */
function eventRows(rig: Rig, type: string): { instance_id: string; payload: Record<string, unknown> }[] {
  const db = readonlyDb(rig);
  try {
    const raw = db
      .prepare("SELECT agent_instance_id AS instance_id, payload FROM domain_events WHERE type = ? ORDER BY id")
      .all(type) as { instance_id: string; payload: string }[];
    return raw.map((r) => ({ instance_id: r.instance_id, payload: JSON.parse(r.payload) as Record<string, unknown> }));
  } finally {
    db.close();
  }
}

let current: Rig | undefined;
afterEach(async () => {
  if (current) {
    await current.dispose();
    current = undefined;
  }
});

describe("① closure 注入驱动主线新 turn（idle 语义）", () => {
  test("spawn 秒回 → forceClosure → 主线立即新 turn，上下文含 closure 注入文本", async () => {
    const rig = (current = await makeRig());
    expect(rig.daemon.system.getStatus().agentState).toBe("idle");

    const outcome = rig.daemon.orchestration.spawn("调研调度器现状");
    expect(outcome.status).toBe("run");
    if (outcome.status !== "run") throw new Error("unreachable");
    const agentId = outcome.agentId; // T10a：agent-<唯一串>，捕获而非硬编码
    expect(agentId).toMatch(/^agent-[0-9a-f]+$/);
    expect(rig.runner.launched).toEqual([{ instanceId: agentId, task: "调研调度器现状" }]);

    rig.runner.forceClosure(agentId, { result: "done", closure: DONE("调研完成，结论 X") });

    // idle 注入 = 立即新 turn（sendMessage 路径）→ run 结束回 idle
    await until(() => rig.daemon.system.getStatus().agentState === "idle", 5000, "closure 注入新 turn 完成");
    const entries = snapshot(rig).session.entries;
    const closureEntry = entries.find((e): e is (typeof entries)[number] & { role: "user" | "assistant"; text: string } => "role" in e && e.text.includes(`${agentId} closure: done — 调研完成，结论 X`));
    expect(closureEntry).toBeDefined(); // MainAgent 下一 turn 上下文含注入
    expect(closureEntry?.role).toBe("user");
    // 新 turn 确实执行了（assistant 回复在 closure entry 之后）
    const idx = entries.findIndex((e) => e === closureEntry);
    expect(entries.slice(idx + 1).some((e) => "role" in e && e.role === "assistant")).toBe(true);
  }, 12000);
});

describe("② agent.completed 五字段 ClosureDto + O-5 双产物", () => {
  test("收口 → 事件落盘（closure 显式 null/值齐备）+ closure_records 行 + 报告文件可读", async () => {
    const rig = (current = await makeRig());
    const spawn2 = rig.daemon.orchestration.spawn("生成报告的任务");
    if (spawn2.status !== "run") throw new Error("unreachable");
    const agentId = spawn2.agentId; // T10a：agent-<唯一串>
    rig.runner.forceClosure(agentId, { result: "done", closure: DONE("报告任务完成") });

    await until(() => eventRows(rig, "agent.completed").length > 0, 5000, "agent.completed 落盘");
    const completed = eventRows(rig, "agent.completed")[0]!;
    expect(completed.instance_id).toBe(agentId);
    const closure = completed.payload["closure"] as Record<string, unknown>;
    expect(closure).toEqual({
      status: "done",
      summary: "报告任务完成",
      reportPath: path.join(rig.home, "reports", rig.sessionId, `${agentId}.md`), // O-5：<home>/reports/<session>/<agentId>.md
      findings: [{ kind: "sediment", changeType: "新增" }],
      taskId: "T2.3",
    });

    // O-5 任务报告本体：closure_records 行（findings 保 JSON）
    await until(() => {
      const db = readonlyDb(rig);
      try {
        return (db.prepare("SELECT COUNT(*) AS c FROM closure_records").get() as { c: number }).c > 0;
      } finally {
        db.close();
      }
    }, 5000, "closure_records 落盘");
    const db = readonlyDb(rig);
    const record = db
      .prepare("SELECT result, status, summary, report_path, findings, task_id FROM closure_records WHERE agent_id = ?")
      .get(agentId) as { result: string; status: string; summary: string; report_path: string; findings: string; task_id: string };
    db.close();
    expect(record).toMatchObject({ result: "done", status: "done", summary: "报告任务完成", task_id: "T2.3" });
    expect(JSON.parse(record.findings)).toEqual([{ kind: "sediment", changeType: "新增" }]);

    // O-5 文件产物：报告 markdown 存在且含摘要/findings（重启后仍可读——文件在磁盘）
    const reportPath = path.join(rig.home, "reports", rig.sessionId, `${agentId}.md`);
    expect(existsSync(reportPath)).toBe(true);
    const content = readFileSync(reportPath, "utf8");
    expect(content).toContain(agentId);
    expect(content).toContain("报告任务完成");
    expect(content).toContain("sediment");
  }, 12000);
});

describe("③ 用户 steer 与 closure 注入混序 FIFO（同队列按序 drain，不丢失）", () => {
  test("用户 steer 先入 → closure 后入 → drain 顺序用户在前、closure 在后", async () => {
    const engine = new FakeAgentEngine({
      // 首轮带长工具（2s 窗口供注入），后续 steer drain 轮用默认回复
      replies: [{ text: "开工", toolCalls: [{ toolName: "work", durationMs: 2000 }] }],
    });
    const home = mkdtempSync(path.join(tmpdir(), "helix-t23-fifo-"));
    const runner = new ScriptedRunner();
    const daemon = await createTestDaemon({
      home,
      engine,
      skipConfig: true,
      port: 0,
      subagentRunner: runner,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    current = {
      home,
      sessionId: daemon.system.getStatus().sessionId,
      engine,
      runner,
      daemon,
      dispose: async () => {
        await daemon.shutdown();
        rmSync(home, { recursive: true, force: true });
      },
    };
    const rig = current;

    void daemon.chat.sendMessage("开始调研").catch(() => undefined);
    await until(() => engine.isStreaming(), 3000, "主线 run 开始");
    const spawn3 = rig.daemon.orchestration.spawn("并行调研任务"); // SubAgent 出卡（与主线 run 并行）
    if (spawn3.status !== "run") throw new Error("unreachable");
    const agentId = spawn3.agentId; // T10a：agent-<唯一串>

    // ① 用户 steer 先入队
    await daemon.chat.steer("用户补充：注意边界情况");
    // ② closure 注入后入队（同一 domain SteerQueue）
    rig.runner.forceClosure(agentId, { result: "done", closure: { ...DONE("调研完成"), findings: null } });

    // 注入即时可见：pendingSteer 按入队序 = [用户补充, closure]（source 可区分）
    // F3.0（T4.1）：注入行 = 一行通知 + reportPath 指针行（无自报 → 兜底路径也走指针）
    const fallbackReport = path.join(home, "reports", daemon.system.getStatus().sessionId, `${agentId}.md`);
    const pending = daemon.session.getSnapshot().session.pendingSteer;
    expect(pending.map((i) => i.text)).toEqual([
      "用户补充：注意边界情况",
      `${agentId} closure: done — 调研完成\n详情: ${fallbackReport} — 需要细节时 read`,
    ]);
    expect(pending[0]?.source).toBe("user"); // 用户 steer 来源显式标记（T11a）
    expect(pending[1]?.source).toBe("closure"); // closure 注入来源可区分（AD-8）

    // drain 按序消费（one-at-a-time，每条独占一 turn）→ run 结束
    await until(() => daemon.system.getStatus().agentState === "idle", 10000, "主线 run 结束");
    const drainedUserTexts = engine.events
      .filter((e) => e.type === "message_end" && e.role === "user")
      .map((e) => (e as { text: string }).text);
    expect(drainedUserTexts).toEqual([
      "开始调研",
      "用户补充：注意边界情况", // FIFO：用户 steer 在前
      `${agentId} closure: done — 调研完成\n详情: ${fallbackReport} — 需要细节时 read`, // closure 在后，均被消费（不丢失）
    ]);
    // 两注入各开新 turn（每条 steer 独占一 turn，§5.3-4）
    expect(daemon.session.getSnapshot().session.turns.length).toBe(3);
  }, 20000);
});

describe("④ SubAgent 实例事件进 per-instance 面（AD-8 → AD-3 演进，T2.1）", () => {
  test("工具事件挂 instanceId 落盘广播 + 会话投影落记录；主线 turn 与 MainAgent 上下文零混入", async () => {
    const rig = (current = await makeRig());
    const spawn4 = rig.daemon.orchestration.spawn("用工具调研");
    if (spawn4.status !== "run") throw new Error("unreachable");
    const agentId = spawn4.agentId; // T10a：agent-<唯一串>
    expect(rig.runner.launched.length).toBe(1);

    // SubAgent 内部工具调用（引擎事件上行 → per-instance 领域事件）
    rig.runner.emitEngineEvent(agentId, {
      type: "tool_execution_start",
      toolCallId: "sub-tc-1",
      toolName: "grep",
      args: { pattern: "closure" },
    });
    rig.runner.emitEngineEvent(agentId, {
      type: "tool_execution_end",
      toolCallId: "sub-tc-1",
      toolName: "grep",
      isError: false,
      result: "closure-chain.test.ts:1",
    });

    await until(() => eventRows(rig, "tool.call.result").length > 0, 5000, "SubAgent 工具事件落盘");
    const started = eventRows(rig, "tool.call.started")[0]!;
    const result = eventRows(rig, "tool.call.result")[0]!;
    expect(started.instance_id).toBe(agentId); // 挂 instanceId 落盘（四维可查）
    expect(result.instance_id).toBe(agentId);
    expect(started.payload).toMatchObject({ toolCallId: "sub-tc-1", toolName: "grep" });
    expect(result.payload).toMatchObject({ toolCallId: "sub-tc-1", args: { pattern: "closure" }, result: "closure-chain.test.ts:1", isError: false });

    // T2.1（AD-3）：会话投影消费工具事件 → SubAgent 工具记录进快照取数面
    //（instanceId 行级归属 agent-1；主线工具记录仍在 ChatService——此处主线
    // 无工具，故快照 toolCalls 恰为该 SubAgent 记录）
    const toolCalls = snapshot(rig).toolCalls;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.id).toBe("sub-tc-1");
    expect(toolCalls[0]!.instanceId).toBe(agentId);
    expect(toolCalls[0]!.status).toBe("completed");

    // MainAgent 上下文零混入：SubAgent 消息 Entry 不挂主线 turn；主线未开任何
    // turn（closure 未发生）——工具记录经 per-instance 面（instances[].channels/
    // 实例抽屉），不进主线消息流
    expect(snapshot(rig).session.turns).toEqual([]);
    expect(snapshot(rig).session.entries.filter((e) => e.instanceId === agentId)).toEqual([]);
  }, 12000);
});

describe("⑤ kill 全链（FB-3：runner.kill 先行 + closure failed 注入主线）", () => {
  test("port.kill → runner.kill 收到 → agent.killed(closure failed) → 注入主线新 turn", async () => {
    const rig = (current = await makeRig());
    const spawn5 = rig.daemon.orchestration.spawn("会被终止的任务");
    if (spawn5.status !== "run") throw new Error("unreachable");
    const agentId = spawn5.agentId; // T10a：agent-<唯一串>

    const outcome = rig.daemon.orchestration.kill(agentId);
    expect(outcome).toEqual({ killed: true });
    expect(rig.runner.kills).toEqual([agentId]); // FB-3：终止信号已发 runner（子进程不再空跑）

    await until(() => eventRows(rig, "agent.killed").length > 0, 5000, "agent.killed 落盘");
    const killed = eventRows(rig, "agent.killed")[0]!;
    const closure = killed.payload["closure"] as Record<string, unknown>;
    expect(closure["status"]).toBe("failed"); // 单一终态语义
    expect(closure["summary"]).toBe("已由用户终止（kill）");

    // kill 收口同样注入主线（idle → 立即新 turn）
    await until(() => snapshot(rig).session.entries.some((e) => "role" in e && e.text.includes(`${agentId} closure: failed — 已由用户终止`)), 5000, "kill closure 注入主线");
    // kill 终态也有报告产物（O-5 对三收口路径一致）
    expect(existsSync(path.join(rig.home, "reports", rig.sessionId, `${agentId}.md`))).toBe(true);

    // 终态后再次 kill → killed=false；未知 id → killed=false（WS 侧据此回 connection.error）
    expect(rig.daemon.orchestration.kill(agentId)).toEqual({ killed: false, error: expect.stringContaining("已终态") });
    expect(rig.daemon.orchestration.kill("agent-999")).toEqual({ killed: false, error: expect.stringContaining("不存在") });
  }, 12000);
});

// ── F3.0（T4.1）：closure 通路修复——通知与正文分层（AD-17） ────────
//
// 三层断言面：①注入行 = 一行通知 + reportPath 指针行，报告全文不进主线；
// ②SubAgent 自报 reportPath 透传原值，daemon 零重渲染（AF-4 覆盖行为移除）；
// ③findings 非空 → kg 落账（走 KgWriteService 唯一写入口），空数组显式「无」
// 零落账零报错，落账故障不阻塞收口。

describe("⑥ F3.0 注入行带 reportPath 指针 + 自报路径透传不覆盖（CL-3.A1/A2）", () => {
  test("自报 reportPath：注入两行（通知+指针）且不含全文；reportPath 原值透传、原报告零改写", async () => {
    const rig = (current = await makeRig());
    const reportPath = path.join(rig.home, "sub-self-report.md");
    writeFileSync(reportPath, "# SubAgent 原始报告\n\nSENTINEL-FULLTEXT-9f3a\n", "utf8");

    const spawn6 = rig.daemon.orchestration.spawn("带自报报告的任务");
    if (spawn6.status !== "run") throw new Error("unreachable");
    const agentId = spawn6.agentId; // T10a：agent-<唯一串>
    rig.runner.forceClosure(agentId, {
      result: "done",
      closure: { ...DONE("自报报告任务完成"), reportPath, findings: [] },
    });

    await until(() => eventRows(rig, "agent.completed").length > 0, 5000, "agent.completed 落盘");
    const closure = eventRows(rig, "agent.completed")[0]!.payload["closure"] as Record<string, unknown>;
    expect(closure["reportPath"]).toBe(reportPath); // 透传原值（AF-4：不再被覆盖为 <home>/reports/...）

    // 注入行：一行通知 + 指针行；报告全文不进主线（dense payload 教训 F-4）
    await until(
      () => snapshot(rig).session.entries.some((e) => "role" in e && e.text.includes(`${agentId} closure: done — 自报报告任务完成`)),
      5000,
      "closure 注入主线",
    );
    const entry = snapshot(rig).session.entries.find(
      (e): e is (typeof e) & { role: "user" | "assistant"; text: string } => "role" in e && e.text.includes(`${agentId} closure: done`),
    )!;
    expect(entry.text).toBe(`${agentId} closure: done — 自报报告任务完成\n详情: ${reportPath} — 需要细节时 read`);
    expect(entry.text).not.toContain("SENTINEL-FULLTEXT-9f3a");

    // read reportPath 得 SubAgent 原报告（daemon 未重渲染）；无兜底重渲染产物
    expect(readFileSync(reportPath, "utf8")).toBe("# SubAgent 原始报告\n\nSENTINEL-FULLTEXT-9f3a\n");
    expect(existsSync(path.join(rig.home, "reports", rig.sessionId, `${agentId}.md`))).toBe(false);
  }, 12000);

  test("无自报 reportPath：兜底落盘保留（<home>/reports/<session>/<agentId>.md）且注入行带指针", async () => {
    const rig = (current = await makeRig());
    const spawn6b = rig.daemon.orchestration.spawn("无自报报告的任务");
    if (spawn6b.status !== "run") throw new Error("unreachable");
    const agentId = spawn6b.agentId;
    rig.runner.forceClosure(agentId, {
      result: "done",
      closure: { ...DONE("无自报完成"), reportPath: null, findings: [] },
    });

    await until(
      () => snapshot(rig).session.entries.some((e) => "role" in e && e.text.includes(`${agentId} closure: done — 无自报完成`)),
      5000,
      "closure 注入主线",
    );
    const fallbackPath = path.join(rig.home, "reports", rig.sessionId, `${agentId}.md`);
    const entry = snapshot(rig).session.entries.find(
      (e): e is (typeof e) & { role: "user" | "assistant"; text: string } => "role" in e && e.text.includes(`${agentId} closure: done`),
    )!;
    expect(entry.text).toBe(`${agentId} closure: done — 无自报完成\n详情: ${fallbackPath} — 需要细节时 read`); // 兜底路径也走指针行
    await until(() => existsSync(fallbackPath), 5000, "兜底报告落盘");
  }, 12000);
});

describe("⑦ F3.0 findings→kg 落账管道（CL-3.A3）", () => {
  /** 注入 findingsSink 的 rig（sink 具体形态由用例闭包携带）。 */
  async function makeSinkRig(sink: TestDaemonOptions["findingsSink"], home: string): Promise<Rig> {
    const engine = new FakeAgentEngine({});
    const runner = new ScriptedRunner();
    const daemon = await createTestDaemon({
      home,
      engine,
      skipConfig: true,
      port: 0,
      subagentRunner: runner,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
      findingsSink: sink,
    });
    return {
      home,
      sessionId: daemon.system.getStatus().sessionId,
      engine,
      runner,
      daemon,
      dispose: async () => {
        await daemon.shutdown();
        rmSync(home, { recursive: true, force: true });
      },
    };
  }

  test("非空 findings：sediment 新增/修改/废弃→proposeCandidate 候选 pending 行（W1-C 改道；source_task_id 机械注入）；非 sediment 跳过/缺 iterationId 回落库内锚", async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "helix-t41-proj-"));
    const database = new KgDatabase();
    const service = new KgWriteService({ store: new SqliteKnowledgeStore({ database }) });
    const writes: { projectRoot: string; op: KnowledgeWriteOp }[] = [];
    // 预建目标节点（「废弃」候选的 targetNode 引用对象）
    const pre = service.write(projectRoot, {
      kind: "createNode",
      iterationId: "iter-t41",
      draft: { kind: "rule", name: "旧规则", digest: "将被本次推翻的旧规则", scene: "测试场景" },
    });
    expect(pre.ok).toBe(true);
    const targetNode = pre.ok ? pre.nodeId : "TR-?";

    const home = mkdtempSync(path.join(tmpdir(), "helix-t41-sink-"));
    const rig = (current = await makeSinkRig(
      {
        write: (root, op) => {
          writes.push({ projectRoot: root, op });
          return service.write(root, op);
        },
        scanProjects: () => [projectRoot],
        // 迭代锚回落：缺 iterationId 的 finding 回落本库内锚（与 kg-update 工具同语义）
        latestIteration: () => "iter-t41",
      },
      home,
    ));
    try {
      const spawn7 = rig.daemon.orchestration.spawn("带 findings 的任务");
      if (spawn7.status !== "run") throw new Error("unreachable");
      const agentId = spawn7.agentId;
      rig.runner.forceClosure(agentId, {
        result: "done",
        closure: {
          status: "done",
          summary: "findings 落账任务完成",
          reportPath: null,
          taskId: "T4.1",
          findings: [
            { kind: "sediment", changeType: "新增", name: "报告透传规则", digest: "自报 reportPath 存在时透传时", reason: "任务沉淀的可复用规则", iterationId: "iter-t41" }, // project 缺省 → 唯一扫描项目自动
            { kind: "sediment", changeType: "废弃", targetNode, reason: "被本次实现推翻", iterationId: "iter-t41" },
            { kind: "issue", description: "非 sediment 语义不落账" },
            { kind: "sediment", changeType: "新增", name: "缺迭代 id 的条目", digest: "应回落库内锚" }, // 缺 iterationId → 回落 latestIteration
          ],
        },
      });

      await until(() => eventRows(rig, "agent.completed").length > 0, 5000, "agent.completed 落盘");
      // 三条命中写入口（issue 无 sediment 语义跳过 / 缺 iterationId 回落库内锚）——均为候选
      expect(writes.map((w) => w.op.kind)).toEqual(["proposeCandidate", "proposeCandidate", "proposeCandidate"]);
      expect(writes.every((w) => w.projectRoot === projectRoot)).toBe(true);

      // .helix-kg 出现对应候选 pending 行（source_task_id/source_iteration_id 机械落列）；
      // 目标节点不被现场推翻（裁决与落地归人审 decideCandidate）；change_log 含迭代 id
      await until(() => {
        const db = new Database(kgDbPath(projectRoot), { readonly: true });
        try {
          const rows = db.prepare("SELECT iteration_id FROM change_log WHERE iteration_id = ?").all("iter-t41") as unknown[];
          return rows.length >= 4; // 预建 1 + proposeCandidate 3
        } finally {
          db.close();
        }
      }, 5000, "change_log 落账");
      const db = new Database(kgDbPath(projectRoot), { readonly: true });
      try {
        const candidates = db
          .prepare("SELECT title, status, source_task_id, source_iteration_id, body, target_node FROM candidates ORDER BY id")
          .all() as { title: string; status: string; source_task_id: string | null; source_iteration_id: string | null; body: string; target_node: string | null }[];
        expect(candidates).toHaveLength(3);
        expect(candidates[0]).toMatchObject({
          title: "报告透传规则",
          status: "pending",
          source_task_id: "T4.1", // closure.taskId 机械注入（AD-10）
          source_iteration_id: "iter-t41",
        });
        expect(candidates[0]!.body).toContain("digest: 自报 reportPath 存在时透传时");
        expect(candidates[1]).toMatchObject({ title: `废弃：${targetNode}`, status: "pending" });
        expect(candidates[1]!.body).toContain("reason: 被本次实现推翻");
        expect(candidates[1]!.target_node).toBe(targetNode); // targetNode 结构化透传（读面定位列，不只埋在 body）
        expect(candidates[0]!.target_node).toBeNull(); // 新增候选无目标
        // 缺 iterationId 的条目：回落库内锚落账（source_iteration_id = iter-t41）
        expect(candidates[2]).toMatchObject({ title: "缺迭代 id 的条目", status: "pending", source_iteration_id: "iter-t41" });
        expect(candidates[2]!.body).toContain("digest: 应回落库内锚");
        // 改道后闭环现场不再直改节点：目标节点 status 不变（draft），人审裁决前零推翻
        const target = db.prepare("SELECT status FROM nodes WHERE id = ?").get(targetNode) as { status: string };
        expect(target.status).toBe("draft");
        const ops = db
          .prepare("SELECT op FROM change_log WHERE iteration_id = ? ORDER BY seq")
          .all("iter-t41") as { op: string }[];
        expect(ops.map((r) => r.op)).toEqual(["createNode", "proposeCandidate", "proposeCandidate", "proposeCandidate"]);
      } finally {
        db.close();
      }
    } finally {
      database.closeAll();
      rmSync(projectRoot, { recursive: true, force: true });
      await rig.dispose();
      current = undefined;
    }
  }, 15000);

  test("findings=[]（显式无）→ 零落账零报错，closure 主流程照常", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t41-empty-"));
    const writes: { projectRoot: string; op: KnowledgeWriteOp }[] = [];
    const rig = (current = await makeSinkRig(
      {
        write: (root, op) => {
          writes.push({ projectRoot: root, op });
          return { ok: true, nodeId: "TR-0" };
        },
        scanProjects: () => [],
      },
      home,
    ));
    const spawn7b = rig.daemon.orchestration.spawn("空 findings 任务");
    if (spawn7b.status !== "run") throw new Error("unreachable");
    rig.runner.forceClosure(spawn7b.agentId, {
      result: "done",
      closure: { status: "done", summary: "空 findings 完成", reportPath: null, findings: [], taskId: null },
    });
    await until(() => eventRows(rig, "agent.completed").length > 0, 5000, "agent.completed 落盘");
    expect(writes).toEqual([]); // 显式无：零落账
    await until(
      () => snapshot(rig).session.entries.some((e) => "role" in e && e.text.includes(`${spawn7b.agentId} closure: done — 空 findings 完成`)),
      5000,
      "注入照常",
    );
  }, 12000);

  // findings 双通道（task-778eb18a 截断三连败修复）：闭包 findings 空（块被
  // 截断/损坏的形态）+ 旁路文件在 → 机械读文件落账；闭包非空优先不双落
  test("截断兜底：closure findings=null + 旁路文件 findings.json 在 → 机械落账；闭包非空时不读文件（无双落）", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t41-bypass-"));
    const projectRoot = mkdtempSync(path.join(tmpdir(), "helix-t41-bypass-proj-"));
    const writes: { projectRoot: string; op: KnowledgeWriteOp }[] = [];
    const rig = (current = await makeSinkRig(
      {
        write: (root, op) => {
          writes.push({ projectRoot: root, op });
          return { ok: true, nodeId: "TR-0" };
        },
        scanProjects: () => [projectRoot],
      },
      home,
    ));
    try {
      // ① 截断形态：闭包 findings=null（块损坏解析不出）+ 旁路文件在
      const spawnA = rig.daemon.orchestration.spawn("截断兜底任务");
      if (spawnA.status !== "run") throw new Error("unreachable");
      const reportsDir = path.join(home, "reports", rig.sessionId);
      mkdirSync(reportsDir, { recursive: true });
      writeFileSync(
        path.join(reportsDir, `${spawnA.agentId}.findings.json`),
        JSON.stringify([{ kind: "sediment", changeType: "新增", name: "旁路恢复规则", reason: "闭包截断经文件恢复", iterationId: "iter-t41" }]),
      );
      rig.runner.forceClosure(spawnA.agentId, {
        result: "failed",
        closure: { status: "failed", summary: "未按 closure 协议收口（截断）", reportPath: null, findings: null, taskId: "T-bypass" },
      });
      await until(() => eventRows(rig, "agent.failed").length > 0, 5000, "agent.failed 落盘");
      expect(writes).toHaveLength(1); // 旁路文件恢复落账
      expect(writes[0]!.op).toMatchObject({ kind: "proposeCandidate", title: "旁路恢复规则", sourceTaskId: "T-bypass" });

      // ② 闭包非空优先：同一旁路文件仍在 → 只落闭包一份，不双落
      writes.length = 0;
      const spawnB = rig.daemon.orchestration.spawn("非空优先任务");
      if (spawnB.status !== "run") throw new Error("unreachable");
      writeFileSync(
        path.join(reportsDir, `${spawnB.agentId}.findings.json`),
        JSON.stringify([{ kind: "sediment", changeType: "新增", name: "文件里的发现", iterationId: "iter-t41" }]),
      );
      rig.runner.forceClosure(spawnB.agentId, {
        result: "done",
        closure: { status: "done", summary: "闭包携带 findings", reportPath: null, findings: [{ kind: "sediment", changeType: "新增", name: "闭包里的发现", iterationId: "iter-t41" }], taskId: null },
      });
      await until(() => eventRows(rig, "agent.completed").length > 0, 5000, "agent.completed 落盘");
      expect(writes).toHaveLength(1); // 恰一份（闭包优先，旁路不重复落）
      expect(writes[0]!.op).toMatchObject({ kind: "proposeCandidate", title: "闭包里的发现" });
    } finally {
      await rig.dispose();
      rmSync(projectRoot, { recursive: true, force: true });
      current = undefined;
    }
  }, 15000);

  test("落账故障不影响 closure 收口（写入口抛异常 → 事件/注入照常，不冒泡）", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t41-fail-"));
    const rig = (current = await makeSinkRig(
      {
        write: () => {
          throw new Error("kg 落账通道故障注入");
        },
        scanProjects: () => [],
      },
      home,
    ));
    const spawn7c = rig.daemon.orchestration.spawn("落账会失败的任务");
    if (spawn7c.status !== "run") throw new Error("unreachable");
    const agentId = spawn7c.agentId;
    rig.runner.forceClosure(agentId, {
      result: "done",
      closure: {
        status: "done",
        summary: "落账失败但收口照常",
        reportPath: null,
        taskId: null,
        findings: [{ kind: "sediment", changeType: "新增", name: "X", digest: "Y", iterationId: "iter-t41" }],
      },
    });
    // 主流程不受影响：agent.completed 落盘 + closure_records + 注入照常发生
    await until(() => eventRows(rig, "agent.completed").length > 0, 5000, "agent.completed 落盘");
    await until(
      () => snapshot(rig).session.entries.some((e) => "role" in e && e.text.includes(`${agentId} closure: done — 落账失败但收口照常`)),
      5000,
      "注入照常",
    );
  }, 12000);
});

describe("⑧ F3.0 e2e：真子进程闭环 → 注入行含指针（真 Bun.spawn）", () => {
  test("真子进程回传带自报 reportPath 的 closure → 主线注入两行含指针、原报告零改写", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t41-e2e-"));
    const engine = new FakeAgentEngine({});
    const reportPath = path.join(home, "real-child-report.md");
    writeFileSync(reportPath, "# 真子进程报告\n\nSENTINEL-REAL-CHILD\n", "utf8");
    const scriptPath = path.join(home, "script.json");
    writeFileSync(
      scriptPath,
      JSON.stringify({
        replies: [
          `任务完成。<<<CLOSURE\n${JSON.stringify({ status: "done", summary: "真子进程完成", reportPath, findings: [], taskId: null })}\nCLOSURE>>>`,
        ],
      }),
    );
    const fakeModel = {
      id: "model",
      name: "Fake Model",
      api: "anthropic-messages",
      provider: "fake",
      baseUrl: "http://localhost-unused",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8192,
    } as unknown as Model<any>;
    const runner = new SubagentLauncher({
      profile: SubAgentProfile,
      model: fakeModel,
      apiKeys: { fake: "k" },
      toolCwd: home,
      fakeEngineScript: scriptPath,
      reportDirFor: (sessionId) => path.join(home, "reports", sessionId),
    });
    const daemon = await createTestDaemon({
      home,
      engine,
      skipConfig: true,
      port: 0,
      subagentRunner: runner,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      const spawn8 = daemon.orchestration.spawn("真子进程任务");
      if (spawn8.status !== "run") throw new Error("unreachable");
      const agentId = spawn8.agentId;

      const session = () => daemon.session.getSnapshot().session;
      await until(
        () => session().entries.some((e) => "role" in e && e.text.includes(`${agentId} closure: done — 真子进程完成`)),
        20000,
        "真子进程 closure 注入主线",
      );
      const entry = session().entries.find(
        (e): e is (typeof e) & { role: "user" | "assistant"; text: string } => "role" in e && e.text.includes(`${agentId} closure: done`),
      )!;
      expect(entry.text).toBe(`${agentId} closure: done — 真子进程完成\n详情: ${reportPath} — 需要细节时 read`);
      expect(readFileSync(reportPath, "utf8")).toContain("SENTINEL-REAL-CHILD"); // daemon 未重渲染自报报告
    } finally {
      await runner.dispose();
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});
