/**
 * DashScope STT adapter（driven；语音输入批 V1 主选 provider）。
 *
 * 模型 qwen-audio-3.0-asr-flash（Phase 0 查证主选：即时热词 ≤2000 词内联
 * + 上下文增强 ≤400 字符/轮双通道叠加、免费热词；计费 0.00022 元/秒）。
 *
 * 请求形态（官方 demo `recognize_speech_qwen-audio_3.0_asr_flash/python/run.py`
 * 精确对齐，本地取证 docs/temp/spike-dashscope/demo/qwen3_asr_flash_http.py）：
 * - 前置 user 消息 `content:[{type:"input_text",text}]` 承载上下文词表
 *   （≤400 字符静默截断——VocabularyBuilder 350 预算即为此设计）；
 * - 末位 user 消息 `content:[{type:"input_audio",input_audio:{data}}]` 承载
 *   音频（data URL 形态，与 qwen-vl 图片 base64 先例同构）；
 * - 即时热词 `parameters.vocabulary = {词: weight}`（weight [1,5]，免费、
 *   纯请求期内联——契合「不落地不常驻」）。
 *
 * key：组合根 getter（auth.json provider id "dashscope"，对齐
 * model-provider.ts explicitGetApiKey 先例——换 key 后自动跟随）；缺 key
 * fail-fast 抛中文错误（指向设置页 auth.set_key 录入路径）。
 *
 * 端点：通用域名 dashscope.aliyuncs.com（文档称仍可用；workspace 专属域名
 * 为文档推荐形态——通用域名可用性属真实冒烟待验项，见批次收口报告
 * deferred 清单）。
 */
import type { SttPort, SttRequest, SttResult } from "../../../application/ports/outbound/SttPort";

/** DashScope 多模态生成端点（通用域名）。 */
const DASHSCOPE_MULTIMODAL_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

/** V1 主选 ASR 模型（qwen-audio-3.0-asr-flash：即时热词 + 上下文双通道）。 */
export const DASHSCOPE_ASR_MODEL = "qwen-audio-3.0-asr-flash";

/** auth.json provider id（设置页 key 录入的 provider 位）。 */
export const DASHSCOPE_PROVIDER_ID = "dashscope";

/** data URL mime → DashScope parameters.format（容器格式声明）。 */
function formatOfMime(mime: string): string {
  if (mime.startsWith("audio/webm")) return "webm";
  if (mime.startsWith("audio/mp4") || mime.startsWith("audio/m4a")) return "mp4";
  if (mime.startsWith("audio/wav")) return "wav";
  if (mime.startsWith("audio/mp3")) return "mp3";
  return "webm"; // 兜底（MediaRecorder 首选 webm/opus——spike 实测支持面）
}

/** DashScope 错误体（HTTP 非 2xx 时 body 携带；request_id 供排查）。 */
interface DashScopeErrorBody {
  code?: string;
  message?: string;
  request_id?: string;
}

/** DashScope 成功体（text 直挂 output 或多模态 choices 形态——demo extract_text 双轨）。 */
interface DashScopeOkBody {
  output?: {
    text?: string;
    choices?: { message?: { content?: { text?: string }[] } }[];
  };
  code?: string;
  message?: string;
}

export interface DashScopeSttDeps {
  /** 当前 provider key getter（组合根注入 authStore.apiKeyOf；每次调用重读）。 */
  readonly getApiKey: () => string | undefined;
  /** fetch 注入（测试 fetch 层断言用；缺省 globalThis.fetch）。 */
  readonly fetchFn?: typeof fetch;
}

export class DashScopeSttAdapter implements SttPort {
  readonly providerId = DASHSCOPE_PROVIDER_ID;
  private readonly getApiKey: () => string | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(deps: DashScopeSttDeps) {
    this.getApiKey = deps.getApiKey;
    this.fetchFn = deps.fetchFn ?? (globalThis.fetch as typeof fetch);
  }

  async transcribe(request: SttRequest): Promise<SttResult> {
    const apiKey = this.getApiKey();
    if (apiKey === undefined || apiKey === "") {
      throw new Error(
        `auth.json 中没有 provider "${DASHSCOPE_PROVIDER_ID}" 的 API key（请经设置页语音输入区 auth.set_key 录入；显式传入，不走环境变量）`,
      );
    }

    const mime = request.audio.slice(5, request.audio.indexOf(";"));
    // 双通道注入（设计 §5.6）：前置 input_text 消息（上下文增强）+ 即时热词
    const messages: unknown[] = [];
    if (request.context.hint !== "") {
      messages.push({
        role: "user",
        content: [{ type: "input_text", text: request.context.hint }],
      });
    }
    messages.push({
      role: "user",
      content: [{ type: "input_audio", input_audio: { data: request.audio } }],
    });
    const vocabulary: Record<string, number> = {};
    for (const t of request.context.terms) vocabulary[t.term] = t.weight;
    const body: Record<string, unknown> = {
      model: DASHSCOPE_ASR_MODEL,
      input: { messages },
      parameters: {
        format: formatOfMime(mime),
        ...(Object.keys(vocabulary).length > 0 ? { vocabulary } : {}),
        ...(request.language !== undefined ? { language: request.language } : {}),
      },
    };

    const res = await this.fetchFn(DASHSCOPE_MULTIMODAL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-SSE": "disable",
      },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => ({}))) as DashScopeOkBody & DashScopeErrorBody;
    if (!res.ok) {
      throw new Error(
        `DashScope 转写失败（HTTP ${res.status}${parsed.code !== undefined ? ` ${parsed.code}` : ""}）：${parsed.message ?? "响应不可解析"}`,
      );
    }
    if (parsed.code !== undefined) {
      // 200 + 业务错误码形态（DashScope 部分错误走 200 体）
      throw new Error(`DashScope 转写失败（${parsed.code}）：${parsed.message ?? "未知错误"}`);
    }
    // 双轨文本提取（demo extract_text 同构：output.text 优先，多模态 choices 兜底）
    const text =
      parsed.output?.text ??
      parsed.output?.choices?.[0]?.message?.content?.[0]?.text ??
      "";
    if (text === "") {
      throw new Error("DashScope 转写返回空文本（音频过短或无法识别）");
    }
    return { text, ...(request.language !== undefined ? { language: request.language } : {}) };
  }
}
