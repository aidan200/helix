import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/**
 * pi-ai 工厂接入（architecture.md §8.3 import 红线的唯一执行点之一）。
 *
 * 接入纪律（AD-11 / AD-13）：
 * - provider **必须**经 `pi-ai/providers/all` 子路径——主入口
 *   side-effect-free，走主入口拿不到 provider 实现；
 * - apiKey **显式传**入 getApiKey 钩子（agent-loop 内部把它作为
 *   options.apiKey 传给 streamSimple）——与环境变量彻底无缘（AG-08）；
 * key 数据源改 auth.json（AD-2：组合根传 getter——换 key 后
 *   下一请求即生效，无需重建引擎）；
 * - 本文件不读文件、不看 env：参数全部由调用方（组合根）显式传入，
 * 依赖注入面即测试断言面（spy 可断言）。
 */

/**
 * builtin 默认模型（AD-2：config 瘦身后 model 位迁 SQLite 默认表，
 * 未设置时的 builtin 兜底；config.json 模板示例同源）。
 */
export const DEFAULT_MODEL_ID = "anthropic/claude-sonnet-4-5";

/** 构建全部静态 provider 目录（builtinModels，providers/all）。 */
export function buildModels(): Models {
  return builtinModels();
}

/** "provider/model-id" → Model（不在目录中即启动期错误，fail-fast）。 */
export function resolveModel(models: Models, modelStr: string): Model<any> {
  const slash = modelStr.indexOf("/");
  if (slash <= 0) {
    throw new Error(`模型字符串 "${modelStr}" 缺少 provider 前缀，应为 "provider/model-id" 形式（config.json 的 model 字段）`);
  }
  const provider = modelStr.slice(0, slash);
  const id = modelStr.slice(slash + 1);
  const model = models.getModel(provider, id);
  if (!model) {
    const known = models.getModels(provider).map((m) => m.id).join(", ") || "(无静态模型)";
    throw new Error(`模型 ${modelStr} 不在 pi-ai 静态目录中。provider=${provider} 已知模型：${known}`);
  }
  return model;
}

/**
 * 默认模型解析收束单点（单点红线）：model 字符串（SQLite
 * 默认模型 / builtin 兜底）在此一次解析为完整 Model 对象，此后全链路
 * （主引擎/SubAgent 子进程）只拿对象透传，不散落读字符串/按 id 重建。
 * 缺失/为空 → 中文 fail-fast。
 * 目录缺省 builtinModels()；测试注入受控 fake catalog。
 */
export function resolveConfigModel(modelStr: string | undefined, models?: Models): Model<any> {
  if (modelStr === undefined || modelStr.trim() === "") {
    throw new Error(
      `全局兜底模型未配置：请经 model.set_default 写入 "provider/model-id"` +
        `（模型解析收束单点 fail-fast，F-14）。`,
    );
  }
  return resolveModel(models ?? buildModels(), modelStr);
}

/**
 * 模型槽位解析（AD-6）：profile 未声明 → 继承 base 完整对象
 * （同引用透传，非按 id 重建——base 可来自目录之外，重建会失败）；
 * 声明 "provider/model-id" → registry 解析（失败 fail-fast 含 id）。
 */
export function resolveModelSlot(
  slot: string | undefined,
  base: Model<any>,
  models: Models,
): Model<any> {
  if (slot === undefined) return base;
  return resolveModel(models, slot);
}

/** 流式补全函数工厂（Models.streamSimple 满足 Agent 的 StreamFn 契约）。 */
export function createStreamFn(models: Models): StreamFn {
  return (model, context, options) => models.streamSimple(model, context, options);
}

/**
 * 显式 key 查询钩子：返回值在 agent-loop 内被放进 stream options 的
 * apiKey 字段（每请求按当前模型 provider 取 key——换 provider 后 key
 * 自动跟随）。数据源改 auth.json（AD-2）——组合根传入 getter
 * （或静态表），缺 key 即抛错（fail-fast，指明 auth.set_key 录入路径）。
 */
export function explicitGetApiKey(
  getApiKeys: Record<string, string> | (() => Record<string, string>),
): (provider: string) => string | undefined {
  return (provider: string): string | undefined => {
    const apiKeys = typeof getApiKeys === "function" ? getApiKeys() : getApiKeys;
    const key = apiKeys[provider];
    if (!key) {
      throw new Error(
        `auth.json 中没有 provider "${provider}" 的 API key（请经设置页 auth.set_key 录入；显式传入，不走环境变量）`,
      );
    }
    return key;
  };
}
