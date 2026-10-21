import { createProvider } from "@earendil-works/pi-ai";
import type { Api, AuthContext, CredentialStore, Model, MutableModels, Provider } from "@earendil-works/pi-ai";
// pi-ai import 纪律（AD-11）：provider **实现**（builtinModels 等）必须经
// providers/all 子路径；本文件消费的是主入口纯工厂（createProvider）与
// api 流实现的 lazy 包装子路径——均无副作用面，与 model-provider.ts 同域
// （TR-AD-7 三域内合法，AG-04 守护）。
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  CustomProviderApiStyle,
  CustomProviderDef,
  CustomProviderRegistryPort,
} from "../../../application/ports/outbound/CustomProviderPort";

// 缺省常量同源（port 层定义——服务层回执归一与装配层 Model 构造共用）。
import {
  CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
  CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
} from "../../../application/ports/outbound/CustomProviderPort";

/**
 * 三方平台装配（三方平台批）：CustomProviderDef → pi-ai Provider。
 *
 * 装配形态与内置 OpenAI 兼容 provider（deepseek / qwen-token-plan 等）
 * 同构：createProvider({ id, baseUrl, models, api: openAICompletionsApi() })
 * ——openai-completions 流（懒加载），compat 缺省由 pi-ai 按 baseUrl 自动
 * 探测（标准 OpenAI 兼容端点零配置）。
 *
 * apiKey 路径（AG-08）：本域 auth 不做环境变量回退（诚实语义：无
 * 凭据即未配置）；实际 key 全链路由 helix 显式传入 options.apiKey
 * （auth.json → explicitGetApiKey → streamSimple options）。pi-ai 解析序
 * 关键点：options.apiKey 显式传入时 models.ts 把它包装成 credential 调
 * provider 自身 resolve()——resolve 是唯一裁决点（返回 undefined = 未
 * 配置，直接抛 Provider is not configured），因此 resolve 必须把传入
 * credential.key 透传为 AuthResult，与内置 envApiKeyAuth 同构（仅去掉
 * env 回退段）。
 */

/** 模型定义缺省同源 re-export（port 层定义——消费方单一 import 面）。 */
export {
  CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
  CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
} from "../../../application/ports/outbound/CustomProviderPort";

/** 模型行归一（存储缺省 → Model 完整对象；cost 映射用户定价，缺省全 0 = 未知计费不显示）。 */
function toModel(def: CustomProviderDef, api: CustomProviderApiStyle, m: CustomProviderDef["models"][number]): Model<Api> {
  const model = {
    id: m.id,
    name: m.name ?? m.id,
    api,
    provider: def.id,
    baseUrl: def.baseUrl,
    reasoning: m.reasoning ?? false,
    input: ["text"],
    cost: { input: m.inputPrice ?? 0, output: m.outputPrice ?? 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow ?? CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
    maxTokens: m.maxTokens ?? CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
  };
  // 思考方言透传（思考批）：非 auto 时写 Model.compat.thinkingFormat——分支
  // 行为全部封装在 pi-ai 流内（helix 零方言知识，只递枚举字符串）；auto =
  // 不写字段，交 pi-ai detectCompat 按 baseUrl 探测（兜底 openai 标准方言）。
  if (def.thinkingFormat !== undefined && def.thinkingFormat !== "auto") {
    return {
      ...model,
      compat: { thinkingFormat: def.thinkingFormat },
    } as Model<Api>;
  }
  return api === "anthropic-messages" ? (model as Model<"anthropic-messages">) : (model as Model<"openai-completions">);
}

/**
 * 单平台 → Provider（builtin factory 同构：deepseekProvider() 的参数化
 * 形态）。auth resolve 与内置 envApiKeyAuth 同构的 credential 透传段
 * （AG-08 显式 key 纪律——仅去掉环境变量回退：三方平台 key 唯一来源是
 * helix options.apiKey / 凭据库，无 env 通路）。
 */
export function buildCustomProvider(def: CustomProviderDef): Provider {
  const api: CustomProviderApiStyle = def.api ?? "openai-completions";
  return createProvider({
    id: def.id,
    name: def.name,
    baseUrl: def.baseUrl,
    auth: {
      apiKey: {
        name: `${def.name} API key`,
        resolve: async ({ credential, signal }) => {
          signal.throwIfAborted();
          if (credential?.key) {
            return { auth: { apiKey: credential.key }, source: "stored credential" };
          }
          return undefined;
        },
      },
    },
    models: def.models.map((m) => toModel(def, api, m)),
    // 双风格选流（同构 lazy 子路径——anthropic-messages 为 A 社兼容端点）
    api: api === "anthropic-messages" ? anthropicMessagesApi() : openAICompletionsApi(),
  });
}

/**
 * 目录底座构造（装配面唯一入口——AG-04：pi-ai import 不出 driven 域，
 * buildModelStack 经本函数拿底座不直接 import pi-ai）。
 * 返回 MutableModels（builtin 全量注册——自定义 provider 活注册宿主）。
 * options：pi-auth 的凭据注入包（credentials + authContext）——携带后
 * pi-ai 内建凭据解析以 auth.json 为唯一数据源（缺省回落 pi-ai 自有存储
 * 与环境变量，破 AG-08）；生产装配必须携带，测试形态可省。
 */
export function createModelsBase(options?: {
  credentials?: CredentialStore;
  authContext?: AuthContext;
}): MutableModels {
  return builtinModels({
    ...(options?.credentials !== undefined ? { credentials: options.credentials } : {}),
    ...(options?.authContext !== undefined ? { authContext: options.authContext } : {}),
  });
}

/**
 * 活注册表（CustomProviderRegistryPort 实现体）：持 MutableModels 引用，
 * register/unregister 即时同步目录读面（无需重启 daemon）。内置 id 快照
 * 在构造期定格（防与运行期目录循环依赖——builtin 全集启动后不变）。
 */
export class CustomProviderRegistry implements CustomProviderRegistryPort {
  private readonly builtinIds: readonly string[];

  constructor(private readonly models: MutableModels) {
    this.builtinIds = models.getProviders().map((p) => p.id);
  }

  register(def: CustomProviderDef): void {
    this.models.setProvider(buildCustomProvider(def));
  }

  unregister(id: string): void {
    this.models.deleteProvider(id);
  }

  builtinProviderIds(): readonly string[] {
    return this.builtinIds;
  }
}

/** 启动期批量登记（装配序：catalog 构造**后**调用——providerIdList 快照
 * 在构造期定格 = pi.dev 刷新域不含自定义 provider；目录读面
 * mergedModels/providerIds 动态读 base，即时可见）。
 */
export function registerCustomProviders(models: MutableModels, defs: readonly CustomProviderDef[]): void {
  for (const def of defs) {
    models.setProvider(buildCustomProvider(def));
  }
}
