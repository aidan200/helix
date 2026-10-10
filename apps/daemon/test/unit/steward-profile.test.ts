/**
 * 管家公民权批：agent.steward_profile.get 只读档案读面单测（TDD 红绿链）。
 *
 * 断言面（任务 brief 测试要求逐条）：
 * 1. StewardService.getProfile 返回面：
 *    - systemPrompt 非空 = STEWARD_SYSTEM_PROMPT 单源（静态人格段）；
 *    - 十七工具全名（十六 LLM 可见 + steward_confirm 面板原语——注册面全集），
 *      每行 description 非空；
 *    - model 透传：KV steward.model 已设 = 槽位值；未设 = null（非 undefined
 *      ——JSON 序列化面钉死 null）；
 *    - kindLabel 恒 "steward"；
 * 2. 脱敏红线：回执序列化面不得含 API key 类字段（apiKey/api_key/token/
 *    secret/password）——纯导出面只含 prompt/工具签名/模型槽位；
 * 3. handler 层：handleAgentStewardProfileGet → 点对点
 *    agent.steward_profile.get.result 帧（channel "agent"、sessionId
 *    __system__、payload 四字段透传）。
 */
import { describe, expect, test } from "bun:test";
import { createEngineFromPort } from "../helpers/steward/portScriptEngine";
import type {
  StewardLlmPort,
  StewardLlmRequest,
  StewardLlmResponse,
} from "../../src/application/ports/outbound/StewardLlmPort";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { EventEnvelope } from "@helix/protocol";
import {
  StewardService,
  STEWARD_SYSTEM_PROMPT,
} from "../../src/application/steward/StewardService";
import { handleAgentStewardProfileGet } from "../../src/adapters/driving/ws-server/handlers/steward";
import type { StewardCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";

// ── fakes（steward-service.test.ts 同款收窄面） ──────────────

function noopLlm(): StewardLlmPort {
  return {
    modelId: "deepseek/deepseek-v4-flash",
    async complete(_request: StewardLlmRequest): Promise<StewardLlmResponse> {
      throw new Error("档案读面零 LLM 调用");
    },
  };
}

function fakeConfig(initial: Record<string, string> = {}): RuntimeConfigPort & { kv: Map<string, string> } {
  const kv = new Map(Object.entries(initial));
  return {
    kv,
    get: (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  };
}

function makeService(config: RuntimeConfigPort): StewardService {
  return new StewardService({
    llm: noopLlm(),
    orchestration: {
      status: () => [],
      send: () => ({ delivered: false, detail: "档案读面零写注入" }),
    },
    tasks: { listTasks: () => [] },
    config,
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => {},
  createEngine: createEngineFromPort(noopLlm())});
}

/** 管家注册面十八工具全集（注册序——十七 LLM 可见 + steward_confirm 面板原语；
 *  管家记忆 B1 增 remember；start_session 批增带话题开局双工具分工；progress
 *  批 M3 增 read_session 尾部深读；M2 表面批增四泛型工具
 *  surface_list/snapshot/read/act——D4 能力协商不加工具膨胀；批A 增 kg_search/
 *  kg_get 项目知识只读检索二件（只读零写）；记忆批（同轨换轨）增 memory_search
 *  ——机械召回注入退役，管家记忆消费工具化（SOP 纪律驱动）。 */
const STEWARD_TOOL_NAMES = [
  "list_instances",
  "list_tasks",
  "query_recent_work",
  "read_session",
  "kg_search",
  "kg_get",
  "propose_send",
  "deliver_to_session",
  "create_session",
  "start_session",
  "spawn_review_task",
  "remember",
  "memory_search",
  "surface_list",
  "snapshot",
  "read",
  "act",
  "steward_confirm",
] as const;

describe("StewardService.getProfile（管家只读档案导出面）", () => {
  test("systemPrompt 非空 = STEWARD_SYSTEM_PROMPT 单源（静态人格段全文）", () => {
    const svc = makeService(fakeConfig());
    const profile = svc.getProfile();
    expect(profile.systemPrompt.length).toBeGreaterThan(0);
    expect(profile.systemPrompt).toBe(STEWARD_SYSTEM_PROMPT);
  });

  // 【显式契约变更·记忆批】「十七工具全名」→「十八工具全名」：注册面新增
  // memory_search（管家记忆消费工具化）。变更点 = 本断言的全名清单（上表）。
  test("十八工具全名（注册面全集——十七 LLM 可见 + steward_confirm）+ 每行描述非空", () => {
    const svc = makeService(fakeConfig());
    const profile = svc.getProfile();
    expect(profile.tools.map((t) => t.name)).toEqual([...STEWARD_TOOL_NAMES]);
    for (const tool of profile.tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
    // 面板原语自述非 LLM 工具（观测透明度：描述即事实）
    const confirm = profile.tools.find((t) => t.name === "steward_confirm")!;
    expect(confirm.description).toContain("非 LLM 工具");
  });

  test("model 透传：KV 已设 = 槽位值；未设 = null（非 undefined）", () => {
    const set = makeService(fakeConfig({ "steward.model": "deepseek/deepseek-v4-flash" }));
    expect(set.getProfile().model).toBe("deepseek/deepseek-v4-flash");
    const unset = makeService(fakeConfig({}));
    const profile = unset.getProfile();
    expect(profile.model).toBeNull();
    // JSON 序列化面字段不丢（null 钉死，非 undefined 挥发）
    expect(JSON.parse(JSON.stringify(profile)).model).toBeNull();
  });

  test("kindLabel 恒 \"steward\"", () => {
    expect(makeService(fakeConfig()).getProfile().kindLabel).toBe("steward");
  });

  test("脱敏红线：序列化面零凭据类字段（apiKey/api_key/token/secret/password）", () => {
    // KV 里埋入凭据类键——证明档案读面不透传无关 KV 面
    const svc = makeService(
      fakeConfig({
        "auth.anthropic.apiKey": "sk-secret-value",
        "steward.model": "deepseek/deepseek-v4-flash",
      }),
    );
    const serialized = JSON.stringify(svc.getProfile());
    expect(serialized).not.toContain("sk-secret-value");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("password");
  });
});

// ── handler 层：点对点回执帧 ────────────────────────────────

function ctxOf(): { ctx: StewardCommandContext; frames: EventEnvelope[]; errors: string[] } {
  const frames: EventEnvelope[] = [];
  const errors: string[] = [];
  const sender = { id: "conn-1" };
  const ctx = {
    ws: { data: { sender } },
    type: "agent.steward_profile.get",
    payload: {},
    steward: {
      service: makeService(fakeConfig({ "steward.model": "deepseek/deepseek-v4-flash" })),
      stream: {
        subscribeSteward: () => {},
        unsubscribeSteward: () => {},
      },
    },
    commandError: (_type: string, _code: string, message: string) => {
      errors.push(message);
    },
    rawSender: () => sender,
    sendNow: (_s: unknown, frame: EventEnvelope) => {
      frames.push(frame);
    },
  } as unknown as StewardCommandContext;
  return { ctx, frames, errors };
}

describe("handleAgentStewardProfileGet（ws handler 转发面）", () => {
  test("点对点 agent.steward_profile.get.result：channel=agent / sessionId=__system__ / payload 四字段", () => {
    const { ctx, frames, errors } = ctxOf();
    handleAgentStewardProfileGet(ctx);
    expect(errors).toHaveLength(0);
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.type).toBe("agent.steward_profile.get.result");
    expect(frame.channel).toBe("agent");
    expect(frame.sessionId).toBe("__system__");
    const payload = frame.payload as {
      systemPrompt: string;
      tools: { name: string; description: string }[];
      model: string | null;
      kindLabel: string;
    };
    expect(payload.kindLabel).toBe("steward");
    expect(payload.model).toBe("deepseek/deepseek-v4-flash");
    expect(payload.systemPrompt).toBe(STEWARD_SYSTEM_PROMPT);
    expect(payload.tools.map((t) => t.name)).toEqual([...STEWARD_TOOL_NAMES]);
  });
});
