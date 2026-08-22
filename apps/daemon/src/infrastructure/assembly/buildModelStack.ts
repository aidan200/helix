import type { Logger } from "../logging";
import type { HelixPaths } from "../paths";
import { AuthStore } from "../auth-store";
import { ModelCatalog } from "../../adapters/driven/pi-engine/model-catalog";

/**
 * 装配函数 ② 模型域（architecture §4.2.1）：组合根的一部分
 * （AG-02④ 豁免面 infrastructure/assembly/**）。成员：auth.json key 源 +
 * 合并目录（ModelCatalog）。ModelService 装配留组合根 driving 段（装配序
 * §4.2.2 步 8：依赖 registry/eventStream，无法早于会话栈）；resolveConfigModel/
 * DEFAULT_MODEL_ID 为共享解析函数（各装配点直接 import）。
 */
export interface ModelStack {
  readonly authStore: AuthStore;
  readonly catalog: ModelCatalog;
}

export function buildModelStack(deps: { readonly paths: HelixPaths; readonly logger: Logger }): ModelStack {
  // ── AD-2 模型模块地基：auth.json / 合并目录 ──────────
  const authStore = new AuthStore(deps.paths.authPath(), deps.logger);
  const catalog = new ModelCatalog({ storePath: deps.paths.modelsStorePath() });
  return { authStore, catalog };
}
