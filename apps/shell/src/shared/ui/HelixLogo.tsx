/**
 * HelixLogo —— header 品牌位图标（试装：32×32 像素稿 logo.png 替换原
 * accent→violet 渐变 SVG 双螺旋——原 SVG 形态见 git 历史，T5.2 渐变
 * token 口径随之退役）。像素风图以 image-rendering: pixelated 防缩放
 * 模糊；固定色位图不随主题 token 变色，暗/亮双主题均直出（验收需双
 * 主题各看一眼）。
 */
import logoPng from "./assets/logo.png";

export interface HelixLogoProps {
  /** 边长（px，正方形缩放；header 品牌位默认 20） */
  size?: number;
}

const HelixLogo = function HelixLogo({ size = 20 }: HelixLogoProps = {}) {
  return (
    <img
      src={logoPng}
      width={size}
      height={size}
      alt="helix"
      data-brand-logo
      style={{ imageRendering: "pixelated", display: "block" }}
    />
  );
};

export default HelixLogo;
