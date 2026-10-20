/**
 * voiceModelConfig —— ASR/TTS 模型配置域（模型配置接入 P0）。
 *
 * 定位：5 个语音模型槽位（STT 一次性 ×2 provider / STT 流式 / TTS 一次性 /
 * TTS 流式）的配置语义单源（默认值 + 部分更新合并 + KV 解析），照
 * summaryConfig.ts 单源先例。此前模型 id 全部硬编码在 adapter 常量里，
 * 换模型版本/换模型都得改代码——本域把它们提为运行期配置项。
 *
 * 生效语义：运行期即热——adapter 经 getModel getter 每次调用读现值
 *（getApiKey 同构先例），改配置即热不用重启。
 *
 * 默认纪律：默认值 = 原硬编码常量（行为零变化）；字段写空串 = 回落默认值。
 * adapter 文件的常量导出（DASHSCOPE_ASR_MODEL 等）为 DEFAULT_VOICE_MODEL_CONFIG
 * 字段的 re-export 别名（导出名与字面值不变）。
 */

// 配置值类型单源在端口（依赖方向：端口不 import 服务实现）——此处 re-export
// 保既有消费面 import 路径不变。
import type { VoiceModelConfigPatch, VoiceModelConfigState } from "../ports/outbound/VoiceModelConfigPort";
export type { VoiceModelConfigPatch, VoiceModelConfigState };

/** 5 槽位字段名单（解析/合并遍历单源）——协议面 VOICE_MODEL_FIELDS 同源
 *（载荷字段名契约单源在 @helix/protocol，此处 re-export 保持应用面可用）。 */
export { VOICE_MODEL_FIELDS } from "@helix/protocol";
import { VOICE_MODEL_FIELDS } from "@helix/protocol";

/** 缺省值 = 原硬编码常量（未配置行为零变化；adapter 常量别名的真身）。 */
export const DEFAULT_VOICE_MODEL_CONFIG: VoiceModelConfigState = {
  sttModel: "qwen-audio-3.0-asr-flash",
  sttSiliconflowModel: "FunAudioLLM/SenseVoiceSmall",
  sttRealtimeModel: "qwen3-asr-flash-realtime",
  ttsModel: "qwen3-tts-flash",
  ttsStreamModel: "qwen-audio-3.0-tts-flash",
};

/**
 * 部分更新合并：携带项写入，未携带项保留现值；值 trim 后空串 = 回落默认值
 *（「恢复默认」按钮的协议语义）。纯函数。
 */
export function applyVoiceModelPatch(
  current: VoiceModelConfigState,
  patch: VoiceModelConfigPatch,
): VoiceModelConfigState {
  const next: VoiceModelConfigState = { ...current };
  for (const field of VOICE_MODEL_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    const trimmed = value.trim();
    next[field] = trimmed === "" ? DEFAULT_VOICE_MODEL_CONFIG[field] : trimmed;
  }
  return next;
}

/**
 * KV JSON 原值 → 全量态。KvConfigStore 契约：返回 undefined = 不可用
 *（保持最近已知值）——非法 JSON / 非对象归此道；对象形状下逐字段回落默认
 *（缺失/非 string/空串字段 = 默认值——脏数据回落默认）。
 */
export function parseVoiceModelConfig(raw: string | undefined): VoiceModelConfigState | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const rec = parsed as Record<string, unknown>;
  const out: VoiceModelConfigState = { ...DEFAULT_VOICE_MODEL_CONFIG };
  for (const field of VOICE_MODEL_FIELDS) {
    const value = rec[field];
    if (typeof value === "string" && value.trim() !== "") out[field] = value.trim();
  }
  return out;
}
