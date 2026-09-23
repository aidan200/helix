/**
 * JudgeAdapterFactory —— 分类端点适配器注册表（分类模型扩展缝，2026-09-24）。
 *
 * 为什么存在：分类模型生态刚起步（当前唯一实现 = Jev noul 判官），但 Jev
 * 不是唯一选择——未来会有其他分类模型/协议。把「端点记录 → JudgePort」的
 * 分派收敛到本注册表单点：端点记录 variant 字段（EmbeddingEndpointRecord.
 * variant，缺席 = "jev" 存量兼容）决定用哪个适配器；新分类模型接入 = 新增
 * 一个注册表条目 + 新适配器实现 JudgePort，配置域形状零改动，消费面
 * （管家记忆判官 / 会话主题漂移判官）零感知。
 *
 * JudgePort 是分类能力的统一契约（noul = [0,1] 校准概率）：不同协议的分类
 * 模型在各自适配器内翻译成该契约，消费面只吃概率。
 *
 * 分派是惰性的（每次调用先 resolve 端点记录再按 variant 取适配器）：与
 * 「端点惰性读面、换端点/换变体零重启跟随」的既有语义对齐。
 *
 * 失败语义：resolve 回 null = 未配置（下游适配器自带未配置抛错）；未知
 * variant 直接抛错（含已支持清单——定位信息）。调用方（EmbeddingConfigService.
 * verify / SessionTitleService / 管家记忆）已有捕获降级面，不挡主链路。
 */
import type { JudgeEndpointConfig, JudgePort } from "../../../application/ports/outbound/JudgePort";
import { JevJudgeAdapter } from "./JevJudgeAdapter";

/** 端点记录读面（JudgeEndpointConfig + 协议变体标注；EmbeddingEndpointRecord
 *  结构兼容——resolveRecord 直出可作实参）。 */
export type JudgeRecord = JudgeEndpointConfig & { readonly variant?: string };

/** 适配器工厂形态（getConfig 惰性读面——改配置下一次调用自动跟随）。 */
export type JudgeAdapterFactory = (getConfig: () => JudgeRecord | null) => JudgePort;

/** 注册表：variant → 适配器工厂（新分类模型在此登记）。 */
const JUDGE_ADAPTER_FACTORIES: Readonly<Record<string, JudgeAdapterFactory>> = {
  jev: (getConfig) => new JevJudgeAdapter({ getConfig }),
};

/** 按端点记录 variant 惰性分派适配器（每次调用先 resolve；variant 缺席 =
 * "jev" 存量兼容；未知 variant 抛错降级）。 */
export function makeJudgeAdapter(resolve: () => JudgeRecord | null): JudgePort {
  const pick = (): JudgePort => {
    const variant = resolve()?.variant ?? "jev";
    const factory = JUDGE_ADAPTER_FACTORIES[variant];
    if (factory === undefined) {
      throw new Error(`不支持的分类端点类型：${variant}（已支持：${Object.keys(JUDGE_ADAPTER_FACTORIES).join(", ")}）`);
    }
    return factory(resolve);
  };
  return {
    noul: (state, question) => pick().noul(state, question),
    endpointLabel: () => pick().endpointLabel(),
  };
}
