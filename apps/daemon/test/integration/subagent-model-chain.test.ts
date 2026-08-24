import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../src/application/ports/outbound/ClockPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { ChildOutboundLine } from "../../src/adapters/driven/subagent/transport/wire";

/**
 * T1.3 / F1.3 → T12 回归钉：spawn 透传模型不再作用 SubAgent（AD-3 锚 2/3
 * 改写；test-design §CL-1）。真子进程 + 剧本 runner。
 *
 * T12 砍 spawn 会话快照级：SubAgent 模型只认自身 profile 链（profile 槽位
 * > 全局兜底），不继承 main session 选择——scheduler.spawn 第四参（spawn
 * 透传模型 id，AgentInstanceDto.model 填充链保留）不再进入 launcher
 * 解析链（bindSpawnModelSource/spawnModelOf 管线退役）。
 *
 * 锚 2（反方向钉）：spawn 携模型 → 子进程 started 行（ChildMain writeLine
 *   started 携带 model）仍反映全局兜底而非 spawn 透传值；
 * 锚 3：maxConcurrent=1 下排队实例 launch 时同样不受各自 spawn 透传值影响。
 */

const SESSION_ID = "s-t13";
const FIXED_NOW = "2026-08-19T00:00:00.000Z";

const mkModel = (id: string): Model<any> =>
  ({
    id,
    name: `Fake ${id}`,
    api: "anthropic-messages",
    provider: "fake",
    baseUrl: "http://localhost-unused",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8192,
  }) as unknown as Model<any>;

const globalModel = mkModel("global-default");

const closureBlock = (summary: string) =>
  `<<<CLOSURE\n${JSON.stringify({ status: "done", summary, reportPath: null, findings: [], taskId: null })}\nCLOSURE>>>`;

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  const c = cleanup;
  cleanup = undefined;
  await c?.();
});

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

describe("F1.3/T12 spawn 透传模型不作用子进程（真子进程 + 剧本，锚 2/3 改写）", () => {
  test("spawn 携模型 → 子进程仍用全局兜底；排队实例同（透传值仅填充 DTO，不进解析链）", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t13-chain-"));
    const scriptPath = path.join(home, "script.json");
    writeFileSync(
      scriptPath,
      JSON.stringify({ replies: [`完成。${closureBlock("ok")}`], chunkDelayMs: 5 }),
    );

    const writeQueue = new WriteQueue(path.join(home, "helix.db"));
    const repository = new SqliteSessionRepository(writeQueue);
    const events: DomainEvent[] = [];
    const publisher: EventPublisherPort = { publish: (e) => events.push(e), publishDelta: () => undefined };
    const clock: ClockPort = { now: () => FIXED_NOW, nowMs: () => Date.parse(FIXED_NOW) };
    const lines: { instanceId: string; line: ChildOutboundLine }[] = [];
    const launcher = new SubagentLauncher({
      profile: SubAgentProfile, // 生产形态：profile 静态槽位不声明
      model: () => globalModel, // 全局兜底 getter（两级链第二级）
      apiKeys: { fake: "k" },
      toolCwd: home,
      fakeEngineScript: scriptPath,
      onLine: (instanceId, line) => lines.push({ instanceId, line }),
    });
    const scheduler = new SchedulerService({
      policy: new SchedulingPolicy({ maxConcurrent: 1, maxQueued: 8 }),
      runner: launcher,
      events: publisher,
      repository,
      clock,
      stalledPollMs: 100,
    });
    cleanup = async () => {
      scheduler.stop();
      await launcher.dispose();
      await writeQueue.close();
      rmSync(home, { recursive: true, force: true });
    };

    // 首个直跑；后两个排队——三者 spawn 透传不同模型 id
    //（旧链下会作为会话快照进子进程；T12 后仅填充 AgentInstanceDto.model）
    // T10a：spawn id = agent-<唯一串>，捕获而非硬编码
    const spawn1 = scheduler.spawn(SESSION_ID, "任务一", undefined, "fake/session-a");
    const spawn2 = scheduler.spawn(SESSION_ID, "任务二", undefined, "fake/session-b");
    const spawn3 = scheduler.spawn(SESSION_ID, "任务三", undefined, "fake/session-c");
    expect(spawn1.status).toBe("run");
    expect(spawn2.status).toBe("queued");
    expect(spawn3.status).toBe("queued");
    if (spawn1.status === "rejected" || spawn2.status === "rejected" || spawn3.status === "rejected") throw new Error("unreachable");
    const ids = [spawn1.agentId, spawn2.agentId, spawn3.agentId];

    await until(
      () => events.filter((e) => e.type === "agent.completed").length === 3,
      20000,
      "等待三实例 completed",
    );

    const startedOf = (id: string) =>
      lines.find((l) => l.instanceId === id && l.line.type === "started")?.line as
        | { model: unknown }
        | undefined;

    // 锚 2/3（反向钉）：三实例 started 行模型 = 全局兜底（非各自 spawn 透传值）
    for (const id of ids) {
      expect(startedOf(id)?.model).toEqual(JSON.parse(JSON.stringify(globalModel)));
    }
    // DTO 填充链不受影响：spawn 透传值仍随实例快照透出
    const snapshot = scheduler.snapshotInstances(SESSION_ID);
    expect(snapshot.find((i) => i.instanceId === ids[0])?.model).toBe("fake/session-a");
    expect(snapshot.find((i) => i.instanceId === ids[1])?.model).toBe("fake/session-b");
    expect(snapshot.find((i) => i.instanceId === ids[2])?.model).toBe("fake/session-c");
  }, 30000);
});
