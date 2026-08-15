import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * cn()（desk shared/lib/utils.ts 搬运）。
 *
 * tailwind-merge 默认只认识内建字号档，自定义 text-micro/cap/body/main/
 * title/head/stat 需注册进 font-size 组，否则与 text-ink 等颜色类同框时被误吞。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        "text-micro",
        "text-cap",
        "text-body",
        "text-main",
        "text-title",
        "text-head",
        "text-stat",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
