import type { Logger } from "../logging";
import type { HelixPaths } from "../paths";
import type { RuntimeConfigPort } from "../../application/ports/outbound/RuntimeConfigPort";
import { AuthStore } from "../auth-store";
import { ModelCatalog } from "../../adapters/driven/llm";
import {
  CustomProviderRegistry,
  createModelsBase,
  registerCustomProviders,
} from "../../adapters/driven/llm";
import { parseCustomProviders, CUSTOM_PROVIDERS_KEY } from "../../application/services/CustomProviderService";

/**
 * 装配函数 ② 模型域（architecture §4.2.1）：组合根的一部分
 * （AG-02④ 豁免面 infrastructure/assembly/**）。成员：auth.json key 源 +
 * 合并目录（ModelCatalog）+ 三方平台活注册表（三方平台批）。ModelService
 * 装配留组合根 driving 段（装配序 §4.2.2 步 8：依赖 registry/eventStream，
 * 无法早于会话栈）；resolveConfigModel/DEFAULT_MODEL_ID 为共享解析函数
 * （各装配点直接 import）。
 *
 * 装配序（三方平台批）：MutableModels 底座（driven createModelsBase——
 * AG-04：pi-ai import 不出 driven 域）→ ModelCatalog 构造
 * （providerIdList 快照定格 = pi.dev 刷新域只含 builtin）→ 自定义 provider
 * 登记（KV custom_providers 启动回读；目录读面 mergedModels/providerIds
 * 动态读 base 即时可见）。
 */
export interface ModelStack {
  readonly authStore: AuthStore;
  readonly catalog: ModelCatalog;
  /** 三方平台活注册表（CustomProviderService 经组合根注入消费）。 */
  readonly customProviderRegistry: CustomProviderRegistry;
}

export function buildModelStack(deps: {
  readonly paths: HelixPaths;
  readonly logger: Logger;
  readonly config?: RuntimeConfigPort;
}): ModelStack {
  // ── AD-2 模型模块地基：auth.json / 合并目录 ──────────
  const authStore = new AuthStore(deps.paths.authPath(), deps.logger);
  const models = createModelsBase();
  const catalog = new ModelCatalog({ storePath: deps.paths.modelsStorePath(), models });
  // 三方平台启动登记（catalog 构造后——刷新域快照定格 builtin；读面动态）
  const customProviderRegistry = new CustomProviderRegistry(models);
  if (deps.config !== undefined) {
    registerCustomProviders(models, parseCustomProviders(deps.config.get(CUSTOM_PROVIDERS_KEY)));
  }
  return { authStore, catalog, customProviderRegistry };
}
