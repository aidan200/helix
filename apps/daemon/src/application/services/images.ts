/**
 * 图片附件编解码（T9 图片上下行，设计裁决：全链 base64 data URL）。
 *
 * 纯函数无 IO、无状态（非 Service——application 核心共享工具，供多域消费）：
 * - parseDataUrlImages：上行入口校验 + 解码（数量/格式/尺寸三防护，超限抛
 *   中文 Error——ChatService 消息发送前调用，错误直达用户）；
 * - imageDataUrl：下行组装（ImageContent 形状 → data URL，工具截图回填用）。
 * 消费面：ChatService（本层）/ AgentRuntime 与 FakeAgentEngine（引擎面双
 * 实现同源解码——pi-engine runtime 受 arch 约束不 import domain，故落
 * application 核心）/ BrowserTools 与 CoreToolExecutor（下行截图提取）。
 * 单一编解码源，防双实现漂移。
 */
import type { ErrorCode } from "@helix/protocol";

/** 单条消息图片上限（协议 v0.10 ChatSendPayload.images 约束）。 */
export const MAX_IMAGES_PER_MESSAGE = 4;

/** 单张图片解码后字节上限（2MB）。 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** 合法图片 mimeType（pi ImageContent 支持集，read 工具同源口径）。 */
const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"] as const;

/** data URL 形状：`data:<mime>;base64,<payload>`（payload 为合法 base64 字符）。 */
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|gif|webp|bmp));base64,([A-Za-z0-9+/=]+)$/;

/** 解码后的图片（base64 数据 + mimeType；≡ pi ImageContent 去掉 type 标签）。 */
export interface DecodedImage {
  readonly mimeType: string;
  /** base64 编码字节（不解码为二进制——pi ImageContent 即此形状） */
  readonly data: string;
}

/**
 * 图片附件校验错误（T9）：超限/坏格式/超大/生成中带图。中文文案直达用户
 * ——WS handler 据 code 判别转 connection.error 点对点回执（同
 * SteerTargetNotRunningError 先例，TR-AD-21 形态；T1.5 additive code 判别
 * 契约，err.name 字符串判别退役）。
 */
export class ImageValidationError extends Error {
  /** 错误码（T1.5）：值 = 既有回码映射，判别契约从 name 字符串改码匹配。 */
  readonly code: ErrorCode = "command.invalid_payload";
  constructor(message: string) {
    super(message);
    this.name = "ImageValidationError";
  }
}

/** base64 字符串的解码后字节数（padding 折算；无需真实解码，长度推导）。 */
export function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/**
 * 上行校验 + 解码（T9）：数量 ≤4、逐张 data URL 合法（image/* + base64）、
 * 单张解码后 ≤2MB——任一不满足抛中文 Error（消息不落盘、引擎不驱动）。
 */
export function parseDataUrlImages(images: readonly string[]): DecodedImage[] {
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    throw new ImageValidationError(
      `图片附件最多 ${MAX_IMAGES_PER_MESSAGE} 张（收到 ${images.length} 张）`,
    );
  }
  const out: DecodedImage[] = [];
  for (const [index, url] of images.entries()) {
    const match = url.match(DATA_URL_RE);
    if (!match || match[1] === undefined || match[2] === undefined) {
      throw new ImageValidationError(
        `第 ${index + 1} 张图片不是合法的 base64 data URL（应为 data:image/…;base64,… 形式）`,
      );
    }
    const { 1: mimeType, 2: data } = match;
    const bytes = base64ByteLength(data);
    if (bytes > MAX_IMAGE_BYTES) {
      throw new ImageValidationError(
        `第 ${index + 1} 张图片超过 ${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(0)}MB 上限（解码后约 ${bytes} 字节）`,
      );
    }
    out.push({ mimeType, data });
  }
  return out;
}

/** 下行组装：base64 数据 + mimeType → data URL（工具截图等回填 images 用）。 */
export function imageDataUrl(image: DecodedImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

/**
 * 下行提取（T9）：工具结果 content 块中的 image 块 → data URL 数组
 * （pi AgentToolResult.content = (TextContent | ImageContent)[]；CoreToolExecutor
 * 执行面与 PiAgentEngineAdapter 事件面同源提取——文本拼接 textOfResult
 * 不动，图片另走 images 通道）。
 */
export function imagesOfContent(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (b?.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
      out.push(`data:${b.mimeType};base64,${b.data}`);
    }
  }
  return out;
}

export { IMAGE_MIME_TYPES };
