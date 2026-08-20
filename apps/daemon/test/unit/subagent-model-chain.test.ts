import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model, Models } from "@earendil-works/pi-ai";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";
import { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import type { InstanceRunner, InstanceRunnerCallbacks } from "../../src/application/services/InstanceRunner";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";

/**
 * T1.3 / F1.3：SubAgent 模型三级解析链（AD-3，TR-AD-24；test-design §CL-1）。
 * 纯构造 SubagentLauncher deps 桩（不起子进程）：解析单点 resolveModelFor
 * 逐档断言——profile.model（声明即最高）> spawnModelFor（spawn 会话快照）
 * > deps.model()（全局兜底 getter，T2.3 注入源模式保留）；高档有值时低档
 * 不调用（机械判据：spy 计数）。
 */

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
const sessionModel = mkModel("session-snapshot");
const profileModel = mkModel("profile-declared");

/** Models 目录桩：仅 "fake/profile-declared" 可解析（resolveModel 契约面）。 */
const modelsStub: Models = {
  getModel: (provider: string, id: string) =>
    provider === "fake" && id === "profile-declared" ? profileModel : undefined,
  getModels: () => [],
} as unknown as Models;

interface Spies {
  globalCalls: number;
  spawnCalls: string[];
}

function makeLauncher(opts: {
  profile?: AgentProfile;
  spawnModelFor?: (instanceId: string) => Model<any> | undefined;
  models?: Models;
  spies: Spies;
}): SubagentLauncher {
  return new SubagentLauncher({
    profile: opts.profile ?? SubAgentProfile,
    model: () => {
      opts.spies.globalCalls++;
      return globalModel;
    },
    apiKeys: { fake: "k" },
    toolCwd: "/tmp",
    ...(opts.spawnModelFor !== undefined ? { spawnModelFor: opts.spawnModelFor } : {}),
    ...(opts.models !== undefined ? { models: opts.models } : {}),
  });
}

describe("F1.3 三级解析单点（SubagentLauncher.resolveModelFor，AD-3 锚 1）", () => {
  test("第一级：profile.model 声明即最高优先级——低档（spawn 快照/全局兜底）不调用", () => {
    const spies: Spies = { globalCalls: 0, spawnCalls: [] };
    const launcher = makeLauncher({
      profile: { ...SubAgentProfile, model: "fake/profile-declared" },
      spawnModelFor: (id) => {
        spies.spawnCalls.push(id);
        return sessionModel;
      },
      models: modelsStub,
      spies,
    });
    expect(launcher.resolveModelFor("agent-1")).toBe(profileModel);
    expect(spies.spawnCalls).toHaveLength(0); // 高档有值 → 低档短路
    expect(spies.globalCalls).toBe(0);
  });

  test("第二级：profile 未声明 + spawnModelFor 返回会话快照 → 用快照，全局兜底不调用", () => {
    const spies: Spies = { globalCalls: 0, spawnCalls: [] };
    const launcher = makeLauncher({
      spawnModelFor: (id) => {
        spies.spawnCalls.push(id);
        return sessionModel;
      },
      spies,
    });
    expect(launcher.resolveModelFor("agent-7")).toBe(sessionModel);
    expect(spies.spawnCalls).toEqual(["agent-7"]);
    expect(spies.globalCalls).toBe(0);
  });

  test("第三级：spawnModelFor 返回 undefined → 落全局兜底 getter", () => {
    const spies: Spies = { globalCalls: 0, spawnCalls: [] };
    const launcher = makeLauncher({ spawnModelFor: () => undefined, spies });
    expect(launcher.resolveModelFor("agent-1")).toBe(globalModel);
    expect(spies.globalCalls).toBe(1);
  });

  test("第三级：spawnModelFor 缺省（未装配/未晚绑）→ 落全局兜底 getter", () => {
    const spies: Spies = { globalCalls: 0, spawnCalls: [] };
    const launcher = makeLauncher({ spies });
    expect(launcher.resolveModelFor("agent-1")).toBe(globalModel);
    expect(spies.globalCalls).toBe(1);
  });

  test("晚绑：bindSpawnModelSource 后第二级生效（container 手工装配形态）", () => {
    const spies: Spies = { globalCalls: 0, spawnCalls: [] };
    const launcher = makeLauncher({ spies });
    expect(launcher.resolveModelFor("agent-1")).toBe(globalModel); // 绑定前：全局兜底
    launcher.bindSpawnModelSource((id) => {
      spies.spawnCalls.push(id);
      return sessionModel;
    });
    expect(launcher.resolveModelFor("agent-2")).toBe(sessionModel); // 绑定后：会话快照
    expect(spies.spawnCalls).toEqual(["agent-2"]);
    expect(spies.globalCalls).toBe(1);
  });

  test("第一级 fail-fast：profile.model 声明但 models 目录未注入 → 中文报错含槽位值", () => {
    const spies: Spies = { globalCalls: 0, spawnCalls: [] };
    const launcher = makeLauncher({
      profile: { ...SubAgentProfile, model: "fake/profile-declared" },
      spies,
    });
    expect(() => launcher.resolveModelFor("agent-1")).toThrow(/fake\/profile-declared/);
  });
});

/** 最小 InstanceRunner 替身：只接住回调，不真驱动实例。 */
class StubRunner implements InstanceRunner {
  callbacks?: InstanceRunnerCallbacks;
  setCallbacks(callbacks: InstanceRunnerCallbacks): void {
    this.callbacks = callbacks;
  }
  launch(): void {
    /* 不驱动 */
  }
}

describe("F1.3 spawnModels 读通道（SchedulerService.spawnModelOf）", () => {
  test("spawn 携 model → spawnModelOf 返回快照；未携 model / 未知实例 → undefined（Map 生命周期不变）", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "helix-t13-unit-"));
    const writeQueue = new WriteQueue(path.join(home, "helix.db"));
    const repository = new SqliteSessionRepository(writeQueue);
    const publisher: EventPublisherPort = { publish: () => undefined, publishDelta: () => undefined };
    const scheduler = new SchedulerService({
      policy: new SchedulingPolicy(),
      runner: new StubRunner(),
      events: publisher,
      repository,
      clock: { now: () => "2024-01-01T00:00:00.000Z", nowMs: () => Date.now() },
      stalledPollMs: 100,
    });
    try {
      const withModel = scheduler.spawn("s-t13", "带模型任务", undefined, "fake/session-snapshot");
      expect(withModel.status).toBe("run");
      const withoutModel = scheduler.spawn("s-t13", "无模型任务");
      expect(withoutModel.status).toBe("run");
      expect(scheduler.spawnModelOf("agent-1")).toBe("fake/session-snapshot");
      expect(scheduler.spawnModelOf("agent-2")).toBeUndefined(); // 未携 model 无快照
      expect(scheduler.spawnModelOf("agent-99")).toBeUndefined(); // 未知实例
    } finally {
      scheduler.stop();
      await writeQueue.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
