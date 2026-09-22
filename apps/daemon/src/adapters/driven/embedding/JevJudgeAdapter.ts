/**
 * Jev 判官适配器（driven，管家记忆 B4a 批）。
 *
 * 协议面：POST {baseUrl}/systemone，body
 *   { state, model, questions: { q1: { type: "noul", instructions } } }，
 * 响应 { answers: { q1: { type: "noul", noul: number } } }（TypeSafe Jev
 * `/v1/systemone` 契约——实测 2026-09 契约：值字段以问题类型命名（noul），
 * 兼容读取 value 旧形态。单步判别，零生成 token）。
 *
 * 认证：Authorization: Bearer {apiKey}（Jev 是云 API——与 OpenAI 兼容
 * embedding 同款凭据形态，端点记录复用 EmbeddingEndpointConfig）。
 *
 * 配置面：getConfig 惰性读面注入（与 OpenAiCompatEmbeddingAdapter
 * 同构——改配置下一次调用自动跟随）。
 *
 * 失败语义：未配置/网络错/HTTP 非 2xx/协议形态异常一律抛错（消息含
 * 定位信息）——服务层捕获降级为「判官不可用」，不挡对话主链路。
 */

import type { JudgeEndpointConfig, JudgePort } from "../../../application/ports/outbound/JudgePort";

export interface JevJudgeAdapterDeps {
  /** 端点配置惰性读面（null = 未配置 → noul 抛错降级）。 */
  readonly getConfig: () => JudgeEndpointConfig | null;
  /** fetch 注入（测试桩；缺省全局 fetch）。 */
  readonly fetch?: typeof fetch;
  /** 请求超时 ms（缺省 15s）。 */
  readonly timeoutMs?: number;
}

/** 响应面协议形态校验（answers.{q}.noul 数值 ∈ [0,1]——校准概率；
 *  实测值字段以问题类型命名（noul），value 旧形态兼容读取）。 */
function parseNoul(raw: unknown, qid: string): number {
  if (typeof raw !== "object" || raw === null) throw new Error("判官响应非 JSON 对象");
  const answers = (raw as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null) throw new Error("判官响应缺 answers 对象");
  const answer = (answers as Record<string, { noul?: unknown; value?: unknown }>)[qid];
  if (answer === undefined) throw new Error(`判官响应缺 answers.${qid}`);
  const value = answer.noul ?? answer.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`判官响应 answers.${qid}.noul 形态非法（应为 [0,1] 数值）`);
  }
  return value;
}

export class JevJudgeAdapter implements JudgePort {
  private readonly deps: JevJudgeAdapterDeps;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(deps: JevJudgeAdapterDeps) {
    this.deps = deps;
    this.doFetch = deps.fetch ?? fetch;
    this.timeoutMs = deps.timeoutMs ?? 15_000;
  }

  endpointLabel(): string {
    const cfg = this.deps.getConfig();
    if (cfg === null) return "jev 未配置";
    const host = (() => {
      try {
        return new URL(cfg.baseUrl).host;
      } catch {
        return cfg.baseUrl;
      }
    })();
    return `jev/${cfg.model} @ ${host}`;
  }

  async noul(state: string, question: string): Promise<number> {
    const cfg = this.deps.getConfig();
    if (cfg === null) throw new Error("判官端点未配置");
    const qid = "q";
    let response: Response;
    try {
      response = await this.doFetch(`${cfg.baseUrl.replace(/\/+$/, "")}/systemone`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.apiKey !== undefined && cfg.apiKey !== "" ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          state,
          model: cfg.model,
          questions: { [qid]: { type: "noul", instructions: question } },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`判官请求失败：${(err as Error).message}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`判官 HTTP ${response.status}：${body.slice(0, 200)}`);
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new Error("判官响应非 JSON");
    }
    return parseNoul(raw, qid);
  }
}
