/**
 * CustomProviderService —— 三方平台（自定义 provider）配置域 application
 * service（三方平台批；形态参考 EmbeddingConfigService 先例——独立配置域，
 * runtime_config KV 存储）。
 *
 * 职责：
 * - CRUD：set（按 id upsert——id 是用户命名位 = 模型字符串前缀，规则
 *   `[a-z0-9][a-z0-9-]*` 且不得与内置 provider 冲突）/ delete / list
 *   （daemon 内全量）/ listView（回执视图——key 状态经 authStore 投影，
 *   本域不存 key，凭据单写点 auth.json 不变）；
 * - 活目录同步：set/delete 成功后同步 registry（MutableModels 活注册）——
 *   目录读面（catalog/modelsView/getModel/providerIds）即时反映，无需
 *   重启 daemon；下一请求即按新目录解析；
 * - delete 防线：全局默认模型落在目标 provider 上 → 拒绝（先换默认模型
 *   再删——防删后新会话启动 fail-fast）。
 *
 * key 路径刻意不在本域：录入走 auth.set_key（自定义 provider 进合并目录
 * 后 assertProvider 自动放行），验证走 auth.verify（目录模型最小请求）。
 */
import type { RuntimeConfigPort } from "../ports/outbound/RuntimeConfigPort";
import type {
  CustomProviderApiStyle,
  CustomProviderDef,
  CustomProviderRegistryPort,
  CustomProviderThinkingFormat,
} from "../ports/outbound/CustomProviderPort";
import {
  CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
  CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
} from "../ports/outbound/CustomProviderPort";
import type { AuthStorePort } from "../ports/outbound/AuthStorePort";
import type { DefaultModelPort } from "../ports/outbound/DefaultModelPort";
import type { ProviderView } from "@helix/protocol";

/** 平台清单 KV 键（JSON 数组）。 */
export const CUSTOM_PROVIDERS_KEY = "custom_providers";

/** provider id 规则（用户命名位：模型字符串前缀，小写字母数字连字符）。 */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** provider id 最大长度。 */
const PROVIDER_ID_MAX_LENGTH = 32;
/** 单平台模型清单上限（防误粘贴大清单膨胀回执帧）。 */
const PROVIDER_MODELS_LIMIT = 50;

/** 思考方言全集（校验/归一共用；与 protocol 枚举同源镜像）。 */
const THINKING_FORMATS: readonly CustomProviderThinkingFormat[] = [
  "auto",
  "openai",
  "deepseek",
  "qwen",
  "zai",
  "openrouter",
  "together",
  "baseten",
  "chat-template",
  "qwen-chat-template",
  "string-thinking",
  "ant-ling",
];

/**
 * KV JSON 防御解析（形态非法视同空表；EmbeddingConfigService.parseRecords
 * 同构）。导出供装配期（buildModelStack 启动登记）复用——纯函数无依赖。
 */
export function parseCustomProviders(raw: string | undefined): CustomProviderDef[] {
  if (raw === undefined || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: CustomProviderDef[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Partial<CustomProviderDef>;
      if (typeof r.id !== "string" || r.id === "") continue;
      if (typeof r.name !== "string" || typeof r.baseUrl !== "string") continue;
      if (!Array.isArray(r.models)) continue;
      // api 风格宽容归一（旧存储行无此字段 = undefined，装配期归一 openai-completions）
      const api = r.api === "anthropic-messages" ? "anthropic-messages" : r.api === "openai-completions" ? "openai-completions" : undefined;
      // 思考方言宽容归一（旧存储行无此字段 = undefined，读面/装配期归一 auto）
      const thinkingFormat = THINKING_FORMATS.includes(r.thinkingFormat as CustomProviderThinkingFormat)
        ? (r.thinkingFormat as CustomProviderThinkingFormat)
        : undefined;
      const models = r.models.filter(
        (m): m is NonNullable<CustomProviderDef["models"][number]> =>
          typeof m === "object" && m !== null && typeof (m as { id?: unknown }).id === "string" && (m as { id: string }).id !== "",
      );
      out.push({ id: r.id, name: r.name, ...(api !== undefined ? { api } : {}), ...(thinkingFormat !== undefined ? { thinkingFormat } : {}), baseUrl: r.baseUrl, models });
    }
    return out;
  } catch {
    return [];
  }
}

/** set 入参（协议载荷的 daemon 内形态；id 必填——upsert 键）。 */
export interface CustomProviderSetInput {
  id: string;
  name?: string;
  /** API 风格（缺省 openai-completions）。 */
  api?: CustomProviderApiStyle;
  /** 思考控制方言（缺省 auto = pi-ai 按 baseUrl 探测）。 */
  thinkingFormat?: CustomProviderThinkingFormat;
  baseUrl: string;
  models: readonly {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    inputPrice?: number;
    outputPrice?: number;
  }[];
}

export interface CustomProviderServiceDeps {
  readonly config: RuntimeConfigPort;
  /** 活注册表（MutableModels 同步面——driven 实现体经组合根注入）。 */
  readonly registry: CustomProviderRegistryPort;
  /** key 状态投影（listView 的 hasApiKey/keyMasked 数据源；不写）。 */
  readonly auth: AuthStorePort;
  /** 全局默认模型（delete 防线：默认模型落在目标 provider 上 → 拒绝）。 */
  readonly defaultModel: DefaultModelPort;
}

export class CustomProviderService {
  /** 写面串行链（评审 low #62）：set/delete 是 list→改→set 读改写，无串行
   *  守卫时并发两次 set 各自读到旧表、后写覆盖先写（丢更新）。与
   *  EmbeddingConfigService.enqueueMutation 同构。 */
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: CustomProviderServiceDeps) {}

  private enqueueMutation<T>(op: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(op, op);
    this.mutationChain = next.catch(() => undefined);
    return next;
  }

  /** 全量平台定义（daemon 内）。 */
  list(): readonly CustomProviderDef[] {
    return parseCustomProviders(this.deps.config.get(CUSTOM_PROVIDERS_KEY));
  }

  /** 回执视图（key 状态投影 + 模型行缺省归一——协议 ProviderView 形态）。 */
  listView(): readonly ProviderView[] {
    return this.list().map((def) => {
      const status = this.deps.auth.statusOf(def.id);
      return {
        id: def.id,
        name: def.name,
        api: def.api ?? "openai-completions",
        thinkingFormat: def.thinkingFormat ?? "auto",
        baseUrl: def.baseUrl,
        models: def.models.map((m) => ({
          id: m.id,
          name: m.name ?? m.id,
          contextWindow: m.contextWindow ?? CUSTOM_MODEL_DEFAULT_CONTEXT_WINDOW,
          maxTokens: m.maxTokens ?? CUSTOM_MODEL_DEFAULT_MAX_TOKENS,
          reasoning: m.reasoning ?? false,
          inputPrice: m.inputPrice ?? 0,
          outputPrice: m.outputPrice ?? 0,
        })),
        hasApiKey: status.configured,
        ...(status.keyMasked !== undefined ? { keyMasked: status.keyMasked } : {}),
      };
    });
  }

  /**
   * 新增或更新（按 id upsert）。校验失败回中文 error（driving 层映射
   * command.invalid_payload）；成功 = KV 落盘 + 活注册表同步（upsert 语义：
   * 更新时旧模型清单整体替换）。
   */
  async set(input: CustomProviderSetInput): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.enqueueMutation(() => this.setInner(input));
  }

  private async setInner(input: CustomProviderSetInput): Promise<{ ok: true } | { ok: false; error: string }> {
    const id = input.id.trim();
    if (id === "" || !PROVIDER_ID_PATTERN.test(id) || id.length > PROVIDER_ID_MAX_LENGTH) {
      return {
        ok: false,
        error: `平台 id 应为 "${PROVIDER_ID_PATTERN.source}" 形式（≤${PROVIDER_ID_MAX_LENGTH} 字符，如 volcengine-plan）`,
      };
    }
    if (this.deps.registry.builtinProviderIds().includes(id)) {
      return { ok: false, error: `平台 id "${id}" 与内置 provider 冲突（请换一个 id）` };
    }
    const name = (input.name ?? "").trim() || id;
    const baseUrl = input.baseUrl.trim();
    if (baseUrl === "") return { ok: false, error: "baseUrl 不得为空（OpenAI 兼容服务根，如 https://ark.cn-beijing.volces.com/api/plan/v3）" };
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
    } catch {
      return { ok: false, error: `baseUrl 应为 http/https URL（收到 "${baseUrl}"）` };
    }
    if (!Array.isArray(input.models) || input.models.length === 0) {
      return { ok: false, error: "models 应为非空数组（至少一条模型清单行）" };
    }
    if (input.models.length > PROVIDER_MODELS_LIMIT) {
      return { ok: false, error: `模型清单超出上限（${input.models.length} > ${PROVIDER_MODELS_LIMIT}）` };
    }
    if (input.api !== undefined && input.api !== "openai-completions" && input.api !== "anthropic-messages") {
      return { ok: false, error: 'api 风格应为 "openai-completions" 或 "anthropic-messages"' };
    }
    const api = input.api ?? "openai-completions";
    if (input.thinkingFormat !== undefined && !THINKING_FORMATS.includes(input.thinkingFormat)) {
      return { ok: false, error: `thinkingFormat 应为以下之一：${THINKING_FORMATS.join(" / ")}` };
    }
    const thinkingFormat = input.thinkingFormat ?? "auto";
    const seen = new Set<string>();
    const modelRows: NonNullable<CustomProviderDef["models"][number]>[] = [];
    for (const m of input.models) {
      if (typeof m !== "object" || m === null || typeof m.id !== "string" || m.id.trim() === "") {
        return { ok: false, error: "模型清单行 id 应为非空 string（如 kimi-k3）" };
      }
      const mid = m.id.trim();
      if (seen.has(mid)) return { ok: false, error: `模型 id 重复："${mid}"（同一平台内唯一）` };
      seen.add(mid);
      if (m.contextWindow === undefined || !Number.isInteger(m.contextWindow) || m.contextWindow <= 0) {
        return { ok: false, error: `模型 "${mid}" 的 contextWindow 必填且应为正整数（如 256000）` };
      }
      if (m.maxTokens !== undefined && (!Number.isInteger(m.maxTokens) || m.maxTokens <= 0)) {
        return { ok: false, error: `模型 "${mid}" 的 maxTokens 应为正整数` };
      }
      if (m.reasoning !== undefined && typeof m.reasoning !== "boolean") {
        return { ok: false, error: `模型 "${mid}" 的 reasoning 应为 boolean` };
      }
      if (m.inputPrice !== undefined && (!Number.isFinite(m.inputPrice) || m.inputPrice < 0)) {
        return { ok: false, error: `模型 "${mid}" 的 inputPrice 应为非负数（美元/百万 token）` };
      }
      if (m.outputPrice !== undefined && (!Number.isFinite(m.outputPrice) || m.outputPrice < 0)) {
        return { ok: false, error: `模型 "${mid}" 的 outputPrice 应为非负数（美元/百万 token）` };
      }
      modelRows.push({
        id: mid,
        ...(typeof m.name === "string" && m.name.trim() !== "" ? { name: m.name.trim() } : {}),
        contextWindow: m.contextWindow,
        ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
        ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
        ...(m.inputPrice !== undefined ? { inputPrice: m.inputPrice } : {}),
        ...(m.outputPrice !== undefined ? { outputPrice: m.outputPrice } : {}),
      });
    }
    const def: CustomProviderDef = { id, name, api, thinkingFormat, baseUrl, models: modelRows };
    const records = this.list().filter((r) => r.id !== id);
    records.push(def);
    await this.deps.config.set(CUSTOM_PROVIDERS_KEY, JSON.stringify(records));
    this.deps.registry.register(def); // 活目录同步（即时生效——下一请求按新目录解析）
    return { ok: true };
  }

  /** 删除（id 不存在 → error；默认模型防线 → error；成功 = KV 落盘 + 活注册表撤销）。 */
  async delete(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.enqueueMutation(() => this.deleteInner(id));
  }

  private async deleteInner(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const records = this.list();
    if (!records.some((r) => r.id === id)) return { ok: false, error: `平台不存在：${id}` };
    const prefix = `${id}/`;
    const current = this.deps.defaultModel.current();
    if (current !== undefined && current.startsWith(prefix)) {
      return {
        ok: false,
        error: `全局默认模型 ${current} 落在平台 "${id}" 上——请先经 model.set_default 换默认模型再删除`,
      };
    }
    await this.deps.config.set(CUSTOM_PROVIDERS_KEY, JSON.stringify(records.filter((r) => r.id !== id)));
    this.deps.registry.unregister(id); // 活目录同步（幂等）
    return { ok: true };
  }
}
