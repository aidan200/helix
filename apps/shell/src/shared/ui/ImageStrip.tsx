/**
 * ImageStrip —— 图片缩略图行（T9 图片上下行共用渲染件）：
 * - 缩略图行：每张图一个缩略按钮（data URL 直载，无跨域问题）；
 * - 点击放大：lightbox 覆盖层（role=dialog aria-modal）承载大图；关闭面 =
 *   Esc / 点遮罩（大图本体点击不关——避免误触关掉正在看的图）；
 *   焦点契约：开层移焦到 dialog 容器，关层还原到开层前元素（无全量焦点圈，
 *   键盘 Tab 可走底页——低危保守取舍）。
 * - user 气泡（MessageEntryDto.images）与工具卡（ToolCallEntryDto.images）
 *   复用同一组件。
 * 纯展示纪律：数据只来自 props（data URL 数组），零 entities/session 依赖。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/shared/i18n";

interface ImageStripProps {
  /** base64 data URL 数组（协议 v0.10 images；空数组不渲染） */
  images: readonly string[];
}

const ImageStrip = function ImageStrip({ images }: ImageStripProps) {
  const { t } = useI18n();
  const [enlarged, setEnlarged] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  /** 开层前焦点元素（关层还原；null = 无还原面）。 */
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // lightbox 开层：Esc 关闭 + 焦点移入 dialog（关层回还焦点）。
  // 点遮罩关闭 = onClick 判 target===currentTarget（大图/内容点击不关）。
  useEffect(() => {
    if (enlarged === null) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEnlarged(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    };
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
          ref={dialogRef}
          className="img-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={t("chat.attach.enlarge")}
          tabIndex={-1}
          onClick={(e) => {
            // 点遮罩才关：大图本体（或未来内嵌内容）点击不关
            if (e.target === e.currentTarget) setEnlarged(null);
          }}
        >
          <img src={current} alt={t("chat.attach.imageAlt", { n: (enlarged ?? 0) + 1 })} />
        </div>
      )}
    </>
  );
};

export default ImageStrip;
