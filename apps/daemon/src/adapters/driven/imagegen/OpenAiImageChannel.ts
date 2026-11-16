import type { Credential } from "@earendil-works/pi-ai";
import type {
  ImageGenAvailability,
  ImageGenChannel,
  ImageGenRequest,
  ImageGenResult,
} from "../../../application/ports/outbound/ImageGenPort";

/**
 * OpenAiImageChannel —— openai 渠道（gpt-image 系列；多渠道生图批 v1）。
 *
 * 端点：text-to-image = POST /v1/images/generations（json）；
 * 图生图/编辑（images 入参）= POST /v1/images/edits（multipart FormData
 * image[] 字段——gpt-image 系列多参考图官方形态）。
 *
 * 认证：auth.json 单源（AD-2）——getCredential getter 读现值（换 key 下次
 * 生效）；仅 api_key 形态可用（oauth 订阅登录态不覆盖 images 端点——
 * codex 内置通道走 ChatGPT 后端是它自家的事，API 直连必须 key）。
 *
 * 模型：缺省 gpt-image-1.5（配置 openaiModel 覆盖 → 请求 model 参数再覆盖）。
 * 宽高比映射：gpt-image 正档仅 1024²/1536x1024/1024x1536——16:9/9:16 取
 * 最接近的 3:2/2:3（近似，note 注记教 LLM/用户真相）；未知值不带 size。
 */

export interface OpenAiImageChannelOptions {
  /** auth.json 现值读面（openai provider 凭据）。 */
  readonly getCredential: () => Credential | undefined;
  /** 配置面模型 getter（imagegen_config.openaiModel；"" = 渠道内置默认）。 */
  readonly getModel?: () => string;
  /** API base（缺省官方；测试/代理用）。 */
  readonly baseUrl?: string;
  /** fetch 注入（测试面；缺省全局 fetch）。 */
  readonly fetchImpl?: typeof fetch;
}

/** gpt-image 系列宽高比 → size 档位（16:9/9:16 无精确档——最接近近似）。 */
export const OPENAI_SIZE_BY_RATIO: Readonly<Record<string, string>> = {
  "1:1": "1024x1024",
  "4:3": "1536x1024",
  "3:4": "1024x1536",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
};

export const OPENAI_IMAGE_DEFAULT_MODEL = "gpt-image-1.5";

const GENERATE_TIMEOUT_MS = 120_000;

/** gpt-image 不支持精确 16:9/9:16 的注记（教真相——比例是近似档）。 */
const APPROXIMATE_RATIOS = new Set(["16:9", "9:16"]);

export function createOpenAiImageChannel(options: OpenAiImageChannelOptions): ImageGenChannel {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return {
    id: "openai",
    label: "OpenAI（gpt-image 系列）",
    available(): ImageGenAvailability {
      const credential = options.getCredential();
      if (credential === undefined) {
        return { ok: false, reason: "未配置 openai 凭据（设置 → 模型录入 API key）" };
      }
      if (credential.type === "oauth") {
        return { ok: false, reason: "oauth 订阅登录态不支持图像生成端点（需 API key）" };
      }
      if (credential.key === undefined || credential.key.trim() === "") {
        return { ok: false, reason: "openai API key 为空（设置 → 模型重新录入）" };
      }
      return { ok: true };
    },
    async generate(request: ImageGenRequest): Promise<ImageGenResult> {
      const credential = options.getCredential();
      const availability = this.available();
      if (!availability.ok) throw new Error(`openai 渠道不可用：${availability.reason}`);
      const configuredModel = options.getModel?.() ?? "";
      const model = request.model?.trim() || configuredModel.trim() || OPENAI_IMAGE_DEFAULT_MODEL;
      const headers: Record<string, string> = { Authorization: `Bearer ${credential?.key ?? ""}` };
      const size = request.aspectRatio !== undefined ? OPENAI_SIZE_BY_RATIO[request.aspectRatio] : undefined;

      let response: Response;
      if (request.images === undefined || request.images.length === 0) {
        // 文生图：json 端点（n 固定 1——成本护栏，多张让模型多次调用）
        response = await doFetch(`${baseUrl}/v1/images/generations`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ model, prompt: request.prompt, ...(size !== undefined ? { size } : {}), n: 1 }),
          signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
        });
      } else {
        // 图生图/编辑：multipart 端点（image[] 数组字段——gpt-image 多参考图官方形态）
        const form = new FormData();
        form.append("model", model);
        form.append("prompt", request.prompt);
        if (size !== undefined) form.append("size", size);
        for (const [i, image] of request.images.entries()) {
          form.append("image[]", new Blob([Buffer.from(image.data, "base64")], { type: image.mimeType }), `ref-${i}.png`);
        }
        response = await doFetch(`${baseUrl}/v1/images/edits`, {
          method: "POST",
          headers,
          body: form,
          signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
        });
      }
      const body = (await response.json().catch(() => ({}))) as OpenAiImagesResponse;
      if (!response.ok) {
        throw new Error(`openai 渠道 HTTP ${response.status}：${body.error?.message ?? "无错误详情"}`);
      }
      const outputs = body.data?.filter((d) => d.b64_json !== undefined) ?? [];
      if (outputs.length === 0) {
        throw new Error(
          "openai 渠道响应无 b64_json（url-only 返回是 dall-e 系行为——请用 gpt-image 系列模型）",
        );
      }
      return {
        provider: "openai",
        model,
        images: outputs.map((d) => ({ data: d.b64_json as string, mimeType: d.mime_type ?? "image/png" })),
      };
    },
  };
}

/** openai images 端点响应（宽松形状——b64_json 为 gpt-image 系列回传面）。 */
interface OpenAiImagesResponse {
  data?: Array<{ b64_json?: string; mime_type?: string }>;
  error?: { message?: string };
}

export { APPROXIMATE_RATIOS as OPENAI_APPROXIMATE_RATIOS };
