/**
 * SiliconFlow STT adapter（driven；语音输入批 V1 兜底 provider）。
 *
 * OpenAI 兼容 /audio/transcriptions（multipart form 上传音频文件；模型
 * FunAudioLLM/SenseVoiceSmall——中文优先快且便宜）。SenseVoice 无热词定制
 * 接口（设计 §3 查证）：AsrContext 的 hint 以 OpenAI 兼容 prompt 参数下发
 * （OpenAI 兼容面聊胜于无；terms 热词通道在此 provider 无下游形态）。
 *
 * key：组合根 getter（auth.json provider id "siliconflow"；对齐
 * model-provider.ts AuthStore getter 先例）。
 */
import type { SttPort, SttRequest, SttResult } from "../../../application/ports/outbound/SttPort";
import { DEFAULT_VOICE_MODEL_CONFIG } from "../../../application/voice/voiceModelConfig";

/** SiliconFlow OpenAI 兼容转写端点。 */
const SILICONFLOW_TRANSCRIPTIONS_ENDPOINT = "https://api.siliconflow.cn/v1/audio/transcriptions";

/** 兜底模型（中文优先 SenseVoice）。
 *  别名 = voiceModelConfig 默认值单源字段（模型配置接入 P0；getModel 可覆盖）。 */
export const SILICONFLOW_ASR_MODEL = DEFAULT_VOICE_MODEL_CONFIG.sttSiliconflowModel;

export const SILICONFLOW_PROVIDER_ID = "siliconflow";

/** base64 data URL → {bytes, mime}（纯函数；不依赖 fetch data URL 支持；容忍 codecs 等参数段）。 */
export function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const head = /^data:([^;,]+)/.exec(dataUrl);
  const payload = /;base64,([\s\S]+)$/.exec(dataUrl);
  if (head === null || payload === null) {
    throw new Error("音频载荷应为 base64 data URL（data:audio/…;base64,…）");
  }
  const mime = head[1] ?? "application/octet-stream";
  const bytes = Uint8Array.from(atob(payload[1] ?? ""), (c) => c.charCodeAt(0));
  return { bytes, mime };
}

export interface SiliconFlowSttDeps {
  /** 当前 provider key getter（组合根注入 authStore.apiKeyOf）。 */
  readonly getApiKey: () => string | undefined;
  /** 模型 id getter（可选——模型配置接入 P0；空/undefined 回落默认）。 */
  readonly getModel?: () => string | undefined;
  /** fetch 注入（测试 fetch 层断言用；缺省 globalThis.fetch）。 */
  readonly fetchFn?: typeof fetch;
}

export class SiliconFlowSttAdapter implements SttPort {
  readonly providerId = SILICONFLOW_PROVIDER_ID;
  private readonly getApiKey: () => string | undefined;
  private readonly getModel: (() => string | undefined) | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(deps: SiliconFlowSttDeps) {
    this.getApiKey = deps.getApiKey;
    this.getModel = deps.getModel;
    this.fetchFn = deps.fetchFn ?? (globalThis.fetch as typeof fetch);
  }

  /** 生效模型 id（配置值优先；空/未配回落默认常量）。 */
  private effectiveModel(): string {
    return this.getModel?.()?.trim() || SILICONFLOW_ASR_MODEL;
  }

  async transcribe(request: SttRequest): Promise<SttResult> {
    const apiKey = this.getApiKey();
    if (apiKey === undefined || apiKey === "") {
      throw new Error(
        `auth.json 中没有 provider "${SILICONFLOW_PROVIDER_ID}" 的 API key（请经设置页语音输入区 auth.set_key 录入）`,
      );
    }
    const { bytes, mime } = decodeDataUrl(request.audio);
    const ext = mime.startsWith("audio/webm") ? "webm" : mime.startsWith("audio/mp4") ? "mp4" : "wav";
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), `speech.${ext}`);
    form.append("model", this.effectiveModel());
    if (request.context.hint !== "") form.append("prompt", request.context.hint);
    if (request.language !== undefined) form.append("language", request.language);

    const res = await this.fetchFn(SILICONFLOW_TRANSCRIPTIONS_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    const parsed = (await res.json().catch(() => ({}))) as { text?: string; message?: string; error?: { message?: string } };
    if (!res.ok) {
      const reason = parsed.message ?? parsed.error?.message ?? "响应不可解析";
      throw new Error(`SiliconFlow 转写失败（HTTP ${res.status}）：${reason}`);
    }
    const text = parsed.text ?? "";
    if (text === "") throw new Error("SiliconFlow 转写返回空文本（音频过短或无法识别）");
    return { text, ...(request.language !== undefined ? { language: request.language } : {}) };
  }
}
