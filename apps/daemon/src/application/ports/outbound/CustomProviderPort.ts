/**
 * 三方平台（自定义 provider）出站端口（outbound，三方平台批）。实现体 =
 * driven/llm/custom-providers.ts（pi-ai createProvider 装配 +
 * MutableModels 活注册；类型镜像不 import driven——port 铁律 AG-01）。
 *
 * 语义：自定义 provider = 用户登记的 OpenAI 兼容端点（id + baseUrl +
 * 模型清单）。登记后进合并目录（模型解析/默认模型/主会话引擎全链路
 * 打通——与内置 provider 同一目录读面）；API key 不在本域（auth.json
 * 经 auth.set_key 录入，AG-08 显式传入纪律不变）。
 */

/** 模型定义缺省：上下文窗口（保守缺省，用户可在清单行覆盖）。 */
export const CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW = 128_000;
/** 模型定义缺省：单次补全最大输出。 */
export const CUSTOM_MODEL_DEFAULT_MAX_TOKENS = 16_384;

/** API 风格（镜像 protocol ProviderApiStyle——port 不 import driven，protocol 契约类型例外；AG-01/AG-13）。 */
export type CustomProviderApiStyle = "openai-completions" | "anthropic-messages";

/**
 * 思考控制方言（镜像 protocol ProviderThinkingFormat——枚举与 pi-ai
 * compat.thinkingFormat 同源；"auto" = 不声明交 pi-ai 探测）。
 * helix 零方言知识：只存储与透传枚举，分支行为全在 pi-ai 流内。
 */
export type CustomProviderThinkingFormat =
  | "auto"
  | "openai"
  | "deepseek"
  | "qwen"
  | "zai"
  | "openrouter"
  | "together"
  | "baseten"
  | "chat-template"
  | "qwen-chat-template"
  | "string-thinking"
  | "ant-ling";

/** 平台模型定义（存储行；数值/能力位缺省在装配期归一）。 */
export interface CustomModelDef {
  /** 模型 id（如 "kimi-k3"——模型字符串为 "{providerId}/{id}"）。 */
  readonly id: string;
  /** 显示名（缺省 = id）。 */
  readonly name?: string;
  /** 上下文窗口 token 数（set 入口必填正整数；旧存储行缺省归一 128000）。 */
  readonly contextWindow?: number;
  /** 单次补全最大输出 token 数（缺省 16384）。 */
  readonly maxTokens?: number;
  /** 是否推理模型（缺省 false）。 */
  readonly reasoning?: boolean;
  /** 输入价格（美元/百万 token；缺省 0 = 未知计费不显示）。 */
  readonly inputPrice?: number;
  /** 输出价格（美元/百万 token；缺省 0 = 未知计费不显示）。 */
  readonly outputPrice?: number;
}

/** 平台定义（存储行；KV custom_providers JSON 数组元素形态）。 */
export interface CustomProviderDef {
  /** 平台 id（用户命名位 = 模型字符串前缀；`[a-z0-9][a-z0-9-]*`）。 */
  readonly id: string;
  /** 显示名（如 "火山方舟 Agent Plan"；缺省 = id）。 */
  readonly name: string;
  /** API 风格（缺省 openai-completions——旧存储行无此字段在解析期归一）。 */
  readonly api?: CustomProviderApiStyle;
  /** 思考控制方言（缺省 auto——旧存储行无此字段在解析期归一；非 auto 装配写 Model.compat.thinkingFormat）。 */
  readonly thinkingFormat?: CustomProviderThinkingFormat;
  /** OpenAI 兼容服务根（http/https）。 */
  readonly baseUrl: string;
  /** 模型清单（至少一条）。 */
  readonly models: readonly CustomModelDef[];
}

/**
 * 活注册表面（daemon 运行期增删自定义 provider 的目录同步面）。
 * 实现体持 MutableModels 引用：register = setProvider（upsert），
 * unregister = deleteProvider——目录读面（modelsView/getModel/
 * providerIds）即时反映，无需重启 daemon。
 */
export interface CustomProviderRegistryPort {
  /** 登记或更新一个自定义 provider（按 id upsert；同步进合并目录）。 */
  register(def: CustomProviderDef): void;
  /** 撤销登记（目录读面即时移除；id 不存在 = 幂等无操作）。 */
  unregister(id: string): void;
  /** 内置 provider id 全集（新增 id 冲突防线）。 */
  builtinProviderIds(): readonly string[];
}
