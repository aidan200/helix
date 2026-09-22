/**
 * 分类判官出站端口（outbound，管家记忆 B4a 批）。
 *
 * 职责：单步判别（零生成 token 的分类判定）——管家记忆「自动沉淀」的
 * 写入闸判官面：对话收口后判定「是否包含更新用户认知的新信息」。
 *
 * 原语（Jev 协议面）：noul —— 二分类校准概率（0.0~1.0）。校准置信度是
 * 本端口的核心价值（说 0.8 就是真 ~80% 准确率——门控分级的依据：
 * 高置信自动、低置信问人），非校准 softmax 分数不可替代。
 *
 * 实现体 = driven embedding/JevJudgeAdapter（TypeSafe Jev 云 API：
 * POST /systemone + noul question）。将来本地复现（无校准）或换判官
 * 实现只动 adapter，端口不动。
 */

import type { EmbeddingEndpointConfig } from "./EmbeddingPort";

/** 判官端口配置（复用 embedding 端点配置形态——baseUrl/apiKey/model；
 *  kind 维度在 EmbeddingConfigService 的端点记录上，端口本身无感）。 */
export type JudgeEndpointConfig = EmbeddingEndpointConfig;

export interface JudgePort {
  /**
   * 二分类校准概率判定。state（对话片段等上下文）+ question（判定问题
   * 的自然语言表述）→ P(yes) ∈ [0,1]（校准——可直接做置信度门控阈值）。
   * 端点未配置/网络失败/协议异常 → 抛错（服务层捕获降级为「判官不可用」，
   * 不挡对话主链路）。
   */
  noul(state: string, question: string): Promise<number>;
  /** 端点可读标识（配置面状态展示）。 */
  endpointLabel(): string;
}
