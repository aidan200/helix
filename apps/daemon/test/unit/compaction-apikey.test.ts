import { describe, expect, test } from "bun:test";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { CompactionHook } from "../../src/adapters/driven/pi-engine/runtime/hooks/CompactionHook";
import type { CompactionOutcome } from "../../src/adapters/driven/pi-engine/runtime/hooks/CompactionHook";

/**
 * code-review H5 专项：compaction 摘要调用的显式 apiKey 注入。
 *
 * 缺陷：pi compact() 内部组装 completeSimple options 时无 apiKey 通道
 * （pi-agent-core 0.84.4 签名核实），凭据回落 pi-ai 自身 CredentialStore
 * （helix 从不写入）+ env——与主链路 agent-loop 的 getApiKey 显式解析
 * （AG-08/AD-11/13，不走 env）断链：key 仅录 helix auth.json 时压缩摘要
 * 鉴权失败，压缩永不生效且每次触发 engine_error。
 *
 * 修复语义（三断言面）：
 * ① 注入——getApiKey 命中 provider → completeSimple options.apiKey =
 *   显式 key（per-request provider 解析，与主链路同 hook 面）；
 * ② 透传——未注入 getApiKey → options 原样（apiKey 缺席，现状不变，
 *   测试替身/离线形态零破坏）；
 * ③ fail-fast——getApiKey 抛错（explicitGetApiKey 缺 key 语义）→ 降级
 *   onFailed（文案含 auth.json 指引），摘要调用零发起（重试环外解析，
 *   不进 pi retry 风暴）。
 *
 * 载体：CompactionHook 直驱（bind fake agent——prepareNextTurn 只读
 * state 面）；models 替身捕获 completeSimple options（T3.1 同构精简）。
 */

const fakeModel = {
  id: "fake-model",
  name: "Fake Model",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "http://localhost-unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 8192,
} as unknown as Model<any>;

/** ≈320 tokens（字符启发式口径，T3.1/T5.3 同款）——超过 200 阈值触发 compaction。 */
const LONG_TEXT = "这是一段被刻意拉长的回复正文。".repeat(80);

/** 小阈值 compaction 声明（阈值 = cw 1000 - reserve 800 = 200 tokens）。 */
const SETTINGS = { enabled: true, reserveTokens: 800, keepRecentTokens: 100 };

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    usage: { input: 300, output: 20, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AgentMessage;
}

/** 摘要成功回复（pi-ai 形状；usage 是 CompactionOutcome.usage 源）。 */
function summaryMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake-model",
    usage: {
      input: 40,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 46,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** 捕获 completeSimple options 的替身 Models（Proxy 装饰下的最终落点）。 */
function makeCapturingModels(): { models: Models; calls: { apiKey?: string }[] } {
  const calls: { apiKey?: string }[] = [];
  const models = {
    completeSimple: async (_model: unknown, _context: unknown, options?: { apiKey?: string }) => {
      calls.push(options ?? {});
      return summaryMessage("压缩摘要正文");
    },
  };
  return { models: models as unknown as Models, calls };
}

function fakeAgent(): Agent {
  return {
    state: {
      messages: [userMessage("第一问"), assistantMessage(LONG_TEXT), userMessage("追问收尾")],
      model: fakeModel,
      systemPrompt: "测试系统提示",
      tools: [],
    },
  } as unknown as Agent;
}

describe("code-review H5：compaction 摘要调用显式 apiKey 注入", () => {
  test("① getApiKey 命中 provider → completeSimple options.apiKey = 显式 key（主链路同 hook 面）", async () => {
    const { models, calls } = makeCapturingModels();
    const outcomes: CompactionOutcome[] = [];
    const hook = new CompactionHook({
      settings: SETTINGS,
      models,
      model: fakeModel,
      getApiKey: (provider) => (provider === "anthropic" ? "sk-explicit-h5" : undefined),
      onCompleted: (r) => outcomes.push(r),
      onFailed: () => {},
    });
    hook.bind(fakeAgent());

    const update = await hook.prepareNextTurn(undefined as never, undefined);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.every((o) => o.apiKey === "sk-explicit-h5")).toBe(true);
    expect(outcomes.length).toBe(1); // 注入不影响压缩闭环
    expect(update?.context?.messages).toBeDefined();
  });

  test("② 未注入 getApiKey → options 原样透传（apiKey 缺席，现状零变化）", async () => {
    const { models, calls } = makeCapturingModels();
    const outcomes: CompactionOutcome[] = [];
    const hook = new CompactionHook({
      settings: SETTINGS,
      models,
      model: fakeModel,
      onCompleted: (r) => outcomes.push(r),
      onFailed: () => {},
    });
    hook.bind(fakeAgent());

    await hook.prepareNextTurn(undefined as never, undefined);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.every((o) => o.apiKey === undefined)).toBe(true);
    expect(outcomes.length).toBe(1);
  });

  test("③ getApiKey 抛错（缺 key fail-fast）→ onFailed 降级 + 摘要调用零发起", async () => {
    const { models, calls } = makeCapturingModels();
    const failures: string[] = [];
    const hook = new CompactionHook({
      settings: SETTINGS,
      models,
      model: fakeModel,
      getApiKey: (provider) => {
        throw new Error(`auth.json 中没有 provider "${provider}" 的凭据（api_key 型请经设置页 auth.set_key 录入、订阅型 provider 请订阅登录；显式传入，不走环境变量）`);
      },
      onCompleted: () => {},
      onFailed: (message) => failures.push(message),
    });
    hook.bind(fakeAgent());

    const update = await hook.prepareNextTurn(undefined as never, undefined);

    expect(calls.length).toBe(0); // 重试环外解析：无 pi retry 风暴
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("auth.json"); // fail-fast 文案与主链路同源
    expect(update).toBeUndefined(); // 会话无损（保持现状继续 turn）
  });

  test("④ oauth 分流（订阅登录批）：getApiKey 返回 undefined → options 不带 apiKey（交 pi-ai 注入 store 解析）", async () => {
    const { models, calls } = makeCapturingModels();
    const outcomes: CompactionOutcome[] = [];
    const hook = new CompactionHook({
      settings: SETTINGS,
      models,
      model: fakeModel,
      // oauth 凭据语义：双通道 hook 返回 undefined（不覆盖不抛错）
      getApiKey: () => undefined,
      onCompleted: (r) => outcomes.push(r),
      onFailed: () => {},
    });
    hook.bind(fakeAgent());

    await hook.prepareNextTurn(undefined as never, undefined);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.every((o) => o.apiKey === undefined)).toBe(true); // 不装饰（②同结果，经①代码路径）
    expect(outcomes.length).toBe(1);
  });
});
