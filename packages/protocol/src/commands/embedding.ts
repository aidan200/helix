/**
 * embedding 配置域命令族（管家记忆 B2 批，additive；形态参考 stt.ts/
 * voice.ts 域文件先例——独立配置域，不进 steward 设置面）。
 *
 * 链路：设置页模型分区「向量模型」tab → embedding.list/set/delete/
 * verify → daemon EmbeddingConfigService（runtime_config KV
 * embedding_endpoints——[{id,name,baseUrl,apiKey?,model}]，apiKey 明文
 * 存储对齐 auth.json 同款不另造加密）→ embedding.list.result 点对点
 * 回执（set/delete 共用——写后即刷新清单，与 mcp 族回执同构）。
 *
 * 凭据卫生：apiKey 只进不出——回执端点行只回 hasApiKey 布尔 + key 尾
 * 不回传；verify 连通结果经 embedding.verify.result 事件回推（payload
 * 回携 id——与 auth.verify 的 in-flight 归属不同，多端点并发归属无歧义）。
 *
 * 消费关系：steward.set_config {memory:{endpointId}} 引用本域端点条目
 * （管家记忆 B2 瘦身——端点 CRUD 收编模型页，管家组只留开关 + 端点选择）。
 */
import type { CommandFrame } from "../envelope";

/** embedding.list：读端点清单（点对点回执 embedding.list.result）。 */
export interface EmbeddingListCommand extends CommandFrame<Record<string, never>> {
  type: "embedding.list";
}

/**
 * embedding.set 载荷：新增或更新端点。id 缺省 = 新增（uuid 生成）；带 id =
 * 更新既有条目。更新形态字段三态**分两类**（以 daemon
 * EmbeddingConfigService.set 为单源）：
 * - 覆盖写：name / model / **baseUrl**——缺席 = 空串（**不是「不动」**）；
 *   其中 baseUrl 按 variant 条件必填（目录型免填，直连型缺席即
 *   command.invalid_payload）。故**更新目录型条目必须同带 variant**，否则按
 *   直连型校验被拒。
 * - 缺省 = 不动：apiKey（空串 = 清除）、kind、variant。
 */
export interface EmbeddingSetPayload {
  /** 目标端点 id（缺省 = 新增）。 */
  id?: string;
  /** 端点显示名（非空；如 "Ollama 本地"）。 */
  name: string;
  /** OpenAI 兼容服务根（如 "http://localhost:11434/v1"）。variant="pi-ai"
   *  目录通道免填（model 填目录模型串，走 provider key）。
   *  **覆盖写语义：更新形态缺席 = 置空**（非「不动」）——直连型缺席即被拒，
   *  目录型缺席落空串。 */
  baseUrl?: string;
  /** API key（本地免 key 端点可空；更新形态下空串 = 清除）。 */
  apiKey?: string;
  /** 模型名（embedding = 嵌入模型如 "bge-m3"；classifier = 判别模型如
   *  "jev-latest"）。 */
  model: string;
  /** 端点用途（B4a）：embedding = 向量嵌入（缺省）；classifier = 分类
   *  判官（Jev /systemone noul 探测面）。更新形态下缺省 = 不动。 */
  kind?: "embedding" | "classifier";
  /** 分类端点协议变体（kind=classifier 专用）："pi-ai" = 目录通道
   *  （model 填目录模型串、baseUrl 免填、apiKey 缺省回落 provider key）；
   *  缺席 = "jev" 直连存量形态。更新形态下缺省 = 不动。 */
  variant?: string;
}

/** embedding.set：新增/更新端点（点对点回执 embedding.list.result 新清单）。 */
export interface EmbeddingSetCommand extends CommandFrame<EmbeddingSetPayload> {
  type: "embedding.set";
}

/** embedding.delete 载荷。 */
export interface EmbeddingDeletePayload {
  /** 目标端点 id。 */
  id: string;
}

/** embedding.delete：删除端点（点对点回执 embedding.list.result 新清单）。 */
export interface EmbeddingDeleteCommand extends CommandFrame<EmbeddingDeletePayload> {
  type: "embedding.delete";
}

/** embedding.set_default 载荷（批1：全局默认 embedding 端点；D1 渐进收编泛化
 *  kind 维度——classifier = 默认分类端点，与向量默认同构对称）。 */
export interface EmbeddingSetDefaultPayload {
  /** 目标端点 id（须为 kind 吻合且已 verify 的条目——daemon 校验三拒）。 */
  id: string;
  /** 默认档位用途（D1）：缺省 = "embedding"（E-306 契约零变化）；"classifier"
   *  = 全局默认分类端点（判官消费面兑底取用）。 */
  kind?: "embedding" | "classifier";
}

/**
 * embedding.set_default：设置全局默认端点（批1 embedding；D1 泛化 kind 维度
 * ——classifier 默认端点同构对称）。单选语义——写 embedding.defaultEndpointId
 * （向量）/ classifier.defaultEndpointId（分类）引用态 KV，换默认 = 改引用，
 * 无级联清理。校验：条目存在 ∧ kind 吻合 ∧ 已 verify，任一不满足回
 * invalid_payload（错误文本含定位）。点对点回执 embedding.list.result 新清单
 * （payload.defaultEndpointId / defaultClassifierEndpointId 即时更新）。
 */
export interface EmbeddingSetDefaultCommand extends CommandFrame<EmbeddingSetDefaultPayload> {
  type: "embedding.set_default";
}

/** embedding.verify 载荷。 */
export interface EmbeddingVerifyPayload {
  /** 目标端点 id。 */
  id: string;
}

/**
 * embedding.verify：连通测试（OpenAI 兼容 /v1/embeddings 一次短文本嵌入）
 * ——异步形态对齐 auth.verify 先例：回执经事件 embedding.verify.result
 * 回推（payload 回携 id，多端点并发验证归属无歧义）。
 */
export interface EmbeddingVerifyCommand extends CommandFrame<EmbeddingVerifyPayload> {
  type: "embedding.verify";
}
