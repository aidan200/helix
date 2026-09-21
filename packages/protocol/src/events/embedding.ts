/**
 * embedding 配置域事件族（管家记忆 B2 批，additive；新 Channel 值
 * "embedding"——扩展纪律：新增族 = additive，不动分发器，"steward" 族
 * 先例同构口径）。
 *
 * 两帧：
 * - embedding.list.result = 端点清单回执（embedding.list/set/delete 三命令
 *   共用——写后即刷新清单）；
 * - embedding.verify.result = 连通测试回执（两判别 ok/fail；payload 回携
 *   id——与 auth.verify 的 in-flight 归属不同，端点行徽标四态
 *   unverified|verifying|ok|fail 由 shell 本地态 + 本帧驱动）。
 */
import type { EventFrame } from "../envelope";

/** 端点清单行（凭据卫生：apiKey 只进不出——hasApiKey 布尔 + 尾 4 位脱敏
 *  keyMasked，原值永不出库）。 */
export interface EmbeddingEndpointView {
  /** 端点 id（uuid）。 */
  id: string;
  /** 显示名。 */
  name: string;
  /** OpenAI 兼容服务根。 */
  baseUrl: string;
  /** 嵌入模型名。 */
  model: string;
  /** 是否已配 API key。 */
  hasApiKey: boolean;
  /** key 尾 4 位脱敏（如 "····7f3a"；未配 key = 缺席）。 */
  keyMasked?: string;
  /** 最近一次连通验证通过时间（epoch ms；从未验证 = null）。 */
  verifiedAt: number | null;
}

/** embedding.list.result payload：端点清单（list/set/delete 共用回执形态）。 */
export interface EmbeddingListResultPayload {
  /** 端点全集（daemon 权威现态）。 */
  endpoints: readonly EmbeddingEndpointView[];
}

/** embedding.list.result：端点清单回执（channel = "embedding"；点对点）。 */
export interface EmbeddingListResultEvent extends EventFrame<EmbeddingListResultPayload> {
  channel?: "embedding";
  type: "embedding.list.result";
}

/**
 * embedding.verify.result payload：连通测试两判别——ok = 端点可达且协议
 * 形态合法（dim = 实测向量维度，daemon 侧 dim 锁表语义）；fail = 不可达/
 * HTTP 非 2xx/协议异常（error 含定位信息）。id 回携——多端点并发验证
 * 归属无歧义（auth.verify in-flight 单飞限制的改良）。
 */
export type EmbeddingVerifyResultPayload =
  | {
      id: string;
      state: "ok";
      /** 实测向量维度（vec0 建表基准——不硬编码）。 */
      dim: number;
    }
  | {
      id: string;
      state: "fail";
      /** 失败原因（含定位信息）。 */
      error: string;
    };

/** embedding.verify.result：连通测试回执（channel = "embedding"；点对点）。 */
export interface EmbeddingVerifyResultEvent extends EventFrame<EmbeddingVerifyResultPayload> {
  channel?: "embedding";
  type: "embedding.verify.result";
}
