/**
 * JudgeAdapterFactory —— 分类端点适配器注册表（分类模型扩展缝，2026-09-24）。
 *
 * 为什么存在：分类模型生态刚起步，Jev 直连（variant="jev"）与 pi-ai 目录
 * 通道（variant="pi-ai"，2026-10）都不是唯一选择。把「端点记录 → JudgePort」
 * 的分派收敛到本注册表单点：端点记录 variant 字段（EmbeddingEndpointRecord.
 * variant，缺席 = "jev" 存量兼容）决定用哪个适配器；新分类模型接入 = 新增
 * 一个注册表条目 + 新适配器实现 JudgePort，配置域形状零改动，消费面
 * （管家记忆判官 / 会话主题漂移判官）零感知。
 *
 * JudgePort 是分类能力的统一契约（noul = [0,1] 校准概率）：不同协议的分类
 * 模型在各自适配器内翻译成该契约，消费面只吃概率。
 *
 * services（判官目录依赖面）：pi-ai 等目录型 variant 需要「模型目录读面 +
 * provider key 读面」——由组合根注入（modelStack.catalog.modelsView +
 * authStore.apiKeyOf），注册表条目按需消费（jev 直连型忽略）。必传：调用方
 * 全量走组合根，测试注入受控 fake。
 *
 * 分派是惰性的（每次调用先 resolve 端点记录再按 variant 取适配器）：与
 * 「端点惰性读面、换端点/换变体零重启跟随」的既有语义对齐。
 *
 * 失败语义：resolve 回 null = 未配置（下游适配器自带未配置抛错）；未知
 * variant 直接抛错（含已支持清单——定位信息）。调用方（EmbeddingConfigService.
 * verify / 管家记忆查重）已有捕获降级面，不挡主链路。
 */
import type { Models } from "@earendil-works/pi-ai";
import type { JudgeEndpointConfig, JudgePort } from "../../../application/ports/outbound/JudgePort";
import { JevJudgeAdapter } from "./JevJudgeAdapter";
import { PiAiJudgeAdapter } from "./PiAiJudgeAdapter";

/** 端点记录读面（JudgeEndpointConfig + 协议变体标注；EmbeddingEndpointRecord
 *  结构兼容——resolveRecord 直出可作实参）。 */
export type JudgeRecord = JudgeEndpointConfig & { readonly variant?: string };

/** 判官目录依赖面（目录型 variant 消费；直连型忽略）。 */
export interface JudgeAdapterServices {
  /** pi-ai 目录合并视图惰性读面（modelStack.catalog.modelsView）。 */
  readonly getModels: () => Models;
  /** provider key getter（authStore.apiKeyOf——每次调用重读）。 */
  readonly getApiKey: (provider: string) => string | undefined;
}

/** 适配器工厂形态（getConfig 惰性读面——改配置下一次调用自动跟随）。 */
export type JudgeAdapterFactory = (getConfig: () => JudgeRecord | null, services: JudgeAdapterServices) => JudgePort;

/** 注册表：variant → 适配器工厂（新分类模型在此登记）。 */
const JUDGE_ADAPTER_FACTORIES: Readonly<Record<string, JudgeAdapterFactory>> = {
  jev: (getConfig) => new JevJudgeAdapter({ getConfig }),
  "pi-ai": (getConfig, services) =>
    new PiAiJudgeAdapter({ getModels: services.getModels, getConfig, getApiKey: services.getApiKey }),
};

/** 按端点记录 variant 惰性分派适配器（每次调用先 resolve；variant 缺席 =
 * "jev" 存量兼容；未知 variant 抛错降级）。 */
export function makeJudgeAdapter(resolve: () => JudgeRecord | null, services: JudgeAdapterServices): JudgePort {
  const pick = (): JudgePort => {
    const variant = resolve()?.variant ?? "jev";
    const factory = JUDGE_ADAPTER_FACTORIES[variant];
    if (factory === undefined) {
      throw new Error(`不支持的分类端点类型：${variant}（已支持：${Object.keys(JUDGE_ADAPTER_FACTORIES).join(", ")}）`);
    }
    return factory(resolve, services);
  };
  return {
    noul: (state, question) => pick().noul(state, question),
    endpointLabel: () => pick().endpointLabel(),
  };
}
