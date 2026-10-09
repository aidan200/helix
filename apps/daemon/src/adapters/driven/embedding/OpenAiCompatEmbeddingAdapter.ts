/**
 * OpenAI 兼容协议嵌入适配器（driven，管家记忆 B1 批）。
 *
 * 协议面：POST {baseUrl}/embeddings，body {model, input: string[]}，
 * 响应 {data: [{embedding: number[]}]}（OpenAI `/v1/embeddings` 契约
 * 子集）。一个实现通吃：云端（OpenAI/阿里百炼/Jina）+ 本地（Ollama
 * `http://localhost:11434/v1` / LM Studio）——协议同构零分支。
 *
 * 配置面：端点配置（baseUrl/apiKey/model）由 getConfig 惰性读面注入
 * （组合根接 RuntimeConfigPort KV steward.memory.embedding——与
 * PiStewardLlmAdapter modelSlot 同构：改配置下一次调用自动跟随，
 * 零重建零装配时定格）。
 *
 * 失败语义：未配置/网络错/HTTP 非 2xx/协议形态异常一律抛错（消息含
 * 定位信息）——服务层捕获降级为「记忆不可用」，绝不上抛挡对话主链路。
 */

import type {
  EmbeddingEndpointConfig,
  EmbeddingPort,
  EmbeddingResult,
} from "../../../application/ports/outbound/EmbeddingPort";

export type { EmbeddingEndpointConfig };

export interface OpenAiCompatEmbeddingDeps {
  /** 端点配置惰性读面（null = 未配置 → embed 抛错降级）。 */
  readonly getConfig: () => EmbeddingEndpointConfig | null;
  /** fetch 注入（测试桩；缺省全局 fetch）。 */
  readonly fetch?: typeof fetch;
  /** 请求超时 ms（缺省 15s——embedding 是同步链路，不能拖死管家轮）。 */
  readonly timeoutMs?: number;
}

/** 响应面协议形态校验（data 数组 + 逐项 embedding 数值数组）。 */
function parseResponse(raw: unknown): Float32Array[] {
  if (typeof raw !== "object" || raw === null) throw new Error("响应非 JSON 对象");
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) throw new Error("响应缺 data 数组");
  return data.map((item, i) => {
    const embedding = (item as { embedding?: unknown })?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((n) => typeof n === "number")) {
      throw new Error(`响应 data[${i}].embedding 形态非法（应为非空数值数组）`);
    }
    return Float32Array.from(embedding as number[]);
  });
}

export class OpenAiCompatEmbeddingAdapter implements EmbeddingPort {
  private readonly deps: OpenAiCompatEmbeddingDeps;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(deps: OpenAiCompatEmbeddingDeps) {
    this.deps = deps;
    this.doFetch = deps.fetch ?? fetch;
    this.timeoutMs = deps.timeoutMs ?? 15_000;
  }

  endpointLabel(): string {
    const cfg = this.deps.getConfig();
    if (cfg === null) return "未配置";
    try {
      return `${cfg.model} @ ${new URL(cfg.baseUrl).host}`;
    } catch {
      return `${cfg.model} @ ${cfg.baseUrl}`;
    }
  }

  async embed(texts: readonly string[]): Promise<EmbeddingResult> {
    const cfg = this.deps.getConfig();
    if (cfg === null) {
      throw new Error("嵌入端点未配置（设置 → 通用 → 长期记忆）");
    }
    if (texts.length === 0) return { vectors: [], dim: 0 };
    const url = `${cfg.baseUrl.replace(/\/+$/, "")}/embeddings`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cfg.apiKey !== undefined && cfg.apiKey !== "") {
      headers.authorization = `Bearer ${cfg.apiKey}`;
    }
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: cfg.model, input: [...texts] }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`嵌入端点不可达（${url}）：${(err as Error).message}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`嵌入端点 HTTP ${response.status}（${url}）：${body.slice(0, 200)}`);
    }
    let vectors: Float32Array[];
    try {
      vectors = parseResponse(await response.json());
    } catch (err) {
      throw new Error(`嵌入端点响应协议异常：${(err as Error).message}`);
    }
    if (vectors.length !== texts.length) {
      throw new Error(`嵌入端点返回数量不符（请求 ${texts.length} 条，返回 ${vectors.length} 条）`);
    }
    const dim = vectors[0]!.length;
    if (!vectors.every((v) => v.length === dim)) {
      throw new Error("嵌入端点返回向量维度不齐");
    }
    return { vectors, dim };
  }
}
