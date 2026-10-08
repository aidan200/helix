/**
 * config.voice_models 族协议面单测（ASR/TTS 模型配置接入 P0）。
 *
 * 断言面：
 * 1. config.set_voice_models：类型闸（携带字段须 string）+ 至少携带一项 +
 *    部分更新合并写 + 空串回落默认 + 回执 {state}（所见即所得含默认填充）；
 * 2. config.get_voice_models：全量生效态回执；
 * 3. 未装配 → command.unimplemented。
 * config-summary-handler.test.ts 同构模板（fakeConfig 收窄面 + 收集面 ctx）。
 */
import { describe, expect, test } from "bun:test";
import type { EventEnvelope } from "@helix/protocol";
import type { RuntimeConfigPort } from "../../src/application/ports/outbound/RuntimeConfigPort";
import type { WsCommandContext } from "../../src/adapters/driving/ws-server/handlers/context";
import {
  handleConfigGetVoiceModels,
  handleConfigSetVoiceModels,
} from "../../src/adapters/driving/ws-server/handlers/config";
import { VoiceModelConfigStore } from "../../src/adapters/driven/sqlite-session/VoiceModelConfigStore";
import { DEFAULT_VOICE_MODEL_CONFIG } from "../../src/application/voice/voiceModelConfig";

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

/** config handler ctx（WsCommandContext 收窄面：voiceModelConfig 真体 + 收集面）。 */
function configCtxOf(
  config: RuntimeConfigPort | undefined,
  payload: Record<string, unknown>,
  type: string,
): { ctx: WsCommandContext; frames: EventEnvelope[]; errors: { code: string; message: string }[] } {
  const frames: EventEnvelope[] = [];
  const errors: { code: string; message: string }[] = [];
  const sender = { id: "conn-1" };
  const ctx = {
    ws: { data: { sender } },
    type,
    payload,
    ...(config !== undefined ? { voiceModelConfig: new VoiceModelConfigStore(config) } : {}),
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

describe("config.set_voice_models（voice_model_config 写面）", () => {
  test("① 类型闸 + 至少携带一项：非法载荷 → invalid_payload 不落 KV", async () => {
    for (const [payload, needle] of [
      [{}, "至少携带一项"],
      [{ sttModel: 42 }, "payload.sttModel"],
      [{ ttsModel: true }, "payload.ttsModel"],
      [{ sttRealtimeModel: {} }, "payload.sttRealtimeModel"],
      [{ sttSiliconflowModel: null }, "payload.sttSiliconflowModel"],
      [{ ttsStreamModel: [] }, "payload.ttsStreamModel"],
    ] as const) {
      const config = fakeConfig();
      const { ctx, frames, errors } = configCtxOf(config, payload as Record<string, unknown>, "config.set_voice_models");
      handleConfigSetVoiceModels(ctx);
      await settle();
      expect(frames.length).toBe(0);
      expect(errors.length).toBe(1);
      expect(errors[0]!.code).toBe("command.invalid_payload");
      expect(errors[0]!.message).toContain(needle);
      expect(config.kv.size).toBe(0); // 非法载荷零落盘
    }
  });

  test("② 部分更新合并写 + 空串回落默认 + {state} 回执（所见即所得）", async () => {
    const config = fakeConfig();
    const { ctx, frames, errors } = configCtxOf(config, { sttModel: "custom-asr-v2" }, "config.set_voice_models");
    handleConfigSetVoiceModels(ctx);
    await settle();
    expect(errors.length).toBe(0);
    expect(frames.length).toBe(1);
    const payload = (frames[0] as { type: string; payload: { state: typeof DEFAULT_VOICE_MODEL_CONFIG } }).payload;
    expect(frames[0]!.type).toBe("config.set_voice_models.result");
    expect(payload.state.sttModel).toBe("custom-asr-v2");
    expect(payload.state.ttsModel).toBe(DEFAULT_VOICE_MODEL_CONFIG.ttsModel); // 默认值填充

    // 空串 = 回落默认
    const second = configCtxOf(config, { sttModel: "" }, "config.set_voice_models");
    handleConfigSetVoiceModels(second.ctx);
    await settle();
    const state2 = (second.frames[0] as { payload: { state: typeof DEFAULT_VOICE_MODEL_CONFIG } }).payload.state;
    expect(state2.sttModel).toBe(DEFAULT_VOICE_MODEL_CONFIG.sttModel);
  });
});

describe("config.get_voice_models（voice_model_config 读面）", () => {
  test("③ 全量生效态回执（含默认值填充）", () => {
    const config = fakeConfig();
    const { ctx, frames } = configCtxOf(config, {}, "config.get_voice_models");
    handleConfigGetVoiceModels(ctx);
    expect(frames.length).toBe(1);
    expect(frames[0]!.type).toBe("config.get_voice_models.result");
    expect((frames[0] as { payload: unknown }).payload).toEqual(DEFAULT_VOICE_MODEL_CONFIG);
  });

  test("④ 未装配 → command.unimplemented", () => {
    for (const [fn, type] of [
      [handleConfigGetVoiceModels, "config.get_voice_models"],
      [handleConfigSetVoiceModels, "config.set_voice_models"],
    ] as const) {
      const { ctx, frames, errors } = configCtxOf(undefined, { sttModel: "x" }, type);
      fn(ctx);
      expect(frames.length).toBe(0);
      expect(errors.length).toBe(1);
      expect(errors[0]!.code).toBe("command.unimplemented");
    }
  });
});
