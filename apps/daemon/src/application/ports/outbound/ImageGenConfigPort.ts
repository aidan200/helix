/**
 * ImageGenConfigPort —— 生图渠道配置出站端口（多渠道生图批 v1）。
 *
 * KV 单键 `imagegen_config` 全量态 JSON（makeKvConfigStore 骨架，
 * VoiceModelConfigStore 同构）。3 字段：defaultChannel（"" = 自动：
 * 按渠道注册序取首个可用）+ openaiModel/googleModel（"" = 渠道内置默认）。
 *
 * 生效语义：运行期即热——渠道实现经 getter 每次生成读现值，改配置
 * 即热不用重启（voice adapter getModel 同构先例）。
 */

/** 生图配置全量态（字段名与 @helix/protocol ImageGenConfigStatePayload 同形）。 */
export interface ImageGenConfigState {
  /** 缺省生图渠道 id（"" = 自动；枚举 IMAGEGEN_CHANNEL_IDS）。 */
  readonly defaultChannel: string;
  /** openai 渠道默认模型 id（"" = 渠道内置默认 gpt-image-1.5）。 */
  readonly openaiModel: string;
  /** google 渠道默认模型 id（"" = 渠道内置默认 gemini-nano-banana-2.1）。 */
  readonly googleModel: string;
}

/** 部分更新载荷（携带项写入，未携带项保留；空串 = 回落默认/自动）。 */
export interface ImageGenConfigPatch {
  readonly defaultChannel?: string;
  readonly openaiModel?: string;
  readonly googleModel?: string;
}

export interface ImageGenConfigPort {
  /** 当前生效配置（KV 不可用 → 最近已知值；初值 = 全默认）。 */
  current(): ImageGenConfigState;
  /** 部分更新写入（单写通道，落盘完成即返回；回读新现态）。 */
  set(patch: ImageGenConfigPatch): Promise<ImageGenConfigState>;
}
