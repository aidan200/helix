/**
 * 图片治理管线（图片治理批，docs/temp/image-governance-design.md）：
 * 工具下行图片（read 读图 / browser 截图）进模型上下文前的统一降采样。
 *
 * 设计裁决（2026-11-13 用户拍板）：
 * - 长边 > 1536 → lanczos3 缩到 1536 长边；无 alpha 转 JPEG q85 / 带 alpha
 *   转 WebP q85（JPEG 丢透明；主流 vision 端点均收 webp）
 * - GIF（动图语义）与小图（<200KB 且长边 ≤1536）直通（返回 null）
 * - best-effort：sharp 加载失败 / 解码异常 → null（调用方原图直通 + 上层
 *   WARN 一次），治理绝不挡工具执行（与 kg 韧性批同哲学）
 * - sharp 动态 import（硬依赖已装，动态面只为失败降级路径留口）
 *
 * 实测基准（事故会话真实截图 1918×1079 PNG 1704KB）：1536 JPEG85 =
 * 101KB（17×），28ms。vision 模型按分辨率 tile 计价，1918→1536 宽 tile
 * 数 12→6（token 减半）；base64 缩 17× 直接改善缓存前缀稳定性。
 */

/** 降采样产物：新字节 + 目标 mime + 模型可读事实注记。 */
export interface DownscaleOutcome {
  readonly bytes: Uint8Array;
  readonly mimeType: "image/jpeg" | "image/webp";
  /** 中文注记（注入 text 块）：模型可感知降采样事实，需要原图细节可转 bash。 */
  readonly note: string;
}

/** 触发降采样的长边阈值（主流 vision tile 上限 1024–2048 的安全中值）。 */
export const DOWNSCALE_MAX_EDGE = 1536;

/** 小图直通阈值：字节 < 200KB 且长边 ≤ 阈值 → 不动（治理收益趋零）。 */
const SMALL_BYTES = 200 * 1024;

const kb = (n: number): string => `${Math.round(n / 1024)}KB`;

type SharpInstance = {
  metadata(): Promise<{ width?: number; height?: number; hasAlpha?: boolean }>;
  resize(o: { width?: number; height?: number }): SharpInstance;
  jpeg(o: { quality: number }): { toBuffer(): Promise<Buffer> };
  webp(o: { quality: number }): { toBuffer(): Promise<Buffer> };
};

/**
 * 降采样图片为模型上下文友好形态。
 *
 * @returns null = 无需处理（GIF/小图）或处理失败（调用方原图直通）；
 *          非 null = 用产物替换原 image 块字节与 mimeType。
 */
export async function downscaleForContext(
  bytes: Uint8Array,
  mimeType: string,
): Promise<DownscaleOutcome | null> {
  if (mimeType === "image/gif") return null; // 动图语义不动
  let sharpFactory: (b: Uint8Array) => SharpInstance;
  try {
    const mod = (await import("sharp")) as unknown as { default: (b: Uint8Array) => SharpInstance };
    sharpFactory = mod.default;
  } catch {
    return null; // sharp 不可用（平台异常）→ 原图直通
  }
  try {
    const inst = sharpFactory(bytes);
    const meta = await inst.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width <= 0 || height <= 0) return null;
    const longEdge = Math.max(width, height);
    if (longEdge <= DOWNSCALE_MAX_EDGE && bytes.byteLength < SMALL_BYTES) return null; // 小图直通
    const target = longEdge <= DOWNSCALE_MAX_EDGE ? null : DOWNSCALE_MAX_EDGE;
    const hasAlpha = meta.hasAlpha === true;
    const pipeline = target === null ? inst : longEdge === width ? inst.resize({ width: target }) : inst.resize({ height: target });
    const encoded = hasAlpha
      ? await pipeline.webp({ quality: 85 }).toBuffer()
      : await pipeline.jpeg({ quality: 85 }).toBuffer();
    const outMime = hasAlpha ? ("image/webp" as const) : ("image/jpeg" as const);
    // 元信息回读（真实产出尺寸——缩放比由实读保证而非推算）
    const outMeta = await sharpFactory(new Uint8Array(encoded)).metadata();
    const note = `已降采样 ${width}x${height} → ${outMeta.width}x${outMeta.height}（${mimeType} ${kb(
      bytes.byteLength,
    )} → ${outMime.replace("image/", "").toUpperCase()} ${kb(encoded.byteLength)}）`;
    return {
      bytes: new Uint8Array(encoded),
      mimeType: outMime,
      note,
    };
  } catch {
    return null; // 解码/编码异常 → 原图直通
  }
}
