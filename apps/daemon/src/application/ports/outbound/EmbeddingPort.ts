/**
 * 文本嵌入出站端口（outbound，管家记忆 B1 批）。
 *
 * 职责：把文本编码为稠密向量（管家长期记忆的语义召回底座）。实现体 =
 * driven embedding/OpenAiCompatEmbeddingAdapter（OpenAI 兼容 HTTP 协议
 * `/v1/embeddings`——一个实现同时覆盖云端 provider 与本地 Ollama/
 * LM Studio，协议同构零分支）。
 *
 * 维度纪律：vec0 虚拟表维度建表锁死——实现方每次 embed 返回实测 dim，
 * 服务层比对存储维度，不一致即触发向量面重建（文本是唯一 source of
 * truth，向量是可再生缓存）。
 */

/** 一次嵌入调用的结果（向量数组与输入 texts 等长同序）。 */
export interface EmbeddingResult {
  /** 稠密向量（Float32——与 sqlite-vec float[N] 存储形态对齐）。 */
  readonly vectors: readonly Float32Array[];
  /** 实测维度（服务端返回向量长度——不硬编码，换模型自动跟随）。 */
  readonly dim: number;
}

/** 嵌入端点配置（KV JSON 反序列化形态——AG-02 纪律：application 层类型
 *  单源在端口文件，driven 适配器反向 import）。 */
export interface EmbeddingEndpointConfig {
  /** OpenAI 兼容服务根（如 "https://api.openai.com/v1" 或
   *  "http://localhost:11434/v1"——尾斜杠客忍）。 */
  readonly baseUrl: string;
  /** API key（本地 Ollama 等免 key 端点可缺省/空串）。 */
  readonly apiKey?: string;
  /** 模型名（如 "bge-m3" / "text-embedding-3-small"）。 */
  readonly model: string;
}

export interface EmbeddingPort {
  /**
   * 批量文本嵌入。端点未配置/网络失败/协议异常 → 抛错（服务层捕获降级
   * 为「记忆不可用」，绝不上抛挡对话主链路）。
   */
  embed(texts: readonly string[]): Promise<EmbeddingResult>;
  /** 端点可读标识（配置面状态展示：如 "ollama/bge-m3 @ localhost:11434"）。 */
  endpointLabel(): string;
}
