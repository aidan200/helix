import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { PiAgentEngineAdapter } from "../../src/adapters/driven/pi-engine/PiAgentEngineAdapter";
import type { AgentProfile } from "../../src/adapters/driven/pi-engine/runtime/AgentProfile";
import { MinimalHooks } from "../../src/adapters/driven/pi-engine/runtime/hooks/MinimalHooks";

/**
 * TP-1.5e②（T1.5，D12-4）：setTools 守卫收敛为公共私有 helper
 * （requireResolveTools）——收敛守卫模板而非行为统一（brief 决策消解：
 * setModel 静态兑底 / setSystemPrompt 直通语义保持，三方法对外行为零变化）。
 *
 * - 结构断言（先红：抽公共守卫前无统一面）：PiAgentEngineAdapter 存在私有
 *   守卫 `requireResolveTools`，且 setTools 判别经其守卫；
 * - 行为断言：未注入 resolveTools 的 adapter setTools 抛同款消息模板
 *   （fail-fast 不静默）；setModel 缺省兑底（静态目录解析，无守卫）与
 *   setSystemPrompt 纯直通（零注入依赖）不受收敛影响。
 */

const srcRoot = path.join(import.meta.dir, "..", "..", "src");

const fakeModel = {
  id: "fake-model",
  name: "Fake Model",
  api: "anthropic-messages" as const,
  provider: "anthropic",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8192,
} as unknown as Model<any>;

const TestProfile: AgentProfile = {
  kind: "test-tools-guard",
  systemPrompt: "初始系统提示",
  tools: [],
  lifecycle: { mode: "single-shot" },
  hooks: [new MinimalHooks()],
};

/** 未注入 resolveTools/resolveModelById 的 adapter（纯测试形态——守卫触发面）。 */
function makeBareAdapter(): PiAgentEngineAdapter {
  return new PiAgentEngineAdapter({
    profile: TestProfile,
    model: fakeModel,
    apiKeys: { anthropic: "sk-test" },
  });
}

describe("TP-1.5e②：setTools 守卫收敛（D12-4）", () => {
  test("结构：私有守卫 requireResolveTools 存在且 setTools 经其守卫", () => {
    const src = readFileSync(
      path.join(srcRoot, "adapters", "driven", "pi-engine", "PiAgentEngineAdapter.ts"),
      "utf8",
    );
    expect(src).toMatch(/private requireResolveTools\(/);
    const setToolsBody = src.slice(src.indexOf("setTools(names"), src.indexOf("setSystemPrompt("));
    expect(setToolsBody, "setTools 应经 this.requireResolveTools 守卫").toContain("this.requireResolveTools(");
  });

  test("行为：未注入 resolveTools → setTools 抛同款消息模板（fail-fast 不静默）", () => {
    const engine = makeBareAdapter();
    expect(() => engine.setTools(["bash", "grep"])).toThrow(
      "引擎未注入 resolveTools 装配面（PiEngineOptions.resolveTools），无法运行期改工具集：bash, grep",
    );
  });

  test("行为：三方法对外行为零变化——setModel 静态兑底可用、setSystemPrompt 直通", () => {
    const engine = makeBareAdapter();
    // setModel：未注入 resolveModelById → 缺省静态目录解析（构造期 L63 兑底，
    // 语义与 setTools 相反——不加守卫；builtin 目录含本 id）
    engine.setModel("anthropic/claude-sonnet-4-5");
    expect(engine.currentModel()).toBe("anthropic/claude-sonnet-4-5");
    // setSystemPrompt：零注入依赖纯直通（不抛）
    engine.setSystemPrompt("直通提示");
  });
});
