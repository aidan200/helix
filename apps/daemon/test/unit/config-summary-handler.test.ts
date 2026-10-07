/**
 * 总结配置协议面单测（会话总结器独立化批①；TDD 红绿证据链）。
 *
 * 断言面：
 * 1. config.set_summary（总结配置组独立收口——memory.* 同构形态）：
 *    类型闸（enabled/everyTurns/model/task 逐字段）+ everyTurns 范围闸
 *    （1-20 整数，越界 invalid_payload）+ 部分更新合并写 + 空串/null 清空
 *    槽位 + 回执 config.set_summary.result {state}（所见即所得）；
 * 2. config.get_summary 读面回执 summary 组现态；
 * 3. steward.set_config 摘组后协议拒答：携带 summary / sessionMemory 组 →
 *    command.invalid_payload（含 config.set_summary 改道指引）；enabled/model/
 *    memory 照旧受理；
 * 4. steward.config.result 回显 summary 组（summary.* 生效值只读观测面）。
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
  handleStewardGetConfig,
  handleStewardSetConfig,
} from "../../src/adapters/driving/ws-server/handlers/steward";
import {
  handleConfigGetSummary,
  handleConfigSetSummary,
} from "../../src/adapters/driving/ws-server/handlers/config";
import type { StewardCommandContext, WsCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";
import { SummaryConfigStore } from "../../src/adapters/driven/sqlite-session/SummaryConfigStore";
import {
  SUMMARY_ENABLED_KEY,
  SUMMARY_EVERY_TURNS_KEY,
  SUMMARY_MODEL_KEY,
  SUMMARY_TASK_ENABLED_KEY,
  SUMMARY_TASK_MODEL_KEY,
} from "../../src/application/summary/summaryConfig";

// ── fakes（steward-summary-config.test.ts 同款收窄面） ──────

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

function makeService(config: RuntimeConfigPort): StewardService {
  return new StewardService({
    llm: noopLlm(),
    orchestration: {
      status: () => [],
      send: () => ({ delivered: false, detail: "配置面零写注入" }),
    },
    tasks: { listTasks: () => [] },
    config,
    feedGate: { hasStewardSubscribers: () => false },
    emitFeed: () => {},
    createEngine: createEngineFromPort(noopLlm()),
  });
}

/** steward handler ctx（steward-profile.test.ts 同构：frames/errors 收集面）。 */
function stewardCtxOf(
  service: StewardService,
  payload: Record<string, unknown>,
  type: string = "steward.set_config",
): { ctx: StewardCommandContext; frames: EventEnvelope[]; errors: { code: string; message: string }[] } {
  const frames: EventEnvelope[] = [];
  const errors: { code: string; message: string }[] = [];
  const sender = { id: "conn-1" };
  const ctx = {
    ws: { data: { sender } },
    type,
    payload,
    steward: {
      service,
      stream: {
        subscribeSteward: () => {},
        unsubscribeSteward: () => {},
      },
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

/** config handler ctx（WsCommandContext 收窄面：summaryConfig 真体 + 收集面）。 */
function configCtxOf(
  config: RuntimeConfigPort,
  payload: Record<string, unknown>,
  type: string = "config.set_summary",
): { ctx: WsCommandContext; frames: EventEnvelope[]; errors: { code: string; message: string }[] } {
  const frames: EventEnvelope[] = [];
  const errors: { code: string; message: string }[] = [];
  const sender = { id: "conn-1" };
  const ctx = {
    ws: { data: { sender } },
    type,
    payload,
    summaryConfig: new SummaryConfigStore(config),
    commandError: (_type: string, code: string, message: string) => {
      errors.push({ code, message });
    },
    rawSender: () => sender,
    sendNow: (_s: unknown, frame: EventEnvelope) => {
      frames.push(frame);
    },
  } as unknown as WsCommandContext;
  return { ctx, frames, errors };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

// ── config.get/set_summary（总结配置组独立收口）─────────────

describe("config.set_summary（summary.* 通用域写面）", () => {
  test("① 类型闸 + everyTurns 范围闸：非法载荷 → invalid_payload 不落 KV", async () => {
    for (const [payload, needle] of [
      [{}, "至少携带一项"],
      [{ enabled: "yes" }, "payload.enabled"],
      [{ everyTurns: 0 }, "payload.everyTurns"],
      [{ everyTurns: 21 }, "payload.everyTurns"],
      [{ everyTurns: 2.5 }, "payload.everyTurns"],
      [{ model: "不是模型格式" }, "payload.model"],
      [{ task: "x" }, "payload.task"],
      [{ task: { model: "bad" } }, "payload.task.model"],
    ] as [Record<string, unknown>, string][]) {
      const config = fakeConfig();
      const { ctx, errors } = configCtxOf(config, payload);
      handleConfigSetSummary(ctx);
      await settle();
      expect(errors).toHaveLength(1);
      expect(errors[0]!.code).toBe("command.invalid_payload");
      expect(errors[0]!.message).toContain(needle);
      expect(config.kv.size).toBe(0); // 拒答零写入
    }
  });

  test("② 部分更新合并写 + 回执 state 所见即所得（携带项写入未携带项保留）", async () => {
    const config = fakeConfig({ [SUMMARY_EVERY_TURNS_KEY]: "3" });
    const { ctx, frames, errors } = configCtxOf(config, {
      enabled: true,
      model: "deepseek/summary-flash",
      task: { enabled: true, model: "openai/task-summary" },
    });
    handleConfigSetSummary(ctx);
    await settle();
    expect(errors).toHaveLength(0);
    expect(config.kv.get(SUMMARY_ENABLED_KEY)).toBe("1");
    expect(config.kv.get(SUMMARY_MODEL_KEY)).toBe("deepseek/summary-flash");
    expect(config.kv.get(SUMMARY_TASK_ENABLED_KEY)).toBe("1");
    expect(config.kv.get(SUMMARY_TASK_MODEL_KEY)).toBe("openai/task-summary");
    expect(config.kv.get(SUMMARY_EVERY_TURNS_KEY)).toBe("3"); // 未携带项保留
    expect(frames).toHaveLength(1);
    const frame = frames[0] as { type: string; payload: { state: unknown } };
    expect(frame.type).toBe("config.set_summary.result");
    expect(frame.payload.state).toEqual({
      enabled: true,
      everyTurns: 3,
      model: "deepseek/summary-flash",
      task: { enabled: true, model: "openai/task-summary" },
    });
  });

  test("③ 空串/null 清空槽位回未配置态；everyTurns 合法写入", async () => {
    const config = fakeConfig({
      [SUMMARY_MODEL_KEY]: "deepseek/summary-flash",
      [SUMMARY_TASK_MODEL_KEY]: "openai/task-summary",
    });
    const { ctx } = configCtxOf(config, { everyTurns: 7, model: "", task: { model: null } });
    handleConfigSetSummary(ctx);
    await settle();
    expect(config.kv.get(SUMMARY_EVERY_TURNS_KEY)).toBe("7");
    expect(config.kv.get(SUMMARY_MODEL_KEY)).toBe("");
    expect(config.kv.get(SUMMARY_TASK_MODEL_KEY)).toBe("");
    const { ctx: getCtx, frames } = configCtxOf(config, {}, "config.get_summary");
    handleConfigGetSummary(getCtx);
    expect(frames[0]!.type).toBe("config.get_summary.result");
    expect((frames[0] as { payload: unknown }).payload).toEqual({
      enabled: false,
      everyTurns: 7,
      model: null,
      task: { enabled: false, model: null },
    });
  });
});

// ── steward.set_config 摘组拒答 ────────────────────────────

describe("steward.set_config 摘组（summary/sessionMemory 迁 config.set_summary）", () => {
  test("① 携带 summary / sessionMemory 组 → invalid_payload 拒答（含改道指引），零 KV 写入", async () => {
    for (const [payload, needle] of [
      [{ summary: { enabled: true } }, "payload.summary 组已摘除"],
      [{ sessionMemory: { everyTurns: 5 } }, "payload.sessionMemory 组已摘除"],
    ] as [Record<string, unknown>, string][]) {
      const config = fakeConfig();
      const { ctx, frames, errors } = stewardCtxOf(makeService(config), payload);
      handleStewardSetConfig(ctx);
      await settle();
      expect(frames).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.code).toBe("command.invalid_payload");
      expect(errors[0]!.message).toContain(needle);
      expect(errors[0]!.message).toContain("config.set_summary");
      expect(config.kv.size).toBe(0);
    }
  });

  test("② enabled/model/memory 照旧受理；config.result 回执 summary 组回显 summary.* 生效值", async () => {
    const config = fakeConfig({ [SUMMARY_ENABLED_KEY]: "1", [SUMMARY_EVERY_TURNS_KEY]: "5" });
    const svc = makeService(config);
    const { ctx, frames, errors } = stewardCtxOf(svc, { enabled: true, model: "zai/glm-5.3" });
    handleStewardSetConfig(ctx);
    await settle();
    expect(errors).toHaveLength(0);
    expect(config.kv.get("steward.enabled")).toBe("1");
    expect(config.kv.get("steward.model")).toBe("zai/glm-5.3");
    expect(frames).toHaveLength(1);
    const payload = (frames[0] as { payload: { summary: unknown } }).payload;
    expect(payload.summary).toEqual({
      enabled: true,
      everyTurns: 5,
      model: null,
      task: { enabled: false, model: null },
    });

    // get_config 同形回显
    const get = stewardCtxOf(svc, {}, "steward.get_config");
    handleStewardGetConfig(get.ctx);
    expect(get.frames[0]!.type).toBe("steward.config.result");
  });
});
