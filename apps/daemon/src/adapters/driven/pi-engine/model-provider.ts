import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/**
 * pi-ai 工厂接入（architecture.md §8.3 import 红线的唯一执行点之一）。
 *
 * 接入纪律（F-7 / AD-11 / AD-13，spike 坑 2）：
 * - provider **必须**经 `pi-ai/providers/all` 子路径——主入口
 *   side-effect-free，走主入口拿不到 provider 实现；
 * - model/apiKeys 只来自 `<home>/config.json`，apiKey **显式传**入
 *   getApiKey 钩子（agent-loop 内部把它作为 options.apiKey 传给
 *   streamSimple）——与环境变量彻底无缘（AG-08）；
 * - 本文件不读文件、不看 env：参数全部由调用方（组合根）显式传入，
 *   依赖注入面即测试断言面（TP-CL4-7 spy 可断言）。
 */

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

/** 流式补全函数工厂（Models.streamSimple 满足 Agent 的 StreamFn 契约）。 */
export function createStreamFn(models: Models): StreamFn {
  return (model, context, options) => models.streamSimple(model, context, options);
}

/**
 * 显式 key 查询钩子：返回值在 agent-loop 内被放进 stream options 的
 * apiKey 字段。缺 key 即抛错（fail-fast，指明 config.json apiKeys 字段）。
 */
export function explicitGetApiKey(
  apiKeys: Record<string, string>,
): (provider: string) => string | undefined {
  return (provider: string): string | undefined => {
    const key = apiKeys[provider];
    if (!key) {
      throw new Error(`config.json 的 apiKeys 中没有 provider "${provider}" 的 key（显式传入，不走环境变量）`);
    }
    return key;
  };
}
