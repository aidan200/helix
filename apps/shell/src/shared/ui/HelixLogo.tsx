/**
 * HelixLogo —— header 品牌位渐变 helix 图标（T5.2 用户裁决：替换 HELiX·2
 * 文字品牌位）。形态取双螺旋意象（两股交叉弧 + 三道横档）；渐变口径沿用
 * accent→violet token（prototype index 页标题渐变同口径），stopColor 走
 * var() 引用，暗/亮双主题随 token 切换自动适配，零新增色值。
 */
import { useId } from "react";

export interface HelixLogoProps {
  /** 边长（px，正方形 viewBox 缩放；header 品牌位默认 20） */
  size?: number;
}

const HelixLogo = function HelixLogo({ size = 20 }: HelixLogoProps = {}) {
  const gradientId = `helix-logo-gradient-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label="helix"
      data-brand-logo
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="4"
          y1="0"
          x2="20"
          y2="0"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--violet)" />
        </linearGradient>
      </defs>
      {/* 双股交叉弧（S 形互绕 = 双螺旋侧视意象） */}
      <path
        d="M6 3.5 C 15.5 7.5, 8.5 16.5, 18 20.5"
        stroke={`url(#${gradientId})`}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M18 3.5 C 8.5 7.5, 15.5 16.5, 6 20.5"
        stroke={`url(#${gradientId})`}
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* 三道横档（碱基对意象；中段最宽，上下收窄） */}
      <path
        d="M10.2 8.2 L 13.8 8.2"
        stroke={`url(#${gradientId})`}
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.85"
      />
      <path
        d="M9.2 12 L 14.8 12"
        stroke={`url(#${gradientId})`}
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.85"
      />
      <path
        d="M10.2 15.8 L 13.8 15.8"
        stroke={`url(#${gradientId})`}
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.85"
      />
    </svg>
  );
};

export default HelixLogo;
