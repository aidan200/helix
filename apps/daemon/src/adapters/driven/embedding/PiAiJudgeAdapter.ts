/**
 * pi-ai 分类器判官适配器（driven；variant = "pi-ai"）。
 *
 * 通道：JudgePort.noul（二分类校准概率）→ pi-ai Models.classify（bool 问题
 * 契约——answers.{q}.probability 即 P(true) 校准概率，与 Jev noul 同语义；
 * TypeSafe System One 协议下 bool 由 pi-ai 翻译为 noul wire 形态）。
 *
 * 为什么存在：判官接入层收敛到 pi-ai 模型目录——用户不再手工配置判官专属
 * 端点（baseUrl 指向），而是选目录内 classifier 型模型（typesafe/openrouter/
 * cloudflare/vercel 等 provider 的 jev 系，含后续新增分类模型），凭据复用
 * auth.json provider key（与主引擎/管家同一键位）。分类模型生态演进由 pi-ai
 * 目录承接，helix 不再自养端点兼容面。
 *
 * 配置面（EmbeddingEndpointRecord 复用，variant="pi-ai"）：
 * - model：目录模型串 "provider/model-id"（resolveModel 契约——如
 *   "typesafe/jev-latest"、"openrouter/typesafe/jev-1.13"）；
 * - apiKey：可选——端点记录自带优先；缺失回落 auth.json provider key
 *   （getApiKey 注入，每次调用重读，换 key 自动跟随）；
 * - baseUrl：本 variant 不消费（配置域形状兼容占位）。
 *
 * 失败语义：未配置/模型解析失败/非 classifier 型/key 缺失/classify
 * stopReason≠stop/协议形态异常一律抛错（消息含定位信息；pi-ai classify 不
 * reject——错误在结果的 stopReason/errorMessage 里，此处翻译回抛错）——
 * 服务层捕获降级为「判官不可用」，不挡对话主链路。
 */

import type { ClassifierApi, ClassifierContext, ClassifierModel, JsonObject, Models } from "@earendil-works/pi-ai";
import { getModelType } from "@earendil-works/pi-ai/models";
import { resolveModel } from "../llm";
import type { JudgePort } from "../../../application/ports/outbound/JudgePort";
import type { JudgeRecord } from "./JudgeAdapterFactory";

export interface PiAiJudgeAdapterDeps {
  /** pi-ai 目录合并视图惰性读面（组合根注入 modelStack.catalog.modelsView）。 */
  readonly getModels: () => Models;
  /** 端点配置惰性读面（null = 未配置 → noul 抛错降级）。 */
  readonly getConfig: () => JudgeRecord | null;
  /** provider key getter（组合根注入 authStore.apiKeyOf——每次调用重读）。 */
  readonly getApiKey: (provider: string) => string | undefined;
  /** 凭据类型读面（OAuth 分流：oauth 凭据存在 → 不覆盖，交注入 store 解析）。 */
  readonly getCredentialType?: (provider: string) => "api_key" | "oauth" | undefined;
}

export class PiAiJudgeAdapter implements JudgePort {
  private readonly deps: PiAiJudgeAdapterDeps;

  constructor(deps: PiAiJudgeAdapterDeps) {
    this.deps = deps;
  }

  endpointLabel(): string {
    const cfg = this.deps.getConfig();
    if (cfg === null) return "pi-ai 未配置";
    return `pi-ai/${cfg.model}`;
  }

  async noul(state: string, question: string): Promise<number> {
    const cfg = this.deps.getConfig();
    if (cfg === null) throw new Error("判官端点未配置");
    const models = this.deps.getModels();
    let model;
    try {
      model = resolveModel(models, cfg.model);
    } catch (err) {
      throw new Error(`判官模型解析失败：${(err as Error).message}`);
    }
    if (getModelType(model) !== "classifier") {
      throw new Error(
        `模型 ${cfg.model} 不是分类模型（classifier 型才能用于判官）——请在端点记录 model 填目录内 classifier 型模型串`,
      );
    }
    const classifier = model as unknown as ClassifierModel<ClassifierApi>;
    const apiKey = cfg.apiKey !== undefined && cfg.apiKey !== "" ? cfg.apiKey : this.deps.getApiKey(classifier.provider);
    if ((apiKey === undefined || apiKey === "") && this.deps.getCredentialType?.(classifier.provider) !== "oauth") {
      // OAuth 分流（订阅登录批）：oauth 凭据存在 → 不覆盖，交注入 store 解析；两无 fail-fast
      throw new Error(
        `没有 provider "${classifier.provider}" 的凭据（端点记录 apiKey 缺失且 auth.json 未录入——请经设置页 auth.set_key 录入、订阅登录，或端点记录补 apiKey）`,
      );
    }
    const context: ClassifierContext = {
      state: { text: state } as JsonObject,
      questions: {
        q: {
          type: "bool",
          instructions: question,
          criteria: { true: question, false: `非：${question}` },
        },
      },
    };
    const result = await models.classify(classifier, context, {
      ...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}),
    });
    if (result.stopReason !== "stop") {
      throw new Error(`判官分类失败（${result.stopReason}）：${result.errorMessage ?? "无错误详情"}`);
    }
    const answer = result.answers.q;
    if (answer === undefined || answer.type !== "bool") {
      throw new Error("判官响应缺 answers.q（bool 形态）");
    }
    const probability = answer.probability;
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error(`判官概率形态非法（应为 [0,1] 数值）：${String(probability)}`);
    }
    return probability;
  }
}
