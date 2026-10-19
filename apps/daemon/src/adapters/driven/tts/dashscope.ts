/**
 * DashScope TTS adapter（driven；语音播报批 V2 主选 provider）。
 *
 * 模型 qwen3-tts-flash（0.8 元/万字符，非实时系稳定版；端点/参数/响应形态
 * 经真实 key 冒烟钉死——docs/temp/tts-smoke/）：
 * - OpenAI 兼容端点 /compatible-mode/v1/audio/speech 已 404 证伪（任务
 *   brief 候选推翻）；Qwen-TTS 走原生 multimodal-generation 端点（通用
 *   dashscope.aliyuncs.com 域名，无需 workspace 子域）。
 * - 非流式两步链：① POST 生成（body {model, input:{text, voice,
 *   language_type}}）→ 200 响应 output.audio.url（OSS WAV 签名 URL，24h
 *   有效）→ ② GET 下载（签名公开可下，无鉴权头）→ WAV 16bit/24kHz mono
 *   → base64 data URL 返回。
 * - SSE 流式（base64 PCM 逐段）与 WS 任务协议留 V3：本 adapter 聚合为
 *   整段返回，TtsPort 接口两种后端均可实现。
 *
 * 错误双轨（冒烟实测）：HTTP 非 2xx 带 {code, message, request_id}（400
 * InvalidParameter / 401 InvalidApiKey）；DashScope 部分错误走 200 体携带
 * code——两轨统一上抛中文错误（stt adapter 同构）。
 *
 * key：组合根 getter（auth.json provider id "dashscope"，与 STT 共用条目
 * ——对齐 model-provider.ts explicitGetApiKey 先例）；缺 key fail-fast 抛
 * 中文错误（指向设置页 auth.set_key 录入路径）。
 */
import type { TtsPort, TtsRequest, TtsResult } from "../../../application/ports/outbound/TtsPort";
import { DEFAULT_VOICE_MODEL_CONFIG } from "../../../application/voice/voiceModelConfig";

/** DashScope 多模态生成端点（通用域名；Qwen-TTS 非实时族官方端点）。 */
const DASHSCOPE_MULTIMODAL_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

/** V2 主选 TTS 模型（qwen3-tts-flash：非实时系稳定版，0.8 元/万字符）。
 *  别名 = voiceModelConfig 默认值单源字段（模型配置接入 P0；getModel 可覆盖）。 */
export const DASHSCOPE_TTS_MODEL = DEFAULT_VOICE_MODEL_CONFIG.ttsModel;

/** 默认音色（Cherry——女声，官方示例音色；中文播报基线）。 */
export const DASHSCOPE_TTS_DEFAULT_VOICE = "Cherry";

/** 单次 HTTP 超时（F2 #26）：生成与音频下载两处 fetch 都必须可中断——任一环节
 *  挂起即播报链永久悬挂（不落 onError，shell 侧听不到任何收口）。 */
const TTS_HTTP_TIMEOUT_MS = 30_000;

/** auth.json provider id（与 STT 共用同一条目）。 */
export const DASHSCOPE_PROVIDER_ID = "dashscope";

/** DashScope 错误体（HTTP 非 2xx / 200 体携带；request_id 供排查）。 */
interface DashScopeErrorBody {
  code?: string;
  message?: string;
  request_id?: string;
}

/** 生成端点成功体（冒烟实测形态：output.audio.url + finish_reason）。 */
interface DashScopeTtsOkBody {
  output?: {
    audio?: {
      data?: string;
      url?: string;
      expires_at?: number;
    };
    finish_reason?: string;
  };
  usage?: { characters?: number };
  code?: string;
  message?: string;
}

export interface DashScopeTtsDeps {
  /** 当前 provider key getter（组合根注入 authStore.apiKeyOf；每次调用重读）。 */
  readonly getApiKey: () => string | undefined;
  /** 模型 id getter（可选——模型配置接入 P0；空/undefined 回落默认）。 */
  readonly getModel?: () => string | undefined;
  /** fetch 注入（测试 fetch 层断言用；缺省 globalThis.fetch）。 */
  readonly fetchFn?: typeof fetch;
}

export class DashScopeTtsAdapter implements TtsPort {
  readonly providerId = DASHSCOPE_PROVIDER_ID;
  private readonly getApiKey: () => string | undefined;
  private readonly getModel: (() => string | undefined) | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(deps: DashScopeTtsDeps) {
    this.getApiKey = deps.getApiKey;
    this.getModel = deps.getModel;
    this.fetchFn = deps.fetchFn ?? (globalThis.fetch as typeof fetch);
  }

  /** 生效模型 id（配置值优先；空/未配回落默认常量）。 */
  private effectiveModel(): string {
    return this.getModel?.()?.trim() || DASHSCOPE_TTS_MODEL;
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const apiKey = this.getApiKey();
    if (apiKey === undefined || apiKey === "") {
      throw new Error(
        `auth.json 中没有 provider "${DASHSCOPE_PROVIDER_ID}" 的 API key（请经设置页语音区 auth.set_key 录入；显式传入，不走环境变量）`,
      );
    }

    const body: Record<string, unknown> = {
      model: this.effectiveModel(),
      input: {
        text: request.text,
        voice: request.voice ?? DASHSCOPE_TTS_DEFAULT_VOICE,
        // 官方口径：与文本语种一致以获得正确发音语调（V2 播报恒中文）
        language_type: request.language ?? "zh",
      },
    };

    const res = await this.fetchFn(DASHSCOPE_MULTIMODAL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TTS_HTTP_TIMEOUT_MS),
    });
    const parsed = (await res.json().catch(() => ({}))) as DashScopeTtsOkBody & DashScopeErrorBody;
    if (!res.ok) {
      throw new Error(
        `DashScope 语音合成失败（HTTP ${res.status}${parsed.code !== undefined ? ` ${parsed.code}` : ""}）：${parsed.message ?? "响应不可解析"}`,
      );
    }
    if (parsed.code !== undefined) {
      // 200 + 业务错误码形态（DashScope 部分错误走 200 体——冒烟矩阵外防御，stt adapter 同构）
      throw new Error(`DashScope 语音合成失败（${parsed.code}）：${parsed.message ?? "未知错误"}`);
    }
    const audioUrl = parsed.output?.audio?.url;
    if (typeof audioUrl !== "string" || audioUrl === "") {
      throw new Error("DashScope 语音合成返回体无 output.audio.url（响应形态漂移，请核对 API 版本）");
    }

    // ② 下载音频（OSS 签名 URL 公开可下——http/https 均可，统一 https）
    const dl = await this.fetchFn(audioUrl.replace(/^http:/, "https:"), {
      method: "GET",
      signal: AbortSignal.timeout(TTS_HTTP_TIMEOUT_MS),
    });
    if (!dl.ok) {
      const detail = await dl.text().catch(() => "");
      throw new Error(
        `DashScope 合成音频下载失败（HTTP ${dl.status}）：${detail.slice(0, 200) || "响应不可解析"}`,
      );
    }
    const bytes = new Uint8Array(await dl.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error("DashScope 合成音频下载为空（0 字节）");
    }
    // WAV 容器（冒烟钉死：RIFF 16bit mono 24kHz）——data URL 供 shell Audio 直播
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return { audio: `data:audio/wav;base64,${btoa(binary)}` };
  }
}
