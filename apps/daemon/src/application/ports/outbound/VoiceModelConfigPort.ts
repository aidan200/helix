/**
 * 语音模型配置出站端口（outbound，ASR/TTS 模型配置接入 P0）。
 *
 * 职责：5 个语音模型槽位（VoiceModelConfigState）的读写面。实现体 =
 * driven/sqlite-session/VoiceModelConfigStore（RuntimeConfigPort KV 单键
 * JSON `voice_model_config`——CompactionConfigStore 同构形态；语义单源 =
 * application/voice/voiceModelConfig.ts）。
 *
 * 生效语义：运行期即热——adapter getModel getter 每次调用实时读 current()，
 * 设置保存后下一次语音调用即用新模型，无需重启。写面不做前置值校验
 *（与 summaryConfig「读面兜底」哲学一致），协议 handler 只做类型闸。
 */
import type { VoiceModelConfigPatch, VoiceModelConfigState } from "../../voice/voiceModelConfig";

export interface VoiceModelConfigPort {
  /** 当前生效配置（全量态——含默认值填充，所见即所得）。 */
  current(): VoiceModelConfigState;
  /** 部分更新写入（携带项写入，空串 = 回落默认值；单写通道，落盘完成即返回，回读新现态）。 */
  set(patch: VoiceModelConfigPatch): Promise<VoiceModelConfigState>;
}
