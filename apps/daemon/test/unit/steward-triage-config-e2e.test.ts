/**
 * 管家分诊判官配置组写路径端到端单测（管家分诊判官接入批）。
 *
 * 断言面（UI → steward.set_config 协议 triage 组 → steward.triage.* KV →
 * steward.config.result 回执 triage 组回显——真实 StewardService + 真实
 * TriageJudgeFace，仅出站依赖 fake）：
 * 1. 两键写入：payload.triage {judgeEnabled, judgeEndpointId} → KV 落值 +
 *    回执 triage 组携带生效值（引用态——端点删除视为未配）；
 * 2. 类型闸：judgeEnabled 非布尔 / judgeEndpointId 非字符串 → invalid_payload
 *    拒答零写入；
 * 3. 缺省回显：未配置 → triage {judgeEnabled:false, judgeEndpoint:null}；
 * 4. 端点悬空：judgeEndpointId 指向已删条目 → 回执 judgeEndpoint null（UI
 *    显示「未选择」数据源）。
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
import { StewardService } from "../../src/application/steward/StewardService";
import {
  makeTriageJudgeFace,
  STEWARD_TRIAGE_JUDGE_ENABLED_KEY,
  STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY,
} from "../../src/application/steward/StewardTriageJudge";
import { handleStewardSetConfig } from "../../src/adapters/driving/ws-server/handlers/steward";
import type { StewardCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";

function noopLlm(): StewardLlmPort {
  return {
    modelId: "deepseek/deepseek-v4-flash",
    async complete(_request: StewardLlmRequest): Promise<StewardLlmResponse> {
      throw new Error("配置面零 LLM 调用");
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

/** embedding 配置域查询面 fake：ep-cls（classifier 真体）/ep-gone（已删）。 */
function fakeLookup() {
  const records = new Map<string, { id: string; name: string; baseUrl: string; model: string; kind?: "embedding" | "classifier" }>();
  records.set("ep-cls", { id: "ep-cls", name: "Jev", baseUrl: "https://jev.example", model: "jev-latest", kind: "classifier" });
  return {
    records,
    resolveRecord: (id: string) => records.get(id) ?? null,
    resolveDefaultClassifierRecord: () => null,
  };
}

function makeService(config: RuntimeConfigPort, lookup = fakeLookup()): StewardService {
  return new StewardService({
    llm: noopLlm(),
    orchestration: { status: () => [], send: () => ({ delivered: false, detail: "配置面零写注入" }) },
    tasks: { listTasks: () => [] },
    config,
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => {},
    createEngine: createEngineFromPort(noopLlm()),
    triageJudge: makeTriageJudgeFace({
      config,
      embeddingConfig: lookup,
      judge: { noul: async () => 0.5 },
    }),
  });
}

function stewardCtxOf(
  service: StewardService,
  payload: Record<string, unknown>,
): { ctx: StewardCommandContext; frames: EventEnvelope[]; errors: { code: string; message: string }[] } {
  const frames: EventEnvelope[] = [];
  const errors: { code: string; message: string }[] = [];
  const sender = { id: "conn-1" };
  const ctx = {
    ws: { data: { sender } },
    type: "steward.set_config",
    payload,
    steward: {
      service,
      stream: { subscribeSteward: () => {}, unsubscribeSteward: () => {} },
    },
    commandError: (_type: string, code: string, message: string) => {
      errors.push({ code, message });
    },
    rawSender: () => sender,
    sendNow: (_s: unknown, frame: EventEnvelope) => {
      frames.push(frame);
    },
  } as unknown as StewardCommandContext;
  return { ctx, frames, errors };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("分诊判官配置组写路径端到端（steward.set_config triage 组 → steward.triage.* 回显）", () => {
  test("① 两键写入：payload.triage → KV 落值 + 回执 triage 组引用态回显", async () => {
    const config = fakeConfig();
    const { ctx, frames, errors } = stewardCtxOf(makeService(config), {
      triage: { judgeEnabled: true, judgeEndpointId: "ep-cls" },
    });
    handleStewardSetConfig(ctx);
    await settle();
    expect(errors).toHaveLength(0);
    expect(config.kv.get(STEWARD_TRIAGE_JUDGE_ENABLED_KEY)).toBe("1");
    expect(config.kv.get(STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY)).toBe("ep-cls");
    expect(frames).toHaveLength(1);
    const frame = frames[0] as {
      type: string;
      payload: { triage: { judgeEnabled: boolean; judgeEndpoint: { id: string; name: string; model: string; hasApiKey: boolean } | null } };
    };
    expect(frame.type).toBe("steward.config.result");
    expect(frame.payload.triage.judgeEnabled).toBe(true);
    expect(frame.payload.triage.judgeEndpoint).toEqual({ id: "ep-cls", name: "Jev", model: "jev-latest", hasApiKey: false });
  });

  test("② 类型闸：judgeEnabled 非布尔 / judgeEndpointId 非字符串 → invalid_payload 拒答零写入", async () => {
    for (const [payload, needle] of [
      [{ triage: { judgeEnabled: "yes" } }, "triage.judgeEnabled"],
      [{ triage: { judgeEndpointId: 42 } }, "triage.judgeEndpointId"],
    ] as [Record<string, unknown>, string][]) {
      const config = fakeConfig();
      const { ctx, frames, errors } = stewardCtxOf(makeService(config), payload);
      handleStewardSetConfig(ctx);
      await settle();
      expect(errors).toHaveLength(1);
      expect(errors[0]!.code).toBe("command.invalid_payload");
      expect(errors[0]!.message).toContain(needle);
      expect(config.kv.size).toBe(0);
      expect(frames).toHaveLength(0);
    }
  });

  test("③ 缺省回显：未配置 → triage {judgeEnabled:false, judgeEndpoint:null}", async () => {
    const config = fakeConfig();
    const { ctx, frames } = stewardCtxOf(makeService(config), { enabled: false });
    handleStewardSetConfig(ctx);
    await settle();
    const frame = frames[0] as { payload: { triage: { judgeEnabled: boolean; judgeEndpoint: unknown } } };
    expect(frame.payload.triage).toEqual({ judgeEnabled: false, judgeEndpoint: null });
  });

  test("④ 端点悬空：judgeEndpointId 指向已删条目 → 回执 judgeEndpoint null（读面视为未配）", async () => {
    const config = fakeConfig({
      [STEWARD_TRIAGE_JUDGE_ENABLED_KEY]: "1",
      [STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY]: "ep-gone",
    });
    const { ctx, frames } = stewardCtxOf(makeService(config), { enabled: true });
    handleStewardSetConfig(ctx);
    await settle();
    const frame = frames[0] as { payload: { triage: { judgeEnabled: boolean; judgeEndpoint: unknown } } };
    expect(frame.payload.triage.judgeEnabled).toBe(true);
    expect(frame.payload.triage.judgeEndpoint).toBeNull(); // 悬空 = 未配（UI「未选择」数据源）
  });

  test("⑤ 空串 judgeEndpointId = 清除引用（显式解绑回未配态）", async () => {
    const config = fakeConfig({
      [STEWARD_TRIAGE_JUDGE_ENABLED_KEY]: "1",
      [STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY]: "ep-cls",
    });
    const { ctx, frames, errors } = stewardCtxOf(makeService(config), {
      triage: { judgeEndpointId: "" },
    });
    handleStewardSetConfig(ctx);
    await settle();
    expect(errors).toHaveLength(0);
    expect(config.kv.get(STEWARD_TRIAGE_JUDGE_ENDPOINT_ID_KEY)).toBe("");
    const frame = frames[0] as { payload: { triage: { judgeEndpoint: unknown } } };
    expect(frame.payload.triage.judgeEndpoint).toBeNull();
  });
});
