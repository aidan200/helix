import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model, Models } from "@earendil-works/pi-ai";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { spawnOverridesFromEnv } from "../../src/adapters/driven/subagent/child/ChildMain";
import { AgentInstance } from "../../src/domain/agent/AgentInstance";

/**
 * M6 T2 SubAgent spawn 快照（代际生效，TR-AD-24 同构）：
 * - spawn 时刻读 getEffectiveTools/getEffectiveSkills 组装产物定格（父进程
 *   组合根缓存经 spawnSnapshot 注入）——env 透传子进程，launch 后主会话
 *   toggle 不影响已 spawn 实例（env 是值快照）；
 * - 未注入 spawnSnapshot（既有测试形态）→ 不透传 env 覆盖，子进程回退
 *   profile 声明面（ChildMain.spawnOverridesFromEnv 解析）；
 * - uiModelSlot：模型三级链第一级 UI 化（resource_state kind 槽位，spawn
 *   时刻读取定格）。
 *
 * 观测手段：Bun.spawn 打桩捕获 env（不起真子进程——transport 面挂最小假体）。
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
  const dir = mkdtempSync(path.join(tmpdir(), "helix-t2-snapshot-"));
  tmpRoots.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** Bun.spawn 桩：捕获 cmd/env，返回立退假进程（transport 面兼容）。 */
interface SpawnCall {
  readonly cmd: readonly string[];
  readonly env: Record<string, string | undefined>;
}

function patchSpawn(capture: SpawnCall[]): void {
  const fakeProc = () =>
    ({
      pid: 41000 + Math.floor(Math.random() * 900),
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

function restoreSpawn(real: typeof Bun.spawn): void {
  (Bun as unknown as { spawn: unknown }).spawn = real;
}

function makeInstance(id: string): AgentInstance {
  return AgentInstance.create({
    instanceId: id,
    kind: "subagent",
    profileKind: "subagent-worker",
    sessionId: "s-t2-snapshot",
    createdAt: "2026-08-20T00:00:00.000Z",
  });
}

describe("SubAgent spawn 快照（M6 T2，acceptance ④）", () => {
  test("① spawn 时刻读 spawnSnapshot：env 透传 HELIX_SYSTEM_PROMPT / HELIX_TOOLS_JSON", () => {
    const real = Bun.spawn;
    const calls: SpawnCall[] = [];
    patchSpawn(calls);
    try {
      let readCount = 0;
      const snapshot = { tools: ["bash", "read"], systemPrompt: "SUB base + 工具清单 + 技能段" };
      const launcher = new SubagentLauncher({
        profile: SubAgentProfile,
        model: mkModel("global"),
        apiKeys: { fake: "k" },
        toolCwd: tmpDir(),
        spawnSnapshot: () => {
          readCount++;
          return snapshot;
        },
      });
      launcher.launch(makeInstance("agent-1"), "任务");
      expect(readCount).toBe(1); // launch 时刻读取一次（spawn 定格）
      expect(calls).toHaveLength(1);
      expect(calls[0]!.env["HELIX_SYSTEM_PROMPT"]).toBe("SUB base + 工具清单 + 技能段");
      expect(calls[0]!.env["HELIX_TOOLS_JSON"]).toBe(JSON.stringify(["bash", "read"]));
    } finally {
      restoreSpawn(real);
    }
  });

  test("② 定格：launch 后变更快照源（toggle 刷新缓存）不影响已 spawn 实例；新 spawn 用新值", () => {
    const real = Bun.spawn;
    const calls: SpawnCall[] = [];
    patchSpawn(calls);
    try {
      let current = { tools: ["bash", "read", "write", "edit", "grep"], systemPrompt: "快照 A" };
      const launcher = new SubagentLauncher({
        profile: SubAgentProfile,
        model: mkModel("global"),
        apiKeys: { fake: "k" },
        toolCwd: tmpDir(),
        spawnSnapshot: () => current,
      });
      launcher.launch(makeInstance("agent-1"), "任务一");
      const env1 = calls[0]!.env;

      // 模拟 toggle 后组合根刷新缓存（如禁 grep）
      current = { tools: ["bash", "read", "write", "edit"], systemPrompt: "快照 B" };
      launcher.launch(makeInstance("agent-2"), "任务二");

      // 已 spawn 实例定格：env1 仍为快照 A 全集（值快照，不受后续变更影响）
      expect(env1["HELIX_SYSTEM_PROMPT"]).toBe("快照 A");
      expect(JSON.parse(env1["HELIX_TOOLS_JSON"]!)).toEqual(["bash", "read", "write", "edit", "grep"]);
      // 新 spawn 代际生效：快照 B / 去掉 grep
      expect(calls[1]!.env["HELIX_SYSTEM_PROMPT"]).toBe("快照 B");
      expect(JSON.parse(calls[1]!.env["HELIX_TOOLS_JSON"]!)).toEqual(["bash", "read", "write", "edit"]);
    } finally {
      restoreSpawn(real);
    }
  });

  test("③ 未注入 spawnSnapshot（既有测试形态）：env 不含覆盖键，子进程回退 profile 声明面", () => {
    const real = Bun.spawn;
    const calls: SpawnCall[] = [];
    patchSpawn(calls);
    try {
      const launcher = new SubagentLauncher({
        profile: SubAgentProfile,
        model: mkModel("global"),
        apiKeys: { fake: "k" },
        toolCwd: tmpDir(),
      });
      launcher.launch(makeInstance("agent-1"), "任务");
      expect(calls[0]!.env["HELIX_SYSTEM_PROMPT"]).toBeUndefined();
      expect(calls[0]!.env["HELIX_TOOLS_JSON"]).toBeUndefined();
    } finally {
      restoreSpawn(real);
    }
  });

  test("④ ChildMain 侧消费：spawnOverridesFromEnv 解析 env 覆盖（双键/缺席）", () => {
    expect(
      spawnOverridesFromEnv({
        HELIX_SYSTEM_PROMPT: "组装产物提示",
        HELIX_TOOLS_JSON: JSON.stringify(["bash", "read"]),
      }),
    ).toEqual({ systemPrompt: "组装产物提示", tools: ["bash", "read"] });
    // 缺席 → 空覆盖（子进程回退 SubAgentProfile 声明面）
    expect(spawnOverridesFromEnv({})).toEqual({});
  });
});

describe("uiModelSlot：模型三级链第一级 UI 化（M6 T2）", () => {
  const modelsStub: Models = {
    getModel: (provider: string, id: string) =>
      provider === "fake" && (id === "slot-model" || id === "profile-model") ? mkModel(id) : undefined,
    getModels: () => [],
  } as unknown as Models;

  test("⑤ 链序 profile.model > uiModelSlot > spawn 快照 > 全局兜底（高档有值低档不读）", () => {
    let slotCalls = 0;
    let spawnCalls = 0;
    let globalCalls = 0;
    const counters = () => ({ slotCalls, spawnCalls, globalCalls });

    // 档①：profile.model 声明即最高（既有语义不变）
    const l1 = new SubagentLauncher({
      profile: { ...SubAgentProfile, model: "fake/profile-model" },
      model: () => {
        globalCalls++;
        return mkModel("global");
      },
      apiKeys: { fake: "k" },
      toolCwd: tmpDir(),
      models: modelsStub,
      uiModelSlot: () => {
        slotCalls++;
        return mkModel("slot-model");
      },
      spawnModelFor: () => {
        spawnCalls++;
        return mkModel("session-snapshot");
      },
    });
    expect(l1.resolveModelFor("agent-1").id).toBe("profile-model");
    expect(counters()).toEqual({ slotCalls: 0, spawnCalls: 0, globalCalls: 0 }); // 低档零调用

    // 档②：uiModelSlot（resource_state kind 槽位）> spawn 快照 > 全局兜底
    const l2 = new SubagentLauncher({
      profile: SubAgentProfile,
      model: () => {
        globalCalls++;
        return mkModel("global");
      },
      apiKeys: { fake: "k" },
      toolCwd: tmpDir(),
      uiModelSlot: () => {
        slotCalls++;
        return mkModel("slot-model");
      },
      spawnModelFor: () => {
        spawnCalls++;
        return mkModel("session-snapshot");
      },
    });
    expect(l2.resolveModelFor("agent-1").id).toBe("slot-model");
    expect(counters()).toEqual({ slotCalls: 1, spawnCalls: 0, globalCalls: 0 });

    // 档③：无 slot → spawn 会话快照
    const l3 = new SubagentLauncher({
      profile: SubAgentProfile,
      model: () => {
        globalCalls++;
        return mkModel("global");
      },
      apiKeys: { fake: "k" },
      toolCwd: tmpDir(),
      uiModelSlot: () => {
        slotCalls++;
        return undefined; // 槽位未设
      },
      spawnModelFor: () => {
        spawnCalls++;
        return mkModel("session-snapshot");
      },
    });
    expect(l3.resolveModelFor("agent-1").id).toBe("session-snapshot");
    expect(counters()).toEqual({ slotCalls: 2, spawnCalls: 1, globalCalls: 0 });

    // 档④：全部缺席 → 全局兜底
    const l4 = new SubagentLauncher({
      profile: SubAgentProfile,
      model: () => {
        globalCalls++;
        return mkModel("global");
      },
      apiKeys: { fake: "k" },
      toolCwd: tmpDir(),
      spawnModelFor: () => {
        spawnCalls++;
        return undefined;
      },
    });
    expect(l4.resolveModelFor("agent-1").id).toBe("global");
    expect(counters()).toEqual({ slotCalls: 2, spawnCalls: 2, globalCalls: 1 });
  });
});
