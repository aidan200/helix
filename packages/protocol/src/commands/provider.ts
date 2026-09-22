/**
 * 三方平台（自定义 provider）命令族（additive；形态参考 embedding.ts
 * 域文件先例——独立配置域，模型页「三方平台」tab 消费）。
 *
 * 链路：设置页模型分区「三方平台」tab → provider.list/set/delete →
 * daemon CustomProviderService（runtime_config KV custom_providers——
 * [{id,name,baseUrl,models:[...]}]，不含 apiKey——key 走 auth.json 既有
 * auth.set_key 通道，AG-08 显式传入纪律不变）→ provider.list.result
 * 点对点回执（set/delete 共用——写后即刷新清单，与 embedding 族同构）。
 *
 * 语义要点：
 * - provider id 是用户命名位（非 uuid）——它是模型字符串前缀
 *   （"volcengine/kimi-k3"），新增/更新按 id upsert；
 * - 模型解析经 pi-ai createProvider（openai-completions 流）注册进
 *   MutableModels——目录/解析/默认模型/主会话引擎全链路自动打通；
 * - 连通验证复用 auth.verify（自定义 provider 进合并目录后自动放行）；
 *   key 录入复用 auth.set_key——本族刻意不含 key/verify 命令。
 */
import type { CommandFrame } from "../envelope";

/** provider.list：读三方平台清单（点对点回执 provider.list.result）。 */
export interface ProviderListCommand extends CommandFrame<Record<string, never>> {
  type: "provider.list";
}

/** 三方平台 API 风格（缺省 "openai-completions"——旧配置无此字段按其归一）。 */
export type ProviderApiStyle = "openai-completions" | "anthropic-messages";

/**
 * 思考控制方言（思考批；枚举与 pi-ai OpenAICompletionsCompat.thinkingFormat
 * 同源镜像——pi 加新方言时此处同步；"auto" 是 helix 侧特有值 = 不声明，
 * 交 pi-ai detectCompat 按 baseUrl 探测，探测不到时 pi 兜底 "openai"
 * 标准方言 reasoning_effort）。
 *
 * 方言即分支行为的声明位：helix 全链零方言知识（不拼参数），只存储与
 * 透传枚举字符串；分支行为全部封装在 pi-ai 流实现内部（思考批设计定式）。
 */
export type ProviderThinkingFormat =
  | "auto"
  | "openai" /* reasoning_effort */
  | "deepseek" /* thinking:{type} 火山方舟/doubao/kimi/deepseek 系 */
  | "qwen" /* enable_thinking 布尔（阿里 DashScope） */
  | "zai" /* thinking:{type}+clear_thinking（智谱） */
  | "openrouter" /* reasoning:{effort} 嵌套（OpenRouter 聚合层） */
  | "together" /* reasoning:{enabled} 布尔（Together.ai） */
  | "baseten" /* chat_template_args 可配（Baseten） */
  | "chat-template" /* chat_template_kwargs 可配（vLLM 自托管） */
  | "qwen-chat-template" /* chat_template_kwargs.enable_thinking（vLLM qwen） */
  | "string-thinking" /* 顶层 thinking 字符串（minimax 等杂系） */
  | "ant-ling"; /* reasoning:{effort} 仅开档时（蚂蚁灵） */

/** 平台模型定义（provider.set 载荷内嵌；OpenAI 兼容端点的模型清单行）。 */
export interface ProviderModelDefPayload {
  /** 模型 id（如 "kimi-k3"——最终模型字符串为 "{providerId}/{id}"）。 */
  id: string;
  /** 显示名（缺省 = id）。 */
  name?: string;
  /** 上下文窗口 token 数（daemon 校验必填正整数——三方平台批 II 起 UI 必填）。 */
  contextWindow?: number;
  /** 单次补全最大输出 token 数（缺省 16384）。 */
  maxTokens?: number;
  /** 是否推理模型（缺省 false——true 时思考档位面可用）。 */
  reasoning?: boolean;
  /** 输入价格（美元/百万 token；缺省 0 = 未知计费不显示）。 */
  inputPrice?: number;
  /** 输出价格（美元/百万 token；缺省 0 = 未知计费不显示）。 */
  outputPrice?: number;
}

/**
 * provider.set 载荷：新增或更新三方平台（按 id upsert）。id 规则
 * `[a-z0-9][a-z0-9-]*`（≤32 字符，不得与内置 provider 冲突）；baseUrl
 * 为兼容服务根（如 "https://ark.cn-beijing.volces.com/api/plan/v3"）。
 */
export interface ProviderSetPayload {
  /** 平台 id（用户命名位 = 模型字符串前缀）。 */
  id: string;
  /** 显示名（如 "火山方舟 Agent Plan"；缺省 = id）。 */
  name?: string;
  /** API 风格（缺省 "openai-completions"；anthropic-messages = A 社兼容端点）。 */
  api?: ProviderApiStyle;
  /** 思考控制方言（缺省 "auto" = pi-ai 按 baseUrl 探测；选错方言参数会被端点忽略）。 */
  thinkingFormat?: ProviderThinkingFormat;
  /** 兼容服务根（http/https）。 */
  baseUrl: string;
  /** 模型清单（至少一条）。 */
  models: readonly ProviderModelDefPayload[];
}

/** provider.set：新增/更新平台（点对点回执 provider.list.result 新清单）。 */
export interface ProviderSetCommand extends CommandFrame<ProviderSetPayload> {
  type: "provider.set";
}

/** provider.delete 载荷。 */
export interface ProviderDeletePayload {
  /** 目标平台 id。 */
  id: string;
}

/** provider.delete：删除平台（点对点回执 provider.list.result 新清单）。 */
export interface ProviderDeleteCommand extends CommandFrame<ProviderDeletePayload> {
  type: "provider.delete";
}
