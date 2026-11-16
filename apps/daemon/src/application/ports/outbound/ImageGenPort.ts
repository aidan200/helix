/**
 * ImageGenPort —— 图像生成渠道端口（多渠道生图批 v1）。
 *
 * 【存在理由】helix 的图片能力此前只有消费面（上行 vision 输入 + 工具
 * 结果图下行），无生成面。codex CLI 的「对话中直接生图」实证为工具通道
 * （内置 image_gen 工具 → OpenAI images 端点），非对话流原生 image 块
 * （pi-ai AssistantMessage.content 无 image 块）。本端口把「生图渠道」
 * 抽象为可枚举/可路由的多渠道注册表——v1 落 openai（gpt-image 系列）与
 * google（Nano Banana 系列）两渠道，后续渠道（xai 等）只扩 driven 实现。
 *
 * 【分层】port 在 application（六边形出站口）；渠道实现在 driven
 * （adapters/driven/imagegen/）；消费面 = generate_image 工具
 * （adapters/driven/tools/imagegen/）。认证单源 auth.json
 * （AD-2）：渠道实现注入凭据 getter 读现值，不碰 env（AG-08）。
 */

/** 参考图输入（图生图/编辑；base64 无 data URL 前缀 + mimeType）。 */
export interface ImageGenInputImage {
  readonly data: string;
  readonly mimeType: string;
}

/** 生图请求（渠道无关归一形状；渠道各自映射到自家 API 参数）。 */
export interface ImageGenRequest {
  /** 生成指令（必填非空；编辑场景 = 修改说明）。 */
  readonly prompt: string;
  /** 参考图（图生图/编辑；缺省 = 纯文生图）。 */
  readonly images?: readonly ImageGenInputImage[];
  /** 宽高比（"1:1" | "4:3" | "3:4" | "16:9" | "9:16"；缺省 1:1）。 */
  readonly aspectRatio?: string;
  /** 渠道内模型覆盖（缺省 = 渠道默认模型）。 */
  readonly model?: string;
}

/** 生成产物（base64 无前缀 + mimeType；与工具结果 image 块同形）。 */
export interface ImageGenOutputImage {
  readonly data: string;
  readonly mimeType: string;
}

/** 生图结果（渠道回执；images ≥1 或抛错）。 */
export interface ImageGenResult {
  readonly provider: string;
  readonly model: string;
  readonly images: readonly ImageGenOutputImage[];
}

/** 渠道可用性判定（注册序快照语义——auth.json 换 key 后下次调用生效）。 */
export type ImageGenAvailability = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** 生图渠道（一个 provider 一个实现；id 稳定可作路由键）。 */
export interface ImageGenChannel {
  readonly id: string;
  readonly label: string;
  available(): ImageGenAvailability;
  generate(request: ImageGenRequest): Promise<ImageGenResult>;
}

/** 生图出站端口（消费面 = generate_image 工具；路由语义见 ImageGenService）。 */
export interface ImageGenPort {
  readonly channels: readonly ImageGenChannel[];
  /** 当前可用渠道 id 清单（注册序——缺省路由的优先级序）。 */
  availableChannelIds(): readonly string[];
  generate(request: ImageGenRequest & { readonly channel?: string }): Promise<ImageGenResult>;
}
