import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { AgentInstance } from "../../src/domain/agent/AgentInstance";
import type { ChildOutboundLine } from "../../src/adapters/driven/subagent/transport/wire";
import type { InstanceClosureOutcome } from "../../src/application/services/InstanceRunner";
import { PARK_INSTRUCTION_TEXT, RESUME_INSTRUCTION_TEXT } from "../../src/application/services/scheduler/parkProtocol";

/**
 * ⑤ park/resume 批 T7：子进程级挂起协议 integration（真 Bun.spawn +
 * FakeEngineScript 剧本注入——LLM 输出钉定，协议执行/硬拦截全真）。
 *
 * ① 主链路：park 指令 → drain 轮输出 <<<PARK {...} PARK>>> → parked 行
 *   上行（progress/next 摘要）→ 进程驻留不收口 → RESUME 注入唤醒 →
 *   continueRun 同一会话续跑 → closure 收口 exit(0)；
 * ② 硬拦截（P6 第二层）：park 请求后在飞工具调用完成（协议=回合边界生效），
 *   其后新工具调用一律拒绝（isError + 「已请求挂起」）→ 模型只能输出
 *   PARK 标记；
 * ③ 挂起期 steer 暂存：RESUME 前注入的普通消息随恢复 run 一并 drain；
 * ④ parked 期间 kill：SIGTERM 唤醒挂起等待 → failed(terminated) 收口 →
 *   exit(0)（O-6 优雅路径，调度侧 → failed 终态）。
 */

const SESSION_ID = "s-park-child";
const FIXED_NOW = "2026-08-31T00:00:00.000Z";

/** 离线 fake 模型（subagent-child.test 同口径）。 */
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

const closureBlock = (summary: string, status: "done" | "failed" = "done") =>
  `<<<CLOSURE\n${JSON.stringify({ status, summary, reportPath: null, findings: [], taskId: null })}\nCLOSURE>>>`;

const parkBlock = (progress: string, next: string) =>
  `<<<PARK\n${JSON.stringify({ progress, next })}\nPARK>>>`;

interface Harness {
  launcher: SubagentLauncher;
  home: string;
  closures: { instanceId: string; outcome: InstanceClosureOutcome }[];
  lines: { instanceId: string; line: ChildOutboundLine }[];
  parkedLines: { instanceId: string; summary: { progress: string; next: string } }[];
}

function makeHarness(script: object, opts: { graceMs?: number } = {}): Harness {
  const home = mkdtempSync(path.join(tmpdir(), "helix-park-child-"));
  const scriptPath = path.join(home, "script.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const closures: Harness["closures"] = [];
  const lines: Harness["lines"] = [];
  const parkedLines: Harness["parkedLines"] = [];
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
    onInstanceEvent: () => undefined,
    onInstanceClosure: (instanceId, outcome) => closures.push({ instanceId, outcome }),
    onInstanceParked: (instanceId, summary) => parkedLines.push({ instanceId, summary }),
  });
  return { launcher, home, closures, lines, parkedLines };
}

function launch(h: Harness, task = "挂起协议验证任务", id = "agent-1"): void {
  h.launcher.launch(
    AgentInstance.create({
      instanceId: id,
      kind: "subagent",
      profileKind: "subagent-worker",
      sessionId: SESSION_ID,
      createdAt: FIXED_NOW,
    }),
    task,
  );
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

/** 事件行某类型的到达判定输入。 */
function engineEvents(h: Harness, type: string): unknown[] {
  return h.lines
    .filter((l) => l.line.type === "event" && (l.line.event as { type?: string }).type === type)
    .map((l) => (l.line as { event: unknown }).event);
}

let current: { launcher: SubagentLauncher; home: string } | undefined;
afterEach(async () => {
  if (current) {
    await current.launcher.dispose();
    rmSync(current.home, { recursive: true, force: true });
    current = undefined;
  }
});

describe("① 主链路：park → PARK 标记 → parked 上行 → 驻留 → RESUME → 续跑 → 收口", () => {
  test("四段闭环：挂起指令 drain 为新轮输出 PARK、parked 行携摘要、进程驻留零收口、恢复后同会话续跑收口", async () => {
    const h = (current = makeHarness({
      replies: [
        "第一阶段：正在调研依赖。" + "工".repeat(160), // turn1：慢流（供 park 注入时窗）
        `暂停点确认。${parkBlock("调研完成一半", "从实现阶段继续")}`, // turn2：park 指令 drain 轮 → PARK 标记
        `恢复后继续完成。${closureBlock("恢复后完成收口", "done")}`, // turn3：resume 续跑轮 → closure
      ],
      chunkDelayMs: 8,
    }));
    launch(h, "验证主链路");
    await until(() => engineEvents(h, "message_update").length > 0, 8000, "等待 turn1 流式");

    // park 指令注入（协议标记文本单点）→ drain 为新 turn → 剧本输出 PARK 标记
    h.launcher.send("agent-1", PARK_INSTRUCTION_TEXT);
    await until(() => h.parkedLines.length > 0, 10_000, "等待 parked 上行");
    expect(h.parkedLines).toEqual([
      { instanceId: "agent-1", summary: { progress: "调研完成一半", next: "从实现阶段继续" } },
    ]);
    // 挂起驻留：进程活着、无 closure、未退出（exited promise 300ms 内不 settle）
    expect(h.closures).toHaveLength(0);
    const exitedEarly = await Promise.race([
      h.launcher.childExit("agent-1")!.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 300)),
    ]);
    expect(exitedEarly).toBe(false); // 进程驻留（不收口不退出）

    // RESUME 注入 → 唤醒 → continueRun 同一会话续跑（对话历史含 PARK 摘要）→ closure
    h.launcher.send("agent-1", RESUME_INSTRUCTION_TEXT);
    await until(() => h.closures.length > 0, 10_000, "等待恢复后收口");
    expect(h.closures[0]!.outcome.result).toBe("done");
    expect(h.closures[0]!.outcome.closure.summary).toBe("恢复后完成收口");
    expect(await h.launcher.childExit("agent-1")).toBe(0);
  }, 25_000);
});

describe("② 硬拦截（P6 第二层）：park 请求后工具调用一律拒绝", () => {
  test("在飞工具调用完成（isError=false）→ 其后新工具调用被拦（isError + 已请求挂起）→ PARK 输出", async () => {
    const h = (current = makeHarness({
      toolCalls: [
        { name: "bash", args: { command: "sleep 1" } }, // turn1：在飞长工具（1s 时窗注入 park）
        { name: "bash", args: { command: "echo second" } }, // turn2：park 后新工具调用 → 硬拦截
      ],
      replies: [`收到拦截结果，输出挂起标记。${parkBlock("工具被拦后挂起", "恢复后换路径")}`, `${closureBlock("拦截链路完成", "done")}`],
      chunkDelayMs: 5,
    }));
    launch(h, "验证硬拦截");
    await until(() => engineEvents(h, "tool_execution_start").length > 0, 8000, "等待工具开跑");

    // 在飞工具执行期间注入 park（sleep 1s 时窗）——协议=完成当前调用后生效
    h.launcher.send("agent-1", PARK_INSTRUCTION_TEXT);

    // 第一个工具（在飞）：正常完成
    await until(() => engineEvents(h, "tool_execution_end").length > 0, 8000, "等待在飞工具完成");
    const ends = engineEvents(h, "tool_execution_end") as { isError: boolean; result: string }[];
    expect(ends[0]!.isError).toBe(false);

    // 第二个工具（park 后新调用）：硬拦截——isError + 拦截提示（LLM 不听话也拦得住）
    await until(() => ends.length >= 2 || h.parkedLines.length > 0, 10_000, "等待拦截结果/PARK");
    const endsAfter = engineEvents(h, "tool_execution_end") as { isError: boolean; result: string; toolName: string }[];
    expect(endsAfter).toHaveLength(2);
    expect(endsAfter[1]!.isError).toBe(true);
    expect(endsAfter[1]!.result).toContain("已请求挂起");

    // 被拦后模型输出 PARK → 挂起驻留；再验证恢复续跑收口（拦截随 resume 解除）
    await until(() => h.parkedLines.length > 0, 8000, "等待 parked 上行");
    h.launcher.send("agent-1", RESUME_INSTRUCTION_TEXT);
    await until(() => h.closures.length > 0, 10_000, "等待恢复后收口");
    expect(h.closures[0]!.outcome.result).toBe("done");
  }, 30_000);
});

describe("③ 挂起期 steer 暂存：RESUME 前注入随恢复 run 一并送达", () => {
  test("parked 期普通注入 + RESUME → 恢复 run 消费暂存消息（剧本按序收口）", async () => {
    const h = (current = makeHarness({
      replies: [
        "先干着。" + "忙".repeat(120),
        `好，暂停。${parkBlock("暂存前进展", "处理暂存消息")}`,
        "收到补充指示与恢复指令，继续处理。", // resume run turn A：drain 暂存消息（FIFO 首条）
        `已全部处理完毕。${closureBlock("暂存消息已随恢复送达", "done")}`, // resume run turn B：drain RESUME 指令 → 收口
      ],
      chunkDelayMs: 8,
    }));
    launch(h, "验证暂存");
    await until(() => engineEvents(h, "message_update").length > 0, 8000, "等待流式");
    h.launcher.send("agent-1", PARK_INSTRUCTION_TEXT);
    await until(() => h.parkedLines.length > 0, 10_000, "等待 parked 上行");

    // 挂起期普通 steer：子进程 steer 队列暂存（无新 turn —— 零 token）
    h.launcher.send("agent-1", "补充指示：改用方案 B");
    await new Promise((r) => setTimeout(r, 300)); // 确保已入队而未驱动
    expect(h.closures).toHaveLength(0);
    // 挂起期注入不驱动引擎：无新 message_start（漏检注入即驱动 = 协议破绽）
    expect(engineEvents(h, "message_start").filter((e) => (e as { source?: string }).source === "steer-drain")).toHaveLength(1); // 仅 park 指令 drain 过一次

    // RESUME：暂存消息 + 恢复指令随 continue run 一并 drain → 收口
    h.launcher.send("agent-1", RESUME_INSTRUCTION_TEXT);
    await until(() => h.closures.length > 0, 10_000, "等待恢复后收口");
    expect(h.closures[0]!.outcome.closure.summary).toBe("暂存消息已随恢复送达");
  }, 25_000);
});

describe("④ parked 期间 kill：SIGTERM 唤醒挂起等待 → failed(terminated) 收口", () => {
  test("挂起驻留中 kill → 优雅退出（graceful）+ terminated closure + exit(0)", async () => {
    const h = (current = makeHarness({
      replies: [
        "干活中。" + "干".repeat(120),
        `准备挂起。${parkBlock("被 kill 前挂起", "无")}`,
      ],
      chunkDelayMs: 8,
    }));
    launch(h, "验证 parked kill");
    await until(() => engineEvents(h, "message_update").length > 0, 8000, "等待流式");
    h.launcher.send("agent-1", PARK_INSTRUCTION_TEXT);
    await until(() => h.parkedLines.length > 0, 10_000, "等待 parked 上行");

    const outcome = await h.launcher.kill("agent-1");
    expect(outcome).toBe("graceful"); // 挂起等待被 SIGTERM 唤醒走优雅路径（非 grace 超时强杀）
    await until(() => h.closures.length > 0, 6000, "等待 terminated 收口");
    expect(h.closures[0]!.outcome.result).toBe("failed");
    expect(h.closures[0]!.outcome.closure.summary).toContain("terminated");
    expect(await h.launcher.childExit("agent-1")).toBe(0);
  }, 25_000);
});
