import type {
  ModelInfo,
  ModelPort,
  ModelSetOutcome,
  AuthProviderStatus,
} from "../ports/inbound/ModelPort";
import type {
  ModelCatalogPort,
  CatalogSnapshot,
  AuthVerifyOutcome,
} from "../ports/outbound/ModelCatalogPort";
import type { AuthStorePort } from "../ports/outbound/AuthStorePort";
import type { DefaultModelPort } from "../ports/outbound/DefaultModelPort";
import type { SessionRegistry } from "./SessionRegistry";
import type { ErrorCode } from "@helix/protocol";

/**
 * ModelService —— 模型/认证管理命令族实现（AD-2 daemon 侧主承载，
 * 契约 C §1 全表；TR-AD-2 inbound = 模型与会话管理命令面）。
 *
 * 【职责】
 * - 运行期切换（model.set/get）：per-session——引擎 AgentState.model 直改
 *   （下一 turn 生效，in-flight 不变）；成功即回调 onModelChanged 广播
 *   model.changed（channel=model，订阅该会话的连接）；
 * - 目录与默认值（model.catalog/catalog_refresh/set_default/get_default）：
 *   合并目录（builtin + pi.dev overlay）+ SQLite 全局默认（新会话继承，
 *   既有会话不跟随）；
 * - auth 管理族（auth.list/set_key/delete_key/verify）：auth.json 单写点 +
 *   provider 校验（合并目录全集）+ 连通最小请求（不缓存）。
 *
 * 【错误】ModelNotFoundError / ProviderNotFoundError（校验失败——契约 C §4
 * 语义；driving 层映射回执）；SessionNotFoundError（registry 既有）。
 */

/** model id 不在合并目录（契约 C §4 model_not_found 语义）。 */
export class ModelNotFoundError extends Error {
  /** 错误码（T1.5 additive）：值 = 既有回码，判别契约从 name 字符串改码匹配。 */
  readonly code: ErrorCode = "model_not_found";
  constructor(modelId: string) {
    super(`模型 ${modelId} 不在目录中（应为 "provider/model-id" 且存在于 builtin/overlay 合并目录）`);
    this.name = "ModelNotFoundError";
  }
}

/** providerId 不在目录全集（契约 C §4 provider_not_found 语义）。 */
export class ProviderNotFoundError extends Error {
  /** 错误码（T1.5 additive）：值 = 既有回码，判别契约从 name 字符串改码匹配。 */
  readonly code: ErrorCode = "provider_not_found";
  constructor(providerId: string) {
    super(`provider ${providerId} 不存在（以合并目录 provider 全集为准）`);
    this.name = "ProviderNotFoundError";
  }
}

export interface ModelServiceDeps {
  /** 多会话容器（per-session 引擎寻址；冷会话懒加载）。 */
  readonly registry: SessionRegistry;
  /** 合并目录（builtin + pi.dev overlay）。 */
  readonly catalog: ModelCatalogPort;
  /** auth.json 访问（单写点）。 */
  readonly auth: AuthStorePort;
  /** 全局默认模型存储（SQLite 单写通道）。 */
  readonly defaultModel: DefaultModelPort;
  /** model.changed 广播出海（容器接 EventStream；channel=model）。 */
  readonly onModelChanged: (payload: { sessionId: string; model: string; previous: string; effective: "next-turn" }) => void;
}

export class ModelService implements ModelPort {
  constructor(private readonly deps: ModelServiceDeps) {}

  async setModel(sessionId: string, model: string): Promise<ModelSetOutcome> {
    if (typeof model !== "string" || model.trim() === "" || model.indexOf("/") <= 0) {
      throw new ModelNotFoundError(model);
    }
    if (!this.deps.catalog.hasModel(model)) throw new ModelNotFoundError(model);
    const runtime = await this.deps.registry.get(sessionId); // 不存在 → SessionNotFoundError
    const previous = runtime.chatService.currentModel ?? this.deps.defaultModel.current();
    runtime.chatService.setModel(model); // 引擎 AgentState.model 直改（下一 turn 生效）
    this.deps.onModelChanged({ sessionId, model, previous, effective: "next-turn" });
    return { accepted: true, effective: "next-turn", previous };
  }

  async getModel(sessionId: string): Promise<ModelInfo> {
    const runtime = await this.deps.registry.get(sessionId);
    const defaultModel = this.deps.defaultModel.current();
    const model = runtime.chatService.currentModel ?? defaultModel;
    return { model, isDefault: model === defaultModel, defaultModel };
  }

  async catalog(): Promise<CatalogSnapshot> {
    return this.deps.catalog.catalog();
  }

  async catalogRefresh(): Promise<CatalogSnapshot & { degraded: readonly string[] }> {
    return this.deps.catalog.refresh();
  }

  async setDefault(model: string): Promise<{ previous: string }> {
    if (typeof model !== "string" || model.trim() === "" || model.indexOf("/") <= 0) {
      throw new ModelNotFoundError(model);
    }
    if (!this.deps.catalog.hasModel(model)) throw new ModelNotFoundError(model);
    const previous = this.deps.defaultModel.current();
    await this.deps.defaultModel.set(model);
    return { previous };
  }

  getDefault(): { model: string } {
    return { model: this.deps.defaultModel.current() };
  }

  async authList(): Promise<AuthProviderStatus[]> {
    const out: AuthProviderStatus[] = [];
    for (const providerId of this.deps.catalog.providerIds()) {
      const status = this.deps.auth.statusOf(providerId);
      out.push({
        providerId,
        configured: status.configured,
        ...(status.keyMasked !== undefined ? { keyMasked: status.keyMasked } : {}),
      });
    }
    return out;
  }

  async authSetKey(providerId: string, apiKey: string): Promise<{ keyMasked: string }> {
    this.assertProvider(providerId);
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw new Error(`apiKey 不能为空（provider ${providerId}；空值请用 auth.delete_key 移除）`);
    }
    return this.deps.auth.setKey(providerId, apiKey);
  }

  async authDeleteKey(providerId: string): Promise<void> {
    this.assertProvider(providerId);
    await this.deps.auth.deleteKey(providerId);
  }

  async authVerify(providerId: string): Promise<AuthVerifyOutcome> {
    this.assertProvider(providerId);
    return this.deps.catalog.verify(providerId, this.deps.auth.apiKeyOf(providerId));
  }

  private assertProvider(providerId: string): void {
    if (!this.deps.catalog.providerIds().includes(providerId)) throw new ProviderNotFoundError(providerId);
  }
}
