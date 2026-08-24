import { describe, expect, test } from "bun:test";
import type { Model, Models } from "@earendil-works/pi-ai";
import { SubagentLauncher } from "../../src/adapters/driven/subagent/SubagentLauncher";
import { SubAgentProfile } from "../../src/adapters/driven/pi-engine/runtime/profiles/SubAgentProfile";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";

/**
 * T1.3 / F1.3：SubAgent 模型解析链（AD-3，TR-AD-24；test-design §CL-1）。
 * T12 砍 spawn 会话快照级后 = 两级链：profile 槽位（静态声明 ??
 * uiModelSlot kind 槽位）> 全局兜底（deps.model getter，T2.3 注入源模式
 * 保留）——SubAgent 只认自身 profile，不继承 main session 选择。
 * 纯构造 SubagentLauncher deps 桩（不起子进程）：解析单点 resolveModelFor
 * 逐档断言；高档有值时低档不调用（机械判据：spy 计数）。
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
const profileModel = mkModel("profile-declared");

/** Models 目录桩：仅 "fake/profile-declared" 可解析（resolveModel 契约面）。 */
const modelsStub: Models = {
  getModel: (provider: string, id: string) =>
    provider === "fake" && id === "profile-declared" ? profileModel : undefined,
  getModels: () => [],
} as unknown as Models;

interface Spies {
  globalCalls: number;
}

function makeLauncher(opts: {
  profile?: AgentProfile;
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
    ...(opts.models !== undefined ? { models: opts.models } : {}),
  });
}

describe("F1.3 两级解析单点（SubagentLauncher.resolveModelFor，AD-3 锚 1；T12 砍 spawn 快照级）", () => {
  test("第一级：profile.model 声明即最高优先级——全局兜底不调用", () => {
    const spies: Spies = { globalCalls: 0 };
    const launcher = makeLauncher({
      profile: { ...SubAgentProfile, model: "fake/profile-declared" },
      models: modelsStub,
      spies,
    });
    expect(launcher.resolveModelFor()).toBe(profileModel);
    expect(spies.globalCalls).toBe(0); // 高档有值 → 低档短路
  });

  test("第二级：profile 未声明 → 落全局兜底 getter（不再经过 spawn 会话快照级）", () => {
    const spies: Spies = { globalCalls: 0 };
    const launcher = makeLauncher({ spies });
    expect(launcher.resolveModelFor()).toBe(globalModel);
    expect(spies.globalCalls).toBe(1);
  });

  test("第一级 fail-fast：profile.model 声明但 models 目录未注入 → 中文报错含槽位值", () => {
    const spies: Spies = { globalCalls: 0 };
    const launcher = makeLauncher({
      profile: { ...SubAgentProfile, model: "fake/profile-declared" },
      spies,
    });
    expect(() => launcher.resolveModelFor()).toThrow(/fake\/profile-declared/);
  });
});
