import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { PassThrough } from "node:stream";
import { createDaemon } from "../../src/infrastructure/container";
import type { Daemon } from "../../src/infrastructure/container";
import type { InstanceRunner, InstanceRunnerCallbacks, InstanceClosureOutcome } from "../../src/application/services/InstanceRunner";
import type { AgentEngineEvent } from "../../src/application/ports/outbound/AgentEnginePort";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";

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
  const daemon = await createDaemon({
    home,
    engine,
    skipConfig: true,
    port: 0,
    subagentRunner: runner,
    cliInput: new PassThrough(),
    cliOutput: new PassThrough(),
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
    expect(outcome).toEqual({ status: "run", agentId: "agent-1" });
    expect(rig.runner.launched).toEqual([{ instanceId: "agent-1", task: "调研调度器现状" }]);

    rig.runner.forceClosure("agent-1", { result: "done", closure: DONE("调研完成，结论 X") });

    // idle 注入 = 立即新 turn（sendMessage 路径）→ run 结束回 idle
    await until(() => rig.daemon.system.getStatus().agentState === "idle", 5000, "closure 注入新 turn 完成");
    const entries = snapshot(rig).session.entries;
    const closureEntry = entries.find((e): e is (typeof entries)[number] & { role: "user" | "assistant"; text: string } => "role" in e && e.text.includes("agent-1 closure: done — 调研完成，结论 X"));
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
    rig.daemon.orchestration.spawn("生成报告的任务");
    rig.runner.forceClosure("agent-1", { result: "done", closure: DONE("报告任务完成") });

    await until(() => eventRows(rig, "agent.completed").length > 0, 5000, "agent.completed 落盘");
    const completed = eventRows(rig, "agent.completed")[0]!;
    expect(completed.instance_id).toBe("agent-1");
    const closure = completed.payload["closure"] as Record<string, unknown>;
    expect(closure).toEqual({
      status: "done",
      summary: "报告任务完成",
      reportPath: path.join(rig.home, "reports", rig.sessionId, "agent-1.md"), // O-5：<home>/reports/<session>/<agentId>.md
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
      .prepare("SELECT result, status, summary, report_path, findings, task_id FROM closure_records WHERE agent_id = 'agent-1'")
      .get() as { result: string; status: string; summary: string; report_path: string; findings: string; task_id: string };
    db.close();
    expect(record).toMatchObject({ result: "done", status: "done", summary: "报告任务完成", task_id: "T2.3" });
    expect(JSON.parse(record.findings)).toEqual([{ kind: "sediment", changeType: "新增" }]);

    // O-5 文件产物：报告 markdown 存在且含摘要/findings（重启后仍可读——文件在磁盘）
    const reportPath = path.join(rig.home, "reports", rig.sessionId, "agent-1.md");
    expect(existsSync(reportPath)).toBe(true);
    const content = readFileSync(reportPath, "utf8");
    expect(content).toContain("agent-1");
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
    const daemon = await createDaemon({
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
    rig.daemon.orchestration.spawn("并行调研任务"); // SubAgent 出卡（与主线 run 并行）

    // ① 用户 steer 先入队
    await daemon.chat.steer("用户补充：注意边界情况");
    // ② closure 注入后入队（同一 domain SteerQueue）
    rig.runner.forceClosure("agent-1", { result: "done", closure: { ...DONE("调研完成"), findings: null } });

    // 注入即时可见：pendingSteer 按入队序 = [用户补充, closure]（source 可区分）
    const pending = daemon.session.getSnapshot().session.pendingSteer;
    expect(pending.map((i) => i.text)).toEqual([
      "用户补充：注意边界情况",
      "agent-1 closure: done — 调研完成",
    ]);
    expect(pending[0]?.source).toBeUndefined(); // 用户 steer 保持旧形状
    expect(pending[1]?.source).toBe("closure"); // closure 注入来源可区分（AD-8）

    // drain 按序消费（one-at-a-time，每条独占一 turn）→ run 结束
    await until(() => daemon.system.getStatus().agentState === "idle", 10000, "主线 run 结束");
    const drainedUserTexts = engine.events
      .filter((e) => e.type === "message_end" && e.role === "user")
      .map((e) => (e as { text: string }).text);
    expect(drainedUserTexts).toEqual([
      "开始调研",
      "用户补充：注意边界情况", // FIFO：用户 steer 在前
      "agent-1 closure: done — 调研完成", // closure 在后，均被消费（不丢失）
    ]);
    // 两注入各开新 turn（每条 steer 独占一 turn，§5.3-4）
    expect(daemon.session.getSnapshot().session.turns.length).toBe(3);
  }, 20000);
});

describe("④ SubAgent 实例事件进 per-instance 面（AD-8 → AD-3 演进，T2.1）", () => {
  test("工具事件挂 instanceId 落盘广播 + 会话投影落记录；主线 turn 与 MainAgent 上下文零混入", async () => {
    const rig = (current = await makeRig());
    rig.daemon.orchestration.spawn("用工具调研");
    expect(rig.runner.launched.length).toBe(1);

    // SubAgent 内部工具调用（引擎事件上行 → per-instance 领域事件）
    rig.runner.emitEngineEvent("agent-1", {
      type: "tool_execution_start",
      toolCallId: "sub-tc-1",
      toolName: "grep",
      args: { pattern: "closure" },
    });
    rig.runner.emitEngineEvent("agent-1", {
      type: "tool_execution_end",
      toolCallId: "sub-tc-1",
      toolName: "grep",
      isError: false,
      result: "closure-chain.test.ts:1",
    });

    await until(() => eventRows(rig, "tool.call.result").length > 0, 5000, "SubAgent 工具事件落盘");
    const started = eventRows(rig, "tool.call.started")[0]!;
    const result = eventRows(rig, "tool.call.result")[0]!;
    expect(started.instance_id).toBe("agent-1"); // 挂 instanceId 落盘（四维可查）
    expect(result.instance_id).toBe("agent-1");
    expect(started.payload).toMatchObject({ toolCallId: "sub-tc-1", toolName: "grep" });
    expect(result.payload).toMatchObject({ toolCallId: "sub-tc-1", args: { pattern: "closure" }, result: "closure-chain.test.ts:1", isError: false });

    // T2.1（AD-3）：会话投影消费工具事件 → SubAgent 工具记录进快照取数面
    //（instanceId 行级归属 agent-1；主线工具记录仍在 ChatService——此处主线
    // 无工具，故快照 toolCalls 恰为该 SubAgent 记录）
    const toolCalls = snapshot(rig).toolCalls;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.id).toBe("sub-tc-1");
    expect(toolCalls[0]!.instanceId).toBe("agent-1");
    expect(toolCalls[0]!.status).toBe("completed");

    // MainAgent 上下文零混入：SubAgent 消息 Entry 不挂主线 turn；主线未开任何
    // turn（closure 未发生）——工具记录经 per-instance 面（instances[].channels/
    // 实例抽屉），不进主线消息流
    expect(snapshot(rig).session.turns).toEqual([]);
    expect(snapshot(rig).session.entries.filter((e) => e.instanceId === "agent-1")).toEqual([]);
  }, 12000);
});

describe("⑤ kill 全链（FB-3：runner.kill 先行 + closure failed 注入主线）", () => {
  test("port.kill → runner.kill 收到 → agent.killed(closure failed) → 注入主线新 turn", async () => {
    const rig = (current = await makeRig());
    rig.daemon.orchestration.spawn("会被终止的任务");

    const outcome = rig.daemon.orchestration.kill("agent-1");
    expect(outcome).toEqual({ killed: true });
    expect(rig.runner.kills).toEqual(["agent-1"]); // FB-3：终止信号已发 runner（子进程不再空跑）

    await until(() => eventRows(rig, "agent.killed").length > 0, 5000, "agent.killed 落盘");
    const killed = eventRows(rig, "agent.killed")[0]!;
    const closure = killed.payload["closure"] as Record<string, unknown>;
    expect(closure["status"]).toBe("failed"); // 单一终态语义
    expect(closure["summary"]).toBe("已由用户终止（kill）");

    // kill 收口同样注入主线（idle → 立即新 turn）
    await until(() => snapshot(rig).session.entries.some((e) => "role" in e && e.text.includes("agent-1 closure: failed — 已由用户终止")), 5000, "kill closure 注入主线");
    // kill 终态也有报告产物（O-5 对三收口路径一致）
    expect(existsSync(path.join(rig.home, "reports", rig.sessionId, "agent-1.md"))).toBe(true);

    // 终态后再次 kill → killed=false；未知 id → killed=false（WS 侧据此回 connection.error）
    expect(rig.daemon.orchestration.kill("agent-1")).toEqual({ killed: false, error: expect.stringContaining("已终态") });
    expect(rig.daemon.orchestration.kill("agent-999")).toEqual({ killed: false, error: expect.stringContaining("不存在") });
  }, 12000);
});
