/**
 * 三方平台（自定义 provider）事件族（additive；新 Channel 值 "provider"
 * ——扩展纪律：新增族 = additive，不动分发器，embedding 族先例同构口径）。
 *
 * 单帧：provider.list.result = 平台清单回执（provider.list/set/delete
 * 三命令共用——写后即刷新清单）。
 *
 * 凭据卫生：本域不存 apiKey（key 在 auth.json，经 auth.set_key 录入）——
 * 回执行只回 hasApiKey 布尔 + 尾 4 位脱敏 keyMasked，原值永不出库。
 */
import type { EventFrame } from "../envelope";
import type { ProviderApiStyle, ProviderThinkingFormat } from "../commands/provider";

/** 清单行模型视图（provider.set 载荷的存储回读形态——归一后恒有 name；价格归一后恒有值，0 = 未知计费）。 */
export interface ProviderModelView {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** 输入价格（美元/百万 token；0 = 未知计费）。 */
  inputPrice: number;
  /** 输出价格（美元/百万 token；0 = 未知计费）。 */
  outputPrice: number;
}

/** 平台清单行（凭据卫生：key 状态经 authStore 投影——hasApiKey + 脱敏）。 */
export interface ProviderView {
  /** 平台 id（模型字符串前缀）。 */
  id: string;
  /** 显示名。 */
  name: string;
  /** API 风格（"openai-completions" = OpenAI 兼容；"anthropic-messages" = A 社兼容）。 */
  api: ProviderApiStyle;
  /** 思考控制方言（daemon 归一后恒有值；"auto" = 按 baseUrl 探测）。 */
  thinkingFormat: ProviderThinkingFormat;
  /** 兼容服务根。 */
  baseUrl: string;
  /** 模型清单（daemon 权威现态）。 */
  models: readonly ProviderModelView[];
  /** 是否已录 API key（auth.json）。 */
  hasApiKey: boolean;
  /** key 尾 4 位脱敏（如 "····7f3a"；未录 = 缺席）。 */
  keyMasked?: string;
}

/** provider.list.result payload：三方平台清单（list/set/delete 共用回执形态）。 */
export interface ProviderListResultPayload {
  /** 平台全集（daemon 权威现态）。 */
  providers: readonly ProviderView[];
}

/** provider.list.result：平台清单回执（channel = "provider"；点对点）。 */
export interface ProviderListResultEvent extends EventFrame<ProviderListResultPayload> {
  channel?: "provider";
  type: "provider.list.result";
}
