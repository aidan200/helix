import { describe, expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import { AgentInstance } from "../../src/domain/agent/AgentInstance";
import type { CustomProviderDef } from "../../src/application/ports/outbound/CustomProviderPort";

/**
 * custom provider 子进程透传批（父侧）：SubagentLauncher launch 段新增
 * HELIX_CUSTOM_PROVIDERS_JSON（自定义 provider 定义全量 env 定格透传，
 * mcpServersFor/HELIX_MCP_SERVERS_JSON 三级过滤先例同族）。
 *
 * 断言面（Bun.spawn 打桩——mcp-child.test.ts ① 先例同构）：
 * - 有定义 → env 含序列化 JSON（解析回读等值）；
 * - 空表 / getter 未注入 → 不传键（子进程零注册零开销）；
 * - launch 时刻定格语义（getter 现值逐 launch 读取——registry 后变不影响
 *   已透传值，新 launch 跟随新值，代际生效）。
 */

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

const defA: CustomProviderDef = {
  id: "cp-alpha",
  name: "Alpha 平台",
  api: "openai-completions",
  thinkingFormat: "deepseek",
  baseUrl: "https://alpha.example.com/v1",
  models: [{ id: "a-1", name: "Alpha One", contextWindow: 128_000, reasoning: true }],
};

const defB: CustomProviderDef = {
  id: "cp-beta",
  name: "Beta 平台",
  baseUrl: "https://beta.example.com/v1",
  models: [{ id: "b-1", contextWindow: 64_000 }],
};

function makeInstance(id = "agent-cp-env-1"): AgentInstance {
  return AgentInstance.create({
    instanceId: id,
    kind: "subagent",
    profileKind: "subagent-worker",
    sessionId: "s-cp-env",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
}

interface SpawnCall {
  readonly env: Record<string, string | undefined>;
}

/** Bun.spawn 打桩（mcp-child.test.ts ① 同构）：捕获 env，返回空转假进程。 */
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
    capture.push({ env: { ...opts.env } });
    return fakeProc();
  };
}

function makeLauncher(opts: {
  customProviders?: () => readonly CustomProviderDef[];
  ledger?: { current: readonly CustomProviderDef[] };
}): SubagentLauncher {
  return new SubagentLauncher({
    profile: SubAgentProfile,
    model: fakeModel,
    apiKeys: {},
    toolCwd: process.cwd(),
    ...(opts.customProviders !== undefined
      ? { customProviders: opts.customProviders }
      : opts.ledger !== undefined
        ? { customProviders: () => opts.ledger!.current }
        : {}),
  });
}

describe("custom provider 子进程透传（HELIX_CUSTOM_PROVIDERS_JSON，launch 时刻定格）", () => {
  test("有定义 → env 含序列化 JSON（解析回读等值断言）", () => {
    const real = Bun.spawn;
    const calls: SpawnCall[] = [];
    patchSpawn(calls);
    try {
      makeLauncher({ customProviders: () => [defA] }).launch(makeInstance(), "t");
      const env = calls[calls.length - 1]!.env;
      expect(typeof env.HELIX_CUSTOM_PROVIDERS_JSON).toBe("string");
      expect(JSON.parse(env.HELIX_CUSTOM_PROVIDERS_JSON!)).toEqual([defA]);
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = real;
    }
  });

  test("多定义全量透传（JSON 数组回读等值）", () => {
    const real = Bun.spawn;
    const calls: SpawnCall[] = [];
    patchSpawn(calls);
    try {
      makeLauncher({ customProviders: () => [defA, defB] }).launch(makeInstance("agent-cp-env-2"), "t");
      const env = calls[calls.length - 1]!.env;
      expect(JSON.parse(env.HELIX_CUSTOM_PROVIDERS_JSON!)).toEqual([defA, defB]);
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = real;
    }
  });

  test("空表 / getter 未注入 → env 键空缺（子进程零注册不炸）", () => {
    const real = Bun.spawn;
    const calls: SpawnCall[] = [];
    patchSpawn(calls);
    try {
      makeLauncher({ customProviders: () => [] }).launch(makeInstance("agent-cp-env-3"), "t");
      expect("HELIX_CUSTOM_PROVIDERS_JSON" in calls[calls.length - 1]!.env).toBe(false);
      makeLauncher({}).launch(makeInstance("agent-cp-env-4"), "t");
      expect("HELIX_CUSTOM_PROVIDERS_JSON" in calls[calls.length - 1]!.env).toBe(false);
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = real;
    }
  });

  test("launch 时刻定格：getter 现值逐 launch 读取——registry 后变不影响已透传值（代际生效）", () => {
    const real = Bun.spawn;
    const calls: SpawnCall[] = [];
    patchSpawn(calls);
    try {
      const ledger: { current: readonly CustomProviderDef[] } = { current: [defA] };
      const launcher = makeLauncher({ ledger });
      launcher.launch(makeInstance("agent-cp-env-5"), "t");
      // launch 后注册表变化（provider CRUD 现值翻转）
      ledger.current = [defB];
      launcher.launch(makeInstance("agent-cp-env-6"), "t");
      // 已透传值不受影响（第一次 launch 的 env 仍为 defA 定格值）
      expect(JSON.parse(calls[0]!.env.HELIX_CUSTOM_PROVIDERS_JSON!)).toEqual([defA]);
      // 新 launch 跟随新值（launch 时刻读现值）
      expect(JSON.parse(calls[1]!.env.HELIX_CUSTOM_PROVIDERS_JSON!)).toEqual([defB]);
    } finally {
      (Bun as unknown as { spawn: unknown }).spawn = real;
    }
  });
});
