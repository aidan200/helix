/**
 * ImageStrip —— 图片缩略图行（T9 图片上下行共用渲染件）：
 * - 缩略图行：每张图一个缩略按钮（data URL 直载，无跨域问题）；
 * - 点击放大：lightbox 覆盖层（role=dialog）承载大图，Esc / 点遮罩关闭；
 * - user 气泡（MessageEntryDto.images）与工具卡（ToolCallEntryDto.images）
 *   复用同一组件。
 * 纯展示纪律：数据只来自 props（data URL 数组），零 entities/session 依赖。
 */
import { useEffect, useState } from "react";
import { useI18n } from "@/shared/i18n";

interface ImageStripProps {
  /** base64 data URL 数组（协议 v0.10 images；空数组不渲染） */
  images: readonly string[];
}

const ImageStrip = function ImageStrip({ images }: ImageStripProps) {
  const { t } = useI18n();
  const [enlarged, setEnlarged] = useState<number | null>(null);

  // lightbox 打开时 Esc 关闭（keydown 挂 dialog；点遮罩 = onClick 关闭）
  useEffect(() => {
    if (enlarged === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEnlarged(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enlarged]);

  if (images.length === 0) return null;
  const current = enlarged !== null ? images[enlarged] : undefined;

  return (
    <>
      <div className="img-strip">
        {images.map((src, i) => (
          <button
            key={i}
            type="button"
            className="img-thumb"
            aria-label={t("chat.attach.enlarge")}
            onClick={() => setEnlarged(i)}
          >
            <img src={src} alt={t("chat.attach.imageAlt", { n: i + 1 })} loading="lazy" />
          </button>
        ))}
      </div>
      {current !== undefined && (
        <div
          className="img-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={t("chat.attach.enlarge")}
          onClick={() => setEnlarged(null)}
        >
          <img src={current} alt={t("chat.attach.imageAlt", { n: (enlarged ?? 0) + 1 })} />
        </div>
      )}
    </>
  );
};

export default ImageStrip;
