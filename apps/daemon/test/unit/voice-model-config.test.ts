/**
 * VoiceModelConfigStore + voiceModelConfig 纯函数单测（ASR/TTS 模型配置接入 P0）。
 *
 * 断言面：
 * 1. 未设置 → current() 回落 DEFAULT_VOICE_MODEL_CONFIG（= 原硬编码常量，
 *    未配置行为零变化）；
 * 2. set 部分更新合并写 + 重启模拟（新实例同库）仍读到；
 * 3. 空串 = 回落默认值（「恢复默认」协议语义）；
 * 4. 脏数据回落：非法 JSON / 非对象 → 保持最近已知（KvConfigStore 契约）；
 *    对象内缺失/非 string/空串字段 → 逐字段回落默认；
 * 5. applyVoiceModelPatch 纯函数语义（携带项写入/trim/空串回落）；
 * 6. adapter 常量别名钉死（导出名与字面值不变——既有测试引用面不破）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteQueue } from "../../src/adapters/driven/sqlite-session/WriteQueue";
import { RuntimeConfigStore } from "../../src/adapters/driven/sqlite-session/RuntimeConfigStore";
import { VoiceModelConfigStore } from "../../src/adapters/driven/sqlite-session/VoiceModelConfigStore";
import {
  DEFAULT_VOICE_MODEL_CONFIG,
  applyVoiceModelPatch,
  parseVoiceModelConfig,
} from "../../src/application/voice/voiceModelConfig";
import { DASHSCOPE_ASR_MODEL } from "../../src/adapters/driven/stt/dashscope";
import { SILICONFLOW_ASR_MODEL } from "../../src/adapters/driven/stt/siliconflow";
import { DASHSCOPE_ASR_REALTIME_MODEL } from "../../src/adapters/driven/stt/realtime";
import { DASHSCOPE_TTS_MODEL } from "../../src/adapters/driven/tts/dashscope";
import { DASHSCOPE_TTS_STREAM_MODEL } from "../../src/adapters/driven/tts/streaming";

function makeStore(dir: string): VoiceModelConfigStore {
  const wq = new WriteQueue(join(dir, "helix.db"));
  const kv = new RuntimeConfigStore(wq);
  return new VoiceModelConfigStore(kv);
}

async function withTmpDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "voice-model-store-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("VoiceModelConfigStore（KV voice_model_config 单键）", () => {
  test("① 未设置 → current() 回落默认（= 原硬编码常量，行为零变化）", () =>
    withTmpDir((dir) => {
      expect(makeStore(dir).current()).toEqual(DEFAULT_VOICE_MODEL_CONFIG);
    }));

  test("② set 部分更新合并写 + 重启模拟后仍读到", () =>
    withTmpDir(async (dir) => {
      const store = makeStore(dir);
      const next = await store.set({ sttModel: "custom-asr-v2" });
      expect(next.sttModel).toBe("custom-asr-v2");
      expect(next.ttsModel).toBe(DEFAULT_VOICE_MODEL_CONFIG.ttsModel); // 未携带项保留
      expect(store.current().sttModel).toBe("custom-asr-v2");
      expect(makeStore(dir).current().sttModel).toBe("custom-asr-v2"); // 重启模拟
    }));

  test("③ 空串 = 回落默认值（恢复默认协议语义）", () =>
    withTmpDir(async (dir) => {
      const store = makeStore(dir);
      await store.set({ ttsStreamModel: "custom-tts-stream" });
      const next = await store.set({ ttsStreamModel: "" });
      expect(next.ttsStreamModel).toBe(DEFAULT_VOICE_MODEL_CONFIG.ttsStreamModel);
      expect(store.current().ttsStreamModel).toBe(DEFAULT_VOICE_MODEL_CONFIG.ttsStreamModel);
    }));

  test("④ 脏数据回落：非法 JSON 保持最近已知；对象内非法字段逐字段回落默认", () =>
    withTmpDir(async (dir) => {
      const wq = new WriteQueue(join(dir, "helix.db"));
      const kv = new RuntimeConfigStore(wq);
      await kv.set("voice_model_config", "{not-json");
      expect(new VoiceModelConfigStore(kv).current()).toEqual(DEFAULT_VOICE_MODEL_CONFIG);
      await kv.set("voice_model_config", JSON.stringify({ sttModel: 42, ttsModel: "   ", sttRealtimeModel: "rt-v2" }));
      expect(new VoiceModelConfigStore(kv).current()).toEqual({
        ...DEFAULT_VOICE_MODEL_CONFIG,
        sttRealtimeModel: "rt-v2", // 合法字段生效
      });
      // 非对象 JSON 归「不可用」道：同实例保持最近已知（KvConfigStore 契约）
      const live = new VoiceModelConfigStore(kv);
      expect(live.current().sttRealtimeModel).toBe("rt-v2"); // 先读到合法值
      await kv.set("voice_model_config", "[1,2]");
      expect(live.current().sttRealtimeModel).toBe("rt-v2"); // 外部脏写不冲掉最近已知
      expect(new VoiceModelConfigStore(kv).current()).toEqual(DEFAULT_VOICE_MODEL_CONFIG); // 新实例（重启）初值 = 默认
    }));
});

describe("voiceModelConfig 纯函数", () => {
  test("⑤ applyVoiceModelPatch：携带项写入/trim/空串回落默认", () => {
    const current = DEFAULT_VOICE_MODEL_CONFIG;
    const merged = applyVoiceModelPatch(current, { sttModel: "  custom-asr  ", ttsModel: "" });
    expect(merged.sttModel).toBe("custom-asr"); // trim
    expect(merged.ttsModel).toBe(DEFAULT_VOICE_MODEL_CONFIG.ttsModel); // 空串回落
    expect(merged.sttRealtimeModel).toBe(current.sttRealtimeModel); // 未携带项保留
    expect(current.sttModel).toBe(DEFAULT_VOICE_MODEL_CONFIG.sttModel); // 入参不变（纯函数）
  });

  test("parseVoiceModelConfig：undefined / 非法 JSON / 非对象 → undefined（保持最近已知）", () => {
    expect(parseVoiceModelConfig(undefined)).toBeUndefined();
    expect(parseVoiceModelConfig("{bad")).toBeUndefined();
    expect(parseVoiceModelConfig("[]")).toBeUndefined();
    expect(parseVoiceModelConfig('"str"')).toBeUndefined();
  });

  test("⑥ adapter 常量别名钉死（导出名与字面值不变）", () => {
    expect(DASHSCOPE_ASR_MODEL).toBe("qwen-audio-3.0-asr-flash");
    expect(SILICONFLOW_ASR_MODEL).toBe("FunAudioLLM/SenseVoiceSmall");
    expect(DASHSCOPE_ASR_REALTIME_MODEL).toBe("qwen3-asr-flash-realtime");
    expect(DASHSCOPE_TTS_MODEL).toBe("qwen3-tts-flash");
    expect(DASHSCOPE_TTS_STREAM_MODEL).toBe("qwen-audio-3.0-tts-flash");
    expect(DASHSCOPE_ASR_MODEL).toBe(DEFAULT_VOICE_MODEL_CONFIG.sttModel);
    expect(SILICONFLOW_ASR_MODEL).toBe(DEFAULT_VOICE_MODEL_CONFIG.sttSiliconflowModel);
    expect(DASHSCOPE_ASR_REALTIME_MODEL).toBe(DEFAULT_VOICE_MODEL_CONFIG.sttRealtimeModel);
    expect(DASHSCOPE_TTS_MODEL).toBe(DEFAULT_VOICE_MODEL_CONFIG.ttsModel);
    expect(DASHSCOPE_TTS_STREAM_MODEL).toBe(DEFAULT_VOICE_MODEL_CONFIG.ttsStreamModel);
  });
});
