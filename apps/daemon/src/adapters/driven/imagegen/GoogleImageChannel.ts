import type { Credential } from "@earendil-works/pi-ai";
import type {
  ImageGenAvailability,
  ImageGenChannel,
  ImageGenRequest,
  ImageGenResult,
} from "../../../application/ports/outbound/ImageGenPort";

/**
 * GoogleImageChannel —— google 渠道（Nano Banana 系列；多渠道生图批 v1）。
 *
 * 端点：POST /v1beta/interactions（Generative Language interactions API，
 * header Api-Revision 钉版）——input 原生 text/image 混排（文生图与图生图/
 * 编辑同端点；编辑 = 文本指令 + 参考图，最多 14 张）。
 *
 * 认证：auth.json 单源（AD-2）——getCredential getter 读现值；仅 api_key
 * 形态可用（oauth 是 Vertex/GCP 域的事，不在本渠道范围）。
 *
 * 模型：缺省 gemini-nano-banana-2.1（主力工作马；配置 googleModel 覆盖 →
 * 请求 model 参数再覆盖——三档：gemini-3-pro-image 高质量 /
 * gemini-nano-banana-2.1 主力 / gemini-3.1-flash-lite-image 快省）。
 *
 * 宽高比：interactions response_format.aspect_ratio 原生直传（5 档白名单
 * 与 openai 渠道对齐；未知值不带该字段）。image_size 缺省 "1K"——成本与
 * 上下文体积极衡（4K 生成产物 base64 直进模型上下文，默认值保守）。
 */

export interface GoogleImageChannelOptions {
  /** auth.json 现值读面（google provider 凭据）。 */
  readonly getCredential: () => Credential | undefined;
  /** 配置面模型 getter（imagegen_config.googleModel；"" = 渠道内置默认）。 */
  readonly getModel?: () => string;
  /** API base（缺省官方；测试用）。 */
  readonly baseUrl?: string;
  /** fetch 注入（测试面；缺省全局 fetch）。 */
  readonly fetchImpl?: typeof fetch;
}

export const GOOGLE_IMAGE_DEFAULT_MODEL = "gemini-nano-banana-2.1";

const GENERATE_TIMEOUT_MS = 120_000;
const API_REVISION = "2026-05-20";

export function createGoogleImageChannel(options: GoogleImageChannelOptions): ImageGenChannel {
  const baseUrl = (options.baseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return {
    id: "google",
    label: "Google（Nano Banana 系列）",
    available(): ImageGenAvailability {
      const credential = options.getCredential();
      if (credential === undefined) {
        return { ok: false, reason: "未配置 google 凭据（设置 → 模型录入 API key）" };
      }
      if (credential.type === "oauth") {
        return { ok: false, reason: "oauth 登录态不在本渠道范围（需 Gemini API key）" };
      }
      if (credential.key === undefined || credential.key.trim() === "") {
        return { ok: false, reason: "google API key 为空（设置 → 模型重新录入）" };
      }
      return { ok: true };
    },
    async generate(request: ImageGenRequest): Promise<ImageGenResult> {
      const availability = this.available();
      if (!availability.ok) throw new Error(`google 渠道不可用：${availability.reason}`);
      const credential = options.getCredential();
      const configuredModel = options.getModel?.() ?? "";
      const model = request.model?.trim() || configuredModel.trim() || GOOGLE_IMAGE_DEFAULT_MODEL;

      const input: Array<Record<string, string>> = [{ type: "text", text: request.prompt }];
      for (const image of request.images ?? []) {
        input.push({ type: "image", mime_type: image.mimeType, data: image.data });
      }
      const body: Record<string, unknown> = { model, input };
      if (request.aspectRatio !== undefined) {
        body.response_format = { type: "image", aspect_ratio: request.aspectRatio, image_size: "1K" };
      } else {
        body.response_format = { type: "image", image_size: "1K" };
      }

      const response = await doFetch(`${baseUrl}/v1beta/interactions`, {
        method: "POST",
        headers: {
          "x-goog-api-key": credential?.key ?? "",
          "Content-Type": "application/json",
          "Api-Revision": API_REVISION,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      });
      const payload = (await response.json().catch(() => ({}))) as GoogleInteractionsResponse;
      if (!response.ok) {
        throw new Error(`google 渠道 HTTP ${response.status}：${payload.error?.message ?? "无错误详情"}`);
      }
      const outputs = payload.output_image ?? payload.interaction?.output_image;
      if (outputs?.data === undefined || outputs.data === "") {
        throw new Error("google 渠道响应无 output_image（模型可能拒绝该 prompt——换个措辞重试）");
      }
      return {
        provider: "google",
        model,
        images: [{ data: outputs.data, mimeType: outputs.mime_type ?? "image/png" }],
      };
    },
  };
}

/** interactions 响应（宽松形状——output_image 直挂或 interaction 内嵌两形态兼容）。 */
interface GoogleInteractionsResponse {
  output_image?: { data?: string; mime_type?: string };
  interaction?: { output_image?: { data?: string; mime_type?: string } };
  error?: { message?: string };
}
