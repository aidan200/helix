import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model, Models } from "@earendil-works/pi-ai";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { resolveConfigModel } from "../../src/adapters/driven/pi-engine/model-provider";
import { SchedulerService } from "../../src/application/services/SchedulerService";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";
import type { ClockPort } from "../../src/application/ports/outbound/ClockPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import type { ChildOutboundLine } from "../../src/adapters/driven/subagent/transport/wire";

/**
 * T1.3 / F1.3：spawn 会话快照 → 子进程 started 行模型链（AD-3 锚 2/3；
 * test-design §CL-1）。真子进程 + 剧本 runner，container 同式晚绑：
 * launcher.bindSpawnModelSource(id → scheduler.spawnModelOf(id) 经
 * resolveConfigModel 解析)——与 container.ts 生产装配逐行同构。
 *
 * 锚 2：spawn 携会话模型 → 子进程 started 行（ChildMain writeLine started
 *   携带 model）反映会话模型而非全局兜底；
 * 锚 3：快照语义——maxConcurrent=1 下排队实例在后续 spawn（= 会话再切模型
 *   的调度层显形）之后才 launch，started 行仍是其 spawn 时刻快照。
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
const modelA = mkModel("session-a");
const modelB = mkModel("session-b");
const modelC = mkModel("session-c");

/** 目录桩：会话快照 id → Model（container 的 catalog.modelsView() 替身）。 */
const modelsView: Models = {
  getModel: (provider: string, id: string) =>
    provider === "fake"
      ? ({ "session-a": modelA, "session-b": modelB, "session-c": modelC })[id]
      : undefined,
  getModels: () => [],
} as unknown as Models;

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

describe("F1.3 spawn 快照 → 子进程 started 行（真子进程 + 剧本，锚 2/3）", () => {
  test("会话模型快照进 HELIX_MODEL_JSON；排队实例 launch 时仍读自身 spawn 时刻快照", async () => {
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
      profile: SubAgentProfile, // 生产形态：第一级不声明
      model: () => globalModel, // 第三级：全局兜底 getter
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
    // container 同式晚绑（装配序：launcher 先于 scheduler 构造）
    launcher.bindSpawnModelSource((id) => {
      const m = scheduler.spawnModelOf(id);
      return m === undefined ? undefined : resolveConfigModel(m, modelsView);
    });
    cleanup = async () => {
      scheduler.stop();
      await launcher.dispose();
      await writeQueue.close();
      rmSync(home, { recursive: true, force: true });
    };

    // agent-1 直跑（会话模型 a）；agent-2/agent-3 排队（快照 b/c——
    // agent-3 的 spawn = 「spawn 后会话再切模型」的调度层显形）
    expect(scheduler.spawn(SESSION_ID, "任务一", undefined, "fake/session-a").status).toBe("run");
    expect(scheduler.spawn(SESSION_ID, "任务二", undefined, "fake/session-b").status).toBe("queued");
    expect(scheduler.spawn(SESSION_ID, "任务三", undefined, "fake/session-c").status).toBe("queued");

    await until(
      () => events.filter((e) => e.type === "agent.completed").length === 3,
      20000,
      "等待三实例 completed",
    );

    const startedOf = (id: string) =>
      lines.find((l) => l.instanceId === id && l.line.type === "started")?.line as
        | { model: unknown }
        | undefined;

    // 锚 2：started 行模型 = 会话快照解析结果（非全局兜底 globalModel）
    expect(startedOf("agent-1")?.model).toEqual(JSON.parse(JSON.stringify(modelA)));
    expect(startedOf("agent-1")?.model).not.toEqual(JSON.parse(JSON.stringify(globalModel)));
    // 锚 3：排队实例 launch 晚于后续 spawn（会话已「再切」c），仍是 spawn 时刻快照
    expect(startedOf("agent-2")?.model).toEqual(JSON.parse(JSON.stringify(modelB)));
    expect(startedOf("agent-3")?.model).toEqual(JSON.parse(JSON.stringify(modelC)));
  }, 30000);

  test("spawn 未携模型（无快照）→ 子进程落全局兜底（第三级）", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t13-fallback-"));
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
      profile: SubAgentProfile,
      model: () => globalModel,
      apiKeys: { fake: "k" },
      toolCwd: home,
      fakeEngineScript: scriptPath,
      onLine: (instanceId, line) => lines.push({ instanceId, line }),
    });
    const scheduler = new SchedulerService({
      policy: new SchedulingPolicy(),
      runner: launcher,
      events: publisher,
      repository,
      clock,
      stalledPollMs: 100,
    });
    launcher.bindSpawnModelSource((id) => {
      const m = scheduler.spawnModelOf(id);
      return m === undefined ? undefined : resolveConfigModel(m, modelsView);
    });
    cleanup = async () => {
      scheduler.stop();
      await launcher.dispose();
      await writeQueue.close();
      rmSync(home, { recursive: true, force: true });
    };

    expect(scheduler.spawn(SESSION_ID, "无快照任务").status).toBe("run");
    await until(() => events.some((e) => e.type === "agent.completed"), 15000, "等待 completed");
    const started = lines.find((l) => l.line.type === "started")?.line as { model: unknown } | undefined;
    expect(started?.model).toEqual(JSON.parse(JSON.stringify(globalModel)));
  }, 20000);
});
