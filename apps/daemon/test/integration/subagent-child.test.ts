import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { InstanceClosureOutcome } from "../../src/application/services/InstanceRunner";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { parseClosureBlock } from "../../src/adapters/driven/subagent/child/ChildMain";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../src/application/ports/outbound/ClockPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { AgentInstance } from "../../src/domain/agent/AgentInstance";
import type { ChildOutboundLine } from "../../src/adapters/driven/subagent/transport/wire";
import { createDaemon } from "../../src/infrastructure/container";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { PassThrough } from "node:stream";

/**
 * T2.2 子进程 integration（test-design §2.1 F1.4 + §6 K3）：真 Bun.spawn
 * SubAgent 子进程 + FakeEngineScript 剧本 env 注入（HELIX_FAKE_ENGINE_SCRIPT）。
 *
 * ① launch → 子进程独立 PID + 事件上行挂 instanceId（onInstanceEvent 回调）；
 * ② send → 子进程 Agent.steer() 转投 → 注入作为新 turn 被消费（steer-drain）；
 * ③ run 收敛 → closure 五字段回传 + exit(0) + model 完整对象透传深度相等（F-14）；
 * ④ kill O-6 优雅路径（SIGTERM → failed closure → exit 0 → 进程组回收 + ps 零残留）；
 * ⑤ kill O-6 升级路径（不可中断剧本 → grace 超时 SIGKILL 进程组 → 零孤儿）；
 * ⑥ 崩溃检测（子进程异常 exit 1 → Launcher 上报 failed）；
 * ⑦ 与 T2.1 SchedulerService 组装（InstanceRunner 真体替换替身）：事件 + 落盘。
 */

const SESSION_ID = "s-t22";
const FIXED_NOW = "2026-08-16T00:00:00.000Z";

/** 离线 fake 模型（同 test-profile/tools-loop 口径，无网络）。 */
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

/** closure 块生成（SubAgentProfile 收口协议约定的输出形态）。 */
const closureBlock = (summary: string, status: "done" | "failed" = "done") =>
  `<<<CLOSURE\n${JSON.stringify({ status, summary, reportPath: null, findings: [], taskId: null })}\nCLOSURE>>>`;

interface Harness {
  launcher: SubagentLauncher;
  home: string;
  closures: { instanceId: string; outcome: InstanceClosureOutcome }[];
  ticks: string[]; // onInstanceEvent 回调记号
  lines: { instanceId: string; line: ChildOutboundLine }[];
}

function makeHarness(script: object, opts: { graceMs?: number } = {}): Harness {
  const home = mkdtempSync(path.join(tmpdir(), "helix-t22-child-"));
  const scriptPath = path.join(home, "script.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const closures: Harness["closures"] = [];
  const ticks: string[] = [];
  const lines: Harness["lines"] = [];
  const launcher = new SubagentLauncher({
    profile: SubAgentProfile,
    model: fakeModel,
    apiKeys: { fake: "explicit-key" },
    toolCwd: home,
    graceMs: opts.graceMs,
    fakeEngineScript: scriptPath,
    onLine: (instanceId, line) => lines.push({ instanceId, line }),
  });
  launcher.setCallbacks({
    onInstanceEvent: (instanceId) => ticks.push(instanceId),
    onInstanceClosure: (instanceId, outcome) => closures.push({ instanceId, outcome }),
  });
  return { launcher, home, closures, ticks, lines };
}

function makeInstance(id = "agent-1"): AgentInstance {
  return AgentInstance.create({
    instanceId: id,
    kind: "subagent",
    profileKind: "subagent-worker",
    sessionId: SESSION_ID,
    createdAt: FIXED_NOW,
  });
}

function launch(h: Harness, task = "子进程集成任务", id = "agent-1"): number {
  const t0 = Date.now();
  h.launcher.launch(makeInstance(id), task);
  const launchMs = Date.now() - t0;
  expect(launchMs).toBeLessThan(500); // ① spawn 毫秒级返回（主线不被阻塞）
  return h.launcher.childPid(id)!;
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

/** 进程是否存在（ps 精确 pid；孤儿断言输入）。 */
function psHasPid(pid: number): boolean {
  try {
    return execSync(`ps -p ${pid} -o pid=`, { encoding: "utf8" }).trim() !== "";
  } catch {
    return false;
  }
}

/** 进程组是否已被回收（kill(-pid, 0) 抛 ESRCH = 回收完成）。 */
function groupRecycled(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch {
    return true;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let current: { launcher: SubagentLauncher; home: string } | undefined;
afterEach(async () => {
  if (current) {
    await current.launcher.dispose(); // 防孤儿：收尾 kill 全部存活子进程
    rmSync(current.home, { recursive: true, force: true });
    current = undefined;
  }
});

describe("closure 块解析（子进程收口协议）", () => {
  test("五字段结构解析 + 可选字段归一 null", () => {
    const parsed = parseClosureBlock(
      `前置说明文字。\n${closureBlock("任务完成", "done")}\n尾随文字`,
    );
    expect(parsed).toEqual({ status: "done", summary: "任务完成", reportPath: null, findings: [], taskId: null });
  });

  test("缺字段/非法 JSON/无块 → undefined（按协议违规收口 failed）", () => {
    expect(parseClosureBlock("没有任何收口块")).toBeUndefined();
    expect(parseClosureBlock("<<<CLOSURE\n{不是json}\nCLOSURE>>>")).toBeUndefined();
    expect(parseClosureBlock('<<<CLOSURE\n{"status":"bogus","summary":"x"}\nCLOSURE>>>')).toBeUndefined();
  });
});

describe("①②③ launch → 事件上行 → send→steer → closure 回传（真 Bun.spawn）", () => {
  test("四步闭环：事件挂 instanceId、注入驱动新 turn、closure 五字段 + exit(0) + model 深度相等透传", async () => {
    const h = (current = makeHarness({
      replies: [
        "第一答：" + "分".repeat(200), // ~200ms 流式窗口供注入
        `已按补充指示完成。${closureBlock("已按注入调整后完成", "done")}`,
      ],
      chunkDelayMs: 5,
    }));
    const pid = launch(h, "验证四步闭环");

    // ① 引擎事件经 stdout 上行（挂 instanceId）+ onInstanceEvent 回调刷新
    await until(() => h.lines.some((l) => l.line.type === "event" && l.line.event.type === "message_update"), 5000, "等待子进程流式事件");
    expect(h.lines.every((l) => l.instanceId === "agent-1")).toBe(true);
    expect(h.ticks.length).toBeGreaterThan(0);

    // ① F-14：子进程收到的 Model 对象与 config 解析对象深度相等（started 行回显）
    const started = h.lines.find((l) => l.line.type === "started");
    expect(started).toBeDefined();
    expect((started!.line as { model: unknown }).model).toEqual(fakeModel);
    expect(pid).toBeGreaterThan(0);
    expect(pid).not.toBe(process.pid); // 独立 PID

    // ② send → 子进程 Agent.steer() → 注入作为新 turn 消费（source=steer-drain）
    h.launcher.send("agent-1", "补充指示：请直接收口");
    await until(
      () => h.lines.some((l) => l.line.type === "event" && l.line.event.type === "message_start" && (l.line.event as { source?: string }).source === "steer-drain"),
      5000,
      "等待注入 drain 为新 turn",
    );

    // ③ closure 五字段回传 + exit(0)
    await until(() => h.closures.length > 0, 10000, "等待 closure 上报");
    const { outcome } = h.closures[0]!;
    expect(outcome.result).toBe("done");
    expect(outcome.closure).toEqual({
      status: "done",
      summary: "已按注入调整后完成",
      reportPath: null,
      findings: [],
      taskId: null,
    });
    const exitCode = await h.launcher.childExit("agent-1");
    expect(exitCode).toBe(0);
  }, 20000);
});

describe("④ O-6 优雅 kill（SIGTERM → failed closure → 进程组回收）", () => {
  test("kill 序列：SIGTERM 命中进程组，子进程 aborted 收口，零残留", async () => {
    const h = (current = makeHarness({
      replies: ["慢任务输出：" + "y".repeat(400)],
      chunkDelayMs: 20, // 400 字符 × 20ms ≈ 2s 流式窗口
    }));
    const pid = launch(h, "慢任务（验证 kill）");
    await until(() => h.lines.some((l) => l.line.type === "event" && l.line.event.type === "message_update"), 5000, "等待流式开始");

    const outcome = await h.launcher.kill("agent-1");
    expect(outcome).toBe("graceful");

    // 子进程优雅收口：closure failed(terminated) 上报
    await until(() => h.closures.length > 0, 5000, "等待终止 closure 上报");
    expect(h.closures[0]!.outcome.result).toBe("failed");
    expect(h.closures[0]!.outcome.closure.status).toBe("failed");
    expect(await h.launcher.childExit("agent-1")).toBe(0);

    // 进程组回收 + ps 零残留
    await sleep(150);
    expect(groupRecycled(pid)).toBe(true);
    expect(psHasPid(pid)).toBe(false);
  }, 15000);
});

describe("⑤ O-6 升级 kill（不可中断剧本 → SIGKILL 进程组 → 零孤儿）", () => {
  test("grace 超时后 SIGKILL 负 pgid 强杀进程组，无残留", async () => {
    const h = (current = makeHarness(
      { replies: ["不可中断：" + "z".repeat(2000)], chunkDelayMs: 5, ignoreAbort: true },
      { graceMs: 400 },
    ));
    const pid = launch(h, "卡死任务（验证 SIGKILL 升级）");
    await until(() => h.lines.some((l) => l.line.type === "event" && l.line.event.type === "message_update"), 5000, "等待流式开始");

    const t0 = Date.now();
    const outcome = await h.launcher.kill("agent-1");
    expect(outcome).toBe("escalated");
    expect(Date.now() - t0).toBeGreaterThan(300); // 确经 grace 等待而非立即强杀

    // 崩溃/强杀路径：无 closure → exit 非 0 → failed 上报
    await until(() => h.closures.length > 0, 5000, "等待强杀 failed 上报");
    expect(h.closures[0]!.outcome.result).toBe("failed");
    const exitCode = await h.launcher.childExit("agent-1");
    expect(exitCode === null || exitCode !== 0).toBe(true); // 信号死（null）或非 0

    await sleep(150);
    expect(groupRecycled(pid)).toBe(true);
    expect(psHasPid(pid)).toBe(false);
  }, 15000);
});

describe("⑥ 崩溃检测（exit 非 0 → failed 上报）", () => {
  test("剧本文件非法 → 子进程 exit(1) → Launcher 判 failed 收口上报", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t22-crash-"));
    const scriptPath = path.join(home, "script.json");
    writeFileSync(scriptPath, "{这不是合法JSON", "utf8");
    const closures: { instanceId: string; outcome: InstanceClosureOutcome }[] = [];
    const launcher = new SubagentLauncher({
      profile: SubAgentProfile,
      model: fakeModel,
      apiKeys: { fake: "k" },
      toolCwd: home,
      fakeEngineScript: scriptPath,
    });
    launcher.setCallbacks({
      onInstanceEvent: () => undefined,
      onInstanceClosure: (instanceId, outcome) => closures.push({ instanceId, outcome }),
    });
    current = { launcher, home };

    launcher.launch(makeInstance("agent-9"), "会崩溃的任务");
    await until(() => closures.length > 0, 8000, "等待崩溃 failed 上报");
    const { instanceId, outcome } = closures[0]!;
    expect(instanceId).toBe("agent-9");
    expect(outcome.result).toBe("failed");
    expect(outcome.closure.status).toBe("failed");
    expect(outcome.closure.summary).toMatch(/崩/); // Launcher 崩溃路径构造的 failed closure
    expect(await launcher.childExit("agent-9")).toBe(1); // exit 非 0 → 崩溃检测判据
  }, 15000);
});

describe("⑧ container 组合根装配（SubagentLauncher 真体接入点）", () => {
  test("生产路径（未注入 engine，T2.3 判定重定义）→ subagentLauncher 真体装配；注入 engine（Fake）→ 不装配（占位替身）", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t22-cont-"));
    const daemon = await createDaemon({
      home,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      expect(daemon.subagentLauncher).toBeInstanceOf(SubagentLauncher); // 真体接入 T2.1 调度
      // T2.3（AD-2）：模型位迁 SQLite 默认表——默认模型可读（builtin 兜底）
      expect(daemon.model.getDefault().model).toBe("anthropic/claude-sonnet-4-5");
    } finally {
      await daemon.shutdown();
      rmSync(home, { recursive: true, force: true });
    }

    const fakeHome = mkdtempSync(path.join(tmpdir(), "helix-t22-cont2-"));
    const fake = await createDaemon({
      home: fakeHome,
      engine: new FakeAgentEngine({ replies: [{ text: "ok" }] }),
      skipConfig: true,
      port: 0,
      cliInput: new PassThrough(),
      cliOutput: new PassThrough(),
    });
    try {
      expect(fake.subagentLauncher).toBeUndefined(); // engine 注入 = 测试 Fake 形态 → 占位替身（T2.3 判定）
    } finally {
      await fake.shutdown();
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 15000);
});

describe("⑦ 与 T2.1 SchedulerService 组装（InstanceRunner 真体）", () => {
  test("spawn → agent.spawned/started → 子进程收敛 → agent.completed + agent_lifecycle 落盘", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t22-sched-"));
    current = { launcher: null as unknown as SubagentLauncher, home };
    const scriptPath = path.join(home, "script.json");
    writeFileSync(scriptPath, JSON.stringify({ replies: [`调研完成。${closureBlock("调度组装任务完成", "done")}`], chunkDelayMs: 5 }));

    const writeQueue = new WriteQueue(path.join(home, "helix.db"));
    const repository = new SqliteSessionRepository(writeQueue);
    const events: DomainEvent[] = [];
    const publisher: EventPublisherPort = { publish: (e) => events.push(e), publishDelta: () => undefined };
    const clock: ClockPort = { now: () => FIXED_NOW, nowMs: () => Date.parse(FIXED_NOW) };
    const launcher = new SubagentLauncher({
      profile: SubAgentProfile,
      model: fakeModel,
      apiKeys: { fake: "k" },
      toolCwd: home,
      fakeEngineScript: scriptPath,
    });
    current.launcher = launcher;
    const scheduler = new SchedulerService({
      policy: new SchedulingPolicy(),
      runner: launcher,
      events: publisher,
      repository,
      clock,
        stalledPollMs: 100,
    });

    const outcome = scheduler.spawn(SESSION_ID, "调度组装任务");
    expect(outcome.status).toBe("run");

    await until(() => events.some((e) => e.type === "agent.completed"), 15000, "等待 agent.completed");
    const completed = events.find((e) => e.type === "agent.completed")!;
    expect(completed.instanceId).toBe("agent-1");
    expect((completed.payload as { closure: { summary: string } }).closure.summary).toBe("调度组装任务完成");

    // agent_lifecycle 投影落盘（done 终态）
    await writeQueue.flush();
    const rows = writeQueue.database
      .prepare("SELECT instance_id AS instanceId, state FROM agent_lifecycle WHERE session_id = ?")
      .all(SESSION_ID) as { instanceId: string; state: string }[];
    expect(rows).toContainEqual({ instanceId: "agent-1", state: "done" });

    scheduler.stop();
    await writeQueue.close();
  }, 25000);
});
