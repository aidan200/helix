import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { InstanceClosureOutcome } from "../../src/application/services/InstanceRunner";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { parseClosureBlock } from "../../src/adapters/driven/subagent/child/ChildMain";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../src/application/ports/outbound/ClockPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { AgentInstance } from "../../src/domain/agent/AgentInstance";
import type { ChildOutboundLine } from "../../src/adapters/driven/subagent/transport/wire";
import { createTestDaemon } from "../helpers/createTestDaemon";
import { FakeAgentEngine } from "../mocks/FakeAgentEngine";
import { FakeBrowserPort } from "../mocks/FakeBrowserPort";
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

function makeHarness(
  script: object,
  opts: { graceMs?: number; browser?: FakeBrowserPort; profile?: AgentProfile; model?: Model<any>; ledgerDbPath?: string } = {},
): Harness {
  const home = mkdtempSync(path.join(tmpdir(), "helix-t22-child-"));
  const scriptPath = path.join(home, "script.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const closures: Harness["closures"] = [];
  const ticks: string[] = [];
  const lines: Harness["lines"] = [];
  const launcher = new SubagentLauncher({
    profile: opts.profile ?? SubAgentProfile,
    model: opts.model ?? fakeModel,
    apiKeys: { fake: "explicit-key" },
    toolCwd: home,
    graceMs: opts.graceMs,
    fakeEngineScript: scriptPath,
    ...(opts.ledgerDbPath !== undefined ? { ledgerDbPath: opts.ledgerDbPath } : {}),
    ...(opts.browser !== undefined ? { browser: opts.browser } : {}),
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

describe("C：closure 块缺 taskId → 回落 jobId（taskContext 机械注入）", () => {
  test("batch 行命中 → closure.taskId 回落 jobId（LLM 未写 taskId）", async () => {
    const dbDir = mkdtempSync(path.join(tmpdir(), "helix-t22-taskctx-"));
    const dbPath = path.join(dbDir, "helix.db");
    // 建库 + 预建 batch 行（instance_id = agent-1 → job_id = job-1）
    const wq = new WriteQueue(dbPath);
    wq.database
      .prepare(
        "INSERT INTO batch (id, job_id, stage_seq, seq, scope, status, retry_count, retry_note, instance_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("batch-1", "job-1", 0, 0, "测试批次", "running", 0, null, "agent-1", FIXED_NOW, FIXED_NOW);
    await wq.close();

    try {
      const h = (current = makeHarness(
        { replies: [`完成。${closureBlock("任务完成", "done")}`] },
        { ledgerDbPath: dbPath },
      ));
      launch(h, "验证 taskId 回落");
      await until(() => h.closures.length > 0, 10000, "等待 closure 上报");
      expect(h.closures[0]!.outcome.closure).toMatchObject({
        status: "done",
        summary: "任务完成",
        taskId: "job-1", // closure 块 taskId=null → 回落 taskContext.jobId
      });
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  }, 20000);
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

describe("⑧ H-3 browser 转发通道（tool-req → daemon CDP 单例归属代理）", () => {
  const OPEN_SCRIPT = (summary: string) => ({
    toolCall: { name: "browser", args: { action: "open", url: "https://h3.example" } },
    replies: [`已完成。${closureBlock(summary, "done")}`],
    chunkDelayMs: 5,
  });

  test("子进程 browser open → FakeBrowserPort 落桩且 ownerId=instanceId；tool_execution_end isError=false", async () => {
    const browser = new FakeBrowserPort();
    const h = (current = makeHarness(OPEN_SCRIPT("browser 转发完成"), { browser }));
    launch(h, "验证 browser 转发通道");

    await until(() => h.closures.length > 0, 10000, "等待 closure 上报");
    // daemon 侧归属代理：openTab ownerId 强制 = 通道 instanceId（子进程不可伪造）
    expect(browser.lastCall("openTab")?.args).toEqual(["https://h3.example", "agent-1"]);
    // 子进程工具执行成功（tool-res ok:true 回执到达）
    const toolEnd = h.lines.find(
      (l) => l.line.type === "event" && l.line.event.type === "tool_execution_end",
    );
    expect(toolEnd).toBeDefined();
    if (toolEnd?.line.type === "event" && toolEnd.line.event.type === "tool_execution_end") {
      expect(toolEnd.line.event.toolName).toBe("browser");
      expect(toolEnd.line.event.isError).toBe(false);
    }
    expect(h.closures[0]!.outcome.result).toBe("done");
  }, 20000);

  test("无 browser 注入（测试 Fake 引擎形态）→ tool-res ok:false「未装配」→ 工具 isError", async () => {
    const h = (current = makeHarness(OPEN_SCRIPT("browser 未装配收口"))); // 不注入 browser
    launch(h, "验证未装配回执");

    await until(() => h.closures.length > 0, 10000, "等待 closure 上报");
    const toolEnd = h.lines.find(
      (l) => l.line.type === "event" && l.line.event.type === "tool_execution_end",
    );
    expect(toolEnd).toBeDefined();
    if (toolEnd?.line.type === "event" && toolEnd.line.event.type === "tool_execution_end") {
      expect(toolEnd.line.event.isError).toBe(true);
      expect(toolEnd.line.event.result).toContain("未装配");
    }
    expect(h.closures[0]!.outcome.result).toBe("done"); // 工具错误不收琉——剧本续轮正常收口
  }, 20000);
});

describe("⑧ container 组合根装配（SubagentLauncher 真体接入点）", () => {
  test("生产路径（未注入 engine，T2.3 判定重定义）→ subagentLauncher 真体装配；注入 engine（Fake）→ 不装配（占位替身）", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t22-cont-"));
    const daemon = await createTestDaemon({
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
    const fake = await createTestDaemon({
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
    if (outcome.status !== "run") throw new Error("unreachable");
    const agentId = outcome.agentId; // T10a：spawn id = agent-<唯一串>，捕获而非硬编码

    await until(() => events.some((e) => e.type === "agent.completed"), 15000, "等待 agent.completed");
    const completed = events.find((e) => e.type === "agent.completed")!;
    expect(completed.instanceId).toBe(agentId);
    expect((completed.payload as { closure: { summary: string } }).closure.summary).toBe("调度组装任务完成");

    // agent_lifecycle 投影落盘（done 终态）
    await writeQueue.flush();
    const rows = writeQueue.database
      .prepare("SELECT instance_id AS instanceId, state FROM agent_lifecycle WHERE session_id = ?")
      .all(SESSION_ID) as { instanceId: string; state: string }[];
    expect(rows).toContainEqual({ instanceId: agentId, state: "done" });

    scheduler.stop();
    await writeQueue.close();
  }, 25000);
});

// ── thinking 定格值子进程消费（T1.3，thinking 批：AD-1 落点二 + §3.5 装配点 2） ──
//
// 真 Bun.spawn 子进程 + fake 剧本 captureReasoningPath 捕获面：
// 父进程 launch 段 resolveThinkingFor 定格 → HELIX_THINKING_LEVEL env 透传 →
// ChildMain 消费定格值装配 §3.5 注入器（包装在 streamFnOverride 外侧——fake
// 剧本通道不被破坏，剧本捕获 options.reasoning）→ 能力过滤（§3.3：定格值
// 不被模型支持 → undefined → 不动 options）。

/** reasoning 能力位模型夹具（pi-ai 0.84.2 类型契约）。 */
const reasoningModel = (map: Record<string, string | null> | undefined): Model<any> =>
  ({
    ...(fakeModel as unknown as Record<string, unknown>),
    id: "reasoning-model",
    reasoning: true,
    ...(map !== undefined ? { thinkingLevelMap: map } : {}),
  }) as unknown as Model<any>;

const FULL_MAP: Record<string, string> = { minimal: "a", low: "l", medium: "m", high: "h", xhigh: "x", max: "z" };

/** 驱动一个子进程到 closure，读捕获文件的 reasoning 行集。 */
async function runThinkingChild(opts: {
  profile: AgentProfile;
  model: Model<any>;
}): Promise<{ captured: (string | null)[]; summary: string }> {
  const home = mkdtempSync(path.join(tmpdir(), "helix-t13-child-thinking-"));
  const capturePath = path.join(home, "reasoning.log");
  const h = makeHarness(
    { replies: [closureBlock("thinking 任务完成")], captureReasoningPath: capturePath },
    { profile: opts.profile, model: opts.model },
  );
  current = { launcher: h.launcher, home };
  try {
    launch(h, "thinking 定格任务");
    await until(() => h.closures.length > 0, 15000, "等待 closure");
    const captured = readFileSync(capturePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string | null);
    return { captured, summary: h.closures[0]!.outcome.closure.summary };
  } finally {
    await h.launcher.dispose();
    current = undefined;
    rmSync(home, { recursive: true, force: true });
    rmSync(h.home, { recursive: true, force: true }); // 泄漏修复：makeHarness 内层 t22-child 目录同清
  }
}

describe("thinking 定格值子进程消费（T1.3；env 定格透传 + 注入器能力过滤）", () => {
  test("① profile 配置 thinkingLevel=xhigh + 模型支持 → options.reasoning=xhigh（验收标准①主路径）", async () => {
    const r = await runThinkingChild({
      profile: { ...SubAgentProfile, thinkingLevel: "xhigh" },
      model: reasoningModel(FULL_MAP),
    });
    expect(r.summary).toBe("thinking 任务完成"); // fake 剧本通道不受注入器包装破坏
    expect(r.captured).toEqual(["xhigh"]);
  }, 20000);

  test("② profile 留空 → 无兜底（默认关）：env 缺席 → 不装注入器 → options.reasoning 未传", async () => {
    const r = await runThinkingChild({
      profile: SubAgentProfile,
      model: reasoningModel(FULL_MAP),
    });
    expect(r.captured).toEqual([null]);
  }, 20000);

  test("③ 定格值不被模型支持（显式 null 键）→ 注入器不动 options（捕获 null = 未传参，provider 默认）", async () => {
    const r = await runThinkingChild({
      profile: { ...SubAgentProfile, thinkingLevel: "xhigh" },
      model: reasoningModel({ minimal: "a", low: "l", medium: "m", high: "h", xhigh: null, max: null }),
    });
    expect(r.captured).toEqual([null]);
  }, 20000);

  test("④ 模型 reasoning=false → 任何定格值均不动 options", async () => {
    const r = await runThinkingChild({
      profile: { ...SubAgentProfile, thinkingLevel: "medium" },
      model: fakeModel, // reasoning: false
    });
    expect(r.captured).toEqual([null]);
  }, 20000);
});

// ── F3.0（T4.1）：reportPath env 传参 + 失败收口 summary 补齐 ──────

describe("⑧ F3.0 reportPath 经 env IPC 面传参 + 失败 summary 补齐", () => {
  /** Bun.spawn 桩：捕获 env；stdout 可注入预设行（closure 线协议驱动）。 exited 恒挂起——收口由 stdout closure 行驱动（消除 exit 竞态）。 */
  interface SpawnCall {
    readonly cmd: readonly string[];
    readonly env: Record<string, string | undefined>;
  }

  function patchSpawn(capture: SpawnCall[], stdoutLines: string[] = []): void {
    const fakeProc = () =>
      ({
        pid: 42000 + Math.floor(Math.random() * 900),
        exited: new Promise(() => {}), // 恒挂起：exit 监视不抢跑（closure 行主导收口）
        stdout: (async function* () {
          for (const line of stdoutLines) yield new TextEncoder().encode(line);
        })(),
        stdin: { write: () => true },
      }) as unknown as ReturnType<typeof Bun.spawn>;
    (Bun as unknown as { spawn: unknown }).spawn = (opts: {
      cmd: readonly string[];
      env: Record<string, string | undefined>;
    }) => {
      capture.push({ cmd: [...opts.cmd], env: { ...opts.env } });
      return fakeProc();
    };
  }

  function restoreSpawn(real: typeof Bun.spawn): void {
    (Bun as unknown as { spawn: unknown }).spawn = real;
  }

  test("① reportDirFor 注入 → spawn env 带 HELIX_REPORT_PATH（<dir>/<session>/<id>.md）；未注入 → 键缺席", async () => {
    const real = Bun.spawn;
    const calls: SpawnCall[] = [];
    patchSpawn(calls);
    try {
      const home = mkdtempSync(path.join(tmpdir(), "helix-t41-env-"));
      try {
        const withDir = new SubagentLauncher({
          profile: SubAgentProfile,
          model: fakeModel,
          apiKeys: { fake: "k" },
          toolCwd: home,
          reportDirFor: (sessionId) => path.join(home, "reports", sessionId),
        });
        withDir.launch(makeInstance("agent-r1"), "任务");
        expect(calls[0]!.env["HELIX_REPORT_PATH"]).toBe(
          path.join(home, "reports", SESSION_ID, "agent-r1.md"),
        ); // 报告落点经 env IPC 面传参（TR-AD-6 第二豁免族；AG-08 键级登记）

        const noDir = new SubagentLauncher({
          profile: SubAgentProfile,
          model: fakeModel,
          apiKeys: { fake: "k" },
          toolCwd: home,
        });
        noDir.launch(makeInstance("agent-r2"), "任务");
        expect(calls[1]!.env["HELIX_REPORT_PATH"]).toBeUndefined(); // 未注入不传键（既有测试形态不变）
        // 不 dispose：fake pid 不对应真实进程（kill 负 pgid 有误伤风险，挂起桩随测试进程回收）
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      restoreSpawn(real);
    }
  });

  test("② 失败 closure 空 summary → 补非空默认叙述（含失败关键词）；非空 summary 原样透传", async () => {
    const real = Bun.spawn;
    const closures: { instanceId: string; outcome: InstanceClosureOutcome }[] = [];
    const closureLine = (summary: string) =>
      JSON.stringify({
        type: "closure",
        instanceId: "agent-f1",
        closure: { status: "failed", summary, reportPath: null, findings: null, taskId: null },
      } satisfies ChildOutboundLine) + "\n";
    patchSpawn([], [closureLine(""), closureLine("子进程自报失败叙述")]);
    try {
      const home = mkdtempSync(path.join(tmpdir(), "helix-t41-sum-"));
      try {
        const launcher = new SubagentLauncher({
          profile: SubAgentProfile,
          model: fakeModel,
          apiKeys: { fake: "k" },
          toolCwd: home,
        });
        launcher.setCallbacks({
          onInstanceEvent: () => undefined,
          onInstanceClosure: (instanceId, outcome) => closures.push({ instanceId, outcome }),
        });
        launcher.launch(makeInstance("agent-f1"), "任务");
        // 两条 closure 行同 stdout 流到达：首条生效（空 summary 被补齐），
        // 同 id 第二条幂等吞；非空透传见③（不同实例）
        await until(() => closures.length > 0, 3000, "closure 行到达");
        expect(closures).toHaveLength(1);
        expect(closures[0]!.outcome.closure.status).toBe("failed");
        expect(closures[0]!.outcome.closure.summary.trim().length).toBeGreaterThan(0); // 非空补齐
        expect(closures[0]!.outcome.closure.summary).toContain("失败"); // 含失败关键词
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      restoreSpawn(real);
    }
  });

  test("③ 失败 closure 自带非空 summary → 原样透传（补齐不越位改写）", async () => {
    const real = Bun.spawn;
    const closures: { instanceId: string; outcome: InstanceClosureOutcome }[] = [];
    patchSpawn(
      [],
      [
        JSON.stringify({
          type: "closure",
          instanceId: "agent-f2",
          closure: { status: "failed", summary: "子进程自报失败叙述", reportPath: null, findings: null, taskId: null },
        } satisfies ChildOutboundLine) + "\n",
      ],
    );
    try {
      const home = mkdtempSync(path.join(tmpdir(), "helix-t41-sum2-"));
      try {
        const launcher = new SubagentLauncher({
          profile: SubAgentProfile,
          model: fakeModel,
          apiKeys: { fake: "k" },
          toolCwd: home,
        });
        launcher.setCallbacks({
          onInstanceEvent: () => undefined,
          onInstanceClosure: (instanceId, outcome) => closures.push({ instanceId, outcome }),
        });
        launcher.launch(makeInstance("agent-f2"), "任务");
        await until(() => closures.length > 0, 3000, "closure 行到达");
        expect(closures[0]!.outcome.closure.summary).toBe("子进程自报失败叙述");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      restoreSpawn(real);
    }
  });
});

// ── O-10：validateBrief / validateReport 接线（violation 只记日志不拒绝） ──

describe("⑨ O-10 validateBrief/validateReport 接线（violation 记日志不拒绝，TR-AD-58 消费方补接）", () => {
  /** Bun.spawn 桩（F3.0 同式）：捕获 spawn 调用；stdout 注入预设 closure 行，exited 恒挂起。 */
  interface SpawnCall {
    readonly cmd: readonly string[];
    readonly env: Record<string, string | undefined>;
  }

  function patchSpawn(capture: SpawnCall[], stdoutLines: string[] = []): void {
    const fakeProc = () =>
      ({
        pid: 42000 + Math.floor(Math.random() * 900),
        exited: new Promise(() => {}),
        stdout: (async function* () {
          for (const line of stdoutLines) yield new TextEncoder().encode(line);
        })(),
        stdin: { write: () => true },
      }) as unknown as ReturnType<typeof Bun.spawn>;
    (Bun as unknown as { spawn: unknown }).spawn = (opts: {
      cmd: readonly string[];
      env: Record<string, string | undefined>;
    }) => {
      capture.push({ cmd: [...opts.cmd], env: { ...opts.env } });
      return fakeProc();
    };
  }

  function restoreSpawn(real: typeof Bun.spawn): void {
    (Bun as unknown as { spawn: unknown }).spawn = real;
  }

  /** 三要素齐备的合法 brief（validateBrief 零违例形态）。 */
  const LEGAL_BRIEF = ["## 任务目标", "做一件小事。", "", "## 范围钳制", "只改一个文件。", "", "## 完成判定", "测试通过。"].join("\n");

  function makeWiredLauncher(home: string, warns: string[]): SubagentLauncher {
    return new SubagentLauncher({
      profile: SubAgentProfile,
      model: fakeModel,
      apiKeys: { fake: "k" },
      toolCwd: home,
      logger: { warn: (m) => warns.push(m) },
    });
  }

  test("① 派发缺三要素 brief → logger.warn 逐条记 violation（rule 精确指认），launch 不拒绝（spawn 照常）", async () => {
    const real = Bun.spawn;
    const calls: SpawnCall[] = [];
    patchSpawn(calls);
    try {
      const home = mkdtempSync(path.join(tmpdir(), "helix-o10-brief-"));
      try {
        const warns: string[] = [];
        const launcher = makeWiredLauncher(home, warns);
        launcher.launch(makeInstance("agent-v1"), "随便做点事"); // 无任何段 → 三要素全缺
        expect(calls).toHaveLength(1); // 不拒绝：spawn 照常发生
        expect(warns).toHaveLength(3);
        expect(warns.join("\n")).toContain("brief.missing-task-goal");
        expect(warns.join("\n")).toContain("brief.missing-scope-clamp");
        expect(warns.join("\n")).toContain("brief.missing-completion-criteria");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      restoreSpawn(real);
    }
  });

  test("② 派发合法 brief（三要素齐备）→ 零 warn", async () => {
    const real = Bun.spawn;
    const calls: SpawnCall[] = [];
    patchSpawn(calls);
    try {
      const home = mkdtempSync(path.join(tmpdir(), "helix-o10-brief-ok-"));
      try {
        const warns: string[] = [];
        const launcher = makeWiredLauncher(home, warns);
        launcher.launch(makeInstance("agent-v2"), LEGAL_BRIEF);
        expect(calls).toHaveLength(1);
        expect(warns).toEqual([]);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      restoreSpawn(real);
    }
  });

  test("③ 回收 report 缺 findings 段 → warn 记 report.missing-findings，closure 照常上报（不拒绝）", async () => {
    const real = Bun.spawn;
    const home = mkdtempSync(path.join(tmpdir(), "helix-o10-report-"));
    const reportPath = path.join(home, "agent-v3.md");
    writeFileSync(reportPath, "## 结论\n做完了。\n", "utf8"); // 缺 findings 段
    const closures: { instanceId: string; outcome: InstanceClosureOutcome }[] = [];
    patchSpawn(
      [],
      [
        JSON.stringify({
          type: "closure",
          instanceId: "agent-v3",
          closure: { status: "done", summary: "完成", reportPath, findings: null, taskId: null },
        } satisfies ChildOutboundLine) + "\n",
      ],
    );
    try {
      const warns: string[] = [];
      const launcher = makeWiredLauncher(home, warns);
      launcher.setCallbacks({
        onInstanceEvent: () => undefined,
        onInstanceClosure: (instanceId, outcome) => closures.push({ instanceId, outcome }),
      });
      launcher.launch(makeInstance("agent-v3"), LEGAL_BRIEF);
      await until(() => closures.length > 0, 3000, "closure 行到达");
      expect(closures[0]!.outcome.result).toBe("done"); // 不拒绝：closure 照常上报
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("report.missing-findings");
    } finally {
      restoreSpawn(real);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("④ 回收合法 report（summary + findings 显式「无」）→ 零 warn", async () => {
    const real = Bun.spawn;
    const home = mkdtempSync(path.join(tmpdir(), "helix-o10-report-ok-"));
    const reportPath = path.join(home, "agent-v4.md");
    writeFileSync(reportPath, "## 结论\n做完了。\n\n## 发现\n无\n", "utf8");
    const closures: { instanceId: string; outcome: InstanceClosureOutcome }[] = [];
    patchSpawn(
      [],
      [
        JSON.stringify({
          type: "closure",
          instanceId: "agent-v4",
          closure: { status: "done", summary: "完成", reportPath, findings: [], taskId: null },
        } satisfies ChildOutboundLine) + "\n",
      ],
    );
    try {
      const warns: string[] = [];
      const launcher = makeWiredLauncher(home, warns);
      launcher.setCallbacks({
        onInstanceEvent: () => undefined,
        onInstanceClosure: (instanceId, outcome) => closures.push({ instanceId, outcome }),
      });
      launcher.launch(makeInstance("agent-v4"), LEGAL_BRIEF);
      await until(() => closures.length > 0, 3000, "closure 行到达");
      expect(closures[0]!.outcome.result).toBe("done");
      expect(warns).toEqual([]);
    } finally {
      restoreSpawn(real);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
