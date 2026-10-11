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
  /** 模型名（embedding = 嵌入模型；classifier = 判别模型如 jev-latest）。 */
  model: string;
  /** 端点用途（B4a）：embedding = 向量嵌入；classifier = 分类判官。
   *  daemon 回执恒显式（存量缺席已归一）。 */
  kind: "embedding" | "classifier";
  /** 分类端点协议变体（kind=classifier 携带；缺席 = "jev" 存量直连）。
   *  "pi-ai" = pi-ai 模型目录通道（model 填目录模型串，baseUrl 空）。 */
  variant?: string;
  /** 是否已配 API key。 */
  hasApiKey: boolean;
  /** key 尾 4 位脱敏（如 "····7f3a"；未配 key = 缺席）。 */
  keyMasked?: string;
  /** 最近一次连通验证通过时间（epoch ms；从未验证 = null）。 */
  verifiedAt: number | null;
}

/** embedding.list.result payload：端点清单（list/set/delete/set_default 共用回执形态）。 */
export interface EmbeddingListResultPayload {
  /** 端点全集（daemon 权威现态）。 */
  endpoints: readonly EmbeddingEndpointView[];
  /** 全局默认 embedding 端点 id（批1；未设/引用悬空 = null——消费面按
   *  「向量面不可用」降级：记忆拒开、kg 嵌入降级 warn）。 */
  defaultEndpointId: string | null;
  /** 全局默认分类端点 id（D1 渐进收编，additive 可选——旧壳缺席忽略；
   *  未设/引用悬空 = null = 判官缺席，各消费面维持现状降级）。 */
  defaultClassifierEndpointId?: string | null;
}

/** embedding.list.result：端点清单回执（channel = "embedding"；点对点）。 */
export interface EmbeddingListResultEvent extends EventFrame<EmbeddingListResultPayload> {
  channel?: "embedding";
  type: "embedding.list.result";
}

/**
 * embedding.verify.result payload：连通测试两判别（按 kind 分叉探测：
 * embedding 端点一次短文本嵌入回 dim；classifier 端点一次 noul 判定回
 * 校准概率 prob）——ok = 端点可达且协议形态合法；fail = 不可达/
 * HTTP 非 2xx/协议异常（error 含定位信息）。id 回携——多端点并发验证
 * 归属无歧义（auth.verify in-flight 单飞限制的改良）。
 */
export type EmbeddingVerifyResultPayload =
  | {
      id: string;
      state: "ok";
      /** 实测向量维度（embedding 端点；vec0 建表基准——不硬编码）。 */
      dim: number;
    }
  | {
      id: string;
      state: "ok";
      /** classifier 端点（B4a）：noul 探测回校准概率（与 dim 变体互斥——
       *  按 kind 分叉探测，二选一）。 */
      prob: number;
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
