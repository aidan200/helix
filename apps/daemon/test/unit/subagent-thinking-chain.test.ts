import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";
import { SchedulerService } from "../../src/application/services/scheduler/SchedulerService";
import type { InstanceRunner, InstanceRunnerCallbacks } from "../../src/application/services/InstanceRunner";
import { SchedulingPolicy } from "../../src/domain/agent/SchedulingPolicy";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { SqliteSessionRepository } from "../../src/adapters/driven/sqlite-session/SqliteSessionRepository";
import type { EventPublisherPort } from "../../src/application/ports/outbound/EventPublisherPort";
import type { DomainEvent } from "../../src/domain/events/DomainEvent";
import { AgentInstance } from "../../src/domain/agent/AgentInstance";

/**
 * T1.3 / thinking 批（AD-1 落点二 + AD-4④ + AD-6；test-design §2.1/§2.4）：
 * SubAgent thinking 解析链（resolveThinkingFor：仅自身 profile 槽位，无
 * 兜底——默认关 D 方案；有意短于 resolveModelFor 四级链：SubAgent 无
 * UI/快照级覆盖）+ launch 时刻定格 env 透传 + agent.instantiated 携带。
 *
 * 红线机械判据（brief 决策消解）：
 * - 「主会话覆盖永不作用 SubAgent」→ resolveThinkingFor 输入只有 profile
 *   槽位（隔离负断言：main-session 槽位/会话覆盖概念不在输入面，存在时
 *   解析结果零影响）；
 * - 「launch 时刻定格」→ resolveThinkingFor 仅在 launch 段调用一次，结果
 *   经 HELIX_THINKING_LEVEL env 值快照透传（已 spawn 实例不受后续配置
 *   变更影响——代际生效）。
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

const tmpRoots: string[] = [];
const tmpDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-t13-thinking-"));
  tmpRoots.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function makeLauncher(profile: AgentProfile | (() => AgentProfile)): SubagentLauncher {
  return new SubagentLauncher({
    profile,
    model: mkModel("global"),
    apiKeys: { fake: "k" },
    toolCwd: "/tmp",
  });
}

describe("resolveThinkingFor（SubAgent 链解析单点：仅 profile 槽位，无兜底）", () => {
  test("profile.thinkingLevel 在位 → 槽位值", () => {
    const launcher = makeLauncher({ ...SubAgentProfile, thinkingLevel: "xhigh" });
    expect(launcher.resolveThinkingFor()).toBe("xhigh");
  });

  test("profile 留空 → undefined（默认关，D 方案：无 medium 兜底）", () => {
    const launcher = makeLauncher(SubAgentProfile);
    expect(launcher.resolveThinkingFor()).toBeUndefined();
  });

  test("profile getter 形态：launch 时刻读现值（resource_state 槽位合并面，配置变更后新 spawn 跟随）", () => {
    let slot: string | undefined = undefined;
    const launcher = makeLauncher(() => ({
      ...SubAgentProfile,
      ...(slot !== undefined ? { thinkingLevel: slot } : {}),
    }));
    expect(launcher.resolveThinkingFor()).toBeUndefined(); // 未配置 → 默认关
    slot = "high";
    expect(launcher.resolveThinkingFor()).toBe("high"); // 读现值
  });

  test("隔离负断言（AD-1 红线）：main-session 槽位/主会话覆盖存在时 SubAgent 解析零影响", () => {
    // 模拟组合根接线：profile getter 只读 subagent-worker 槽位；
    // main-session 槽位（主会话覆盖的配置面）存在不进入解析输入。
    const slots: Record<string, string | undefined> = { "main-session": "max", "subagent-worker": undefined };
    const launcher = makeLauncher(() => ({
      ...SubAgentProfile,
      ...(slots["subagent-worker"] !== undefined ? { thinkingLevel: slots["subagent-worker"] } : {}),
    }));
    expect(launcher.resolveThinkingFor()).toBeUndefined(); // main 的 max 不传染
  });
});

// ── env 定格透传（Bun.spawn 打桩捕获，不起真子进程） ──

interface SpawnCall {
  readonly cmd: readonly string[];
  readonly env: Record<string, string | undefined>;
}

function patchSpawn(capture: SpawnCall[]): void {
  const fakeProc = () =>
    ({
      pid: 42000 + Math.floor(Math.random() * 900),
      exited: Promise.resolve(0),
      stdout: (async function* () {})(),
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

function makeInstance(id: string): AgentInstance {
  return AgentInstance.create({
    instanceId: id,
    kind: "subagent",
    profileKind: "subagent-worker",
    sessionId: "s-t13-thinking",
    createdAt: "2026-08-23T00:00:00.000Z",
  });
}

describe("launch 段 env 定格透传（HELIX_THINKING_LEVEL 字符串形态）", () => {
  test("launch 后 env 含定格值；配置变更后新 spawn 跟随新值、已 spawn 实例 env 已定格（代际生效）", () => {
    const real = Bun.spawn;
    const calls: SpawnCall[] = [];
    patchSpawn(calls);
    try {
      let slot: string | undefined = "xhigh";
      const launcher = makeLauncher(() => ({
        ...SubAgentProfile,
        ...(slot !== undefined ? { thinkingLevel: slot } : {}),
      }));
      launcher.launch(makeInstance("agent-t1"), "任务一");
      expect(calls[0]!.env["HELIX_THINKING_LEVEL"]).toBe("xhigh");

      // 配置变更（clear）后新 spawn 跟随（未配置 → env 缺席 = 默认关）；
      // 首个实例 env 快照不变
      slot = undefined;
      launcher.launch(makeInstance("agent-t2"), "任务二");
      expect(calls[1]!.env["HELIX_THINKING_LEVEL"]).toBeUndefined(); // 留空 → 无兜底（默认关）
      expect(calls[0]!.env["HELIX_THINKING_LEVEL"]).toBe("xhigh"); // 已定格不受影响
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = real;
    }
  });
});

// ── agent.instantiated 携带 thinkingLevel（只落盘不广播语义不变，AF-6） ──

class StubRunner implements InstanceRunner {
  setCallbacks(_callbacks: InstanceRunnerCallbacks): void {
    /* 不驱动 */
  }
  launch(): void {
    /* 不驱动 */
  }
}

describe("SchedulerService.spawn：agent.instantiated payload 携带 thinkingLevel（AD-4④）", () => {
  test("快照组装产物 thinkingLevel 进入落盘事件 payload；spawn 签名不扩（经组装回调单点）", async () => {
    const home = tmpDir();
    const writeQueue = new WriteQueue(path.join(home, "helix.db"));
    const repository = new SqliteSessionRepository(writeQueue);
    const published: DomainEvent[] = [];
    const publisher: EventPublisherPort = {
      publish: (event) => {
        published.push(event);
      },
      publishDelta: () => undefined,
    };
    const scheduler = new SchedulerService({
      policy: new SchedulingPolicy(),
      runner: new StubRunner(),
      events: publisher,
      repository,
      clock: { now: () => "2026-08-23T00:00:00.000Z", nowMs: () => Date.now() },
      stalledPollMs: 100,
      // 组合根装配形态：快照组装与 launcher resolveThinkingFor 同源同时点
      subagentSnapshotFor: () => ({
        thinkingLevel: "xhigh",
        profileSnapshot: { systemPrompt: "SUB", tools: ["bash"], model: "fake/global" },
      }),
    });
    try {
      const outcome = scheduler.spawn("s-t13-thinking", "快照任务");
      expect(outcome.status).toBe("run");
      const instantiated = published.find((e) => e.type === "agent.instantiated");
      expect(instantiated).toBeDefined();
      const payload = instantiated!.payload as { thinkingLevel?: string; profileSnapshot?: unknown };
      expect(payload.thinkingLevel).toBe("xhigh");
      expect(payload.profileSnapshot).toBeDefined();
    } finally {
      scheduler.stop();
      await writeQueue.close();
    }
  });
});
