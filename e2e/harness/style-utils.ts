/**
 * 视觉断言工具 —— token 注册表变量派生值（test-design §4.3：不做像素 diff）。
 *
 * 口径：从 computed style 读 token 派生值（如 border-color 的
 * rgba(violet-rgb/0.2)），期望值由页面当前主题的通道变量实时组装——
 * 断言的是「实现取自 token 通道 + 注册表 alpha」这一关系，而非硬编码色值。
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** 读 documentElement 上的注册表变量（trim 后，如 "168 85 247"）。 */
export async function cssVar(page: Page, name: string, target?: string): Promise<string> {
  return page.evaluate(
    ({ varName, target: sel }) => {
      const el = sel ? document.querySelector(sel) : document.documentElement;
      return getComputedStyle(el!).getPropertyValue(varName).trim();
    },
    { varName: name, target: target ?? null },
  );
}

/** 通道变量 + alpha → 浏览器 computed 归一化色串（chromium 格式 rgba(r, g, b, a)）。 */
export function rgbaFromChannel(channel: string, alpha: number): string {
  const [r, g, b] = channel.trim().split(/\s+/).map(Number);
  const a = Number(alpha.toFixed(3)).toString();
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** 某元素某 computed 属性值。 */
export async function computed(page: Page, selector: string, prop: string): Promise<string> {
  return page.evaluate(
    ({ sel, p }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`computed(): no element for ${sel}`);
      return getComputedStyle(el).getPropertyValue(p).trim();
    },
    { sel: selector, p: prop },
  );
}

/** 伪元素 computed 属性（如 li::marker 的 color）。 */
export async function computedPseudo(
  page: Page,
  selector: string,
  pseudo: string,
  prop: string,
): Promise<string> {
  return page.evaluate(
    ({ sel, ps, p }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`computedPseudo(): no element for ${sel}`);
      return getComputedStyle(el, ps).getPropertyValue(p).trim();
    },
    { sel: selector, ps: pseudo, p: prop },
  );
}

/** border-radius 序列化值（1~4 值）→ 四角数值 [TL, TR, BR, BL]（序列化会省略等值角）。 */
export function radiusCorners(serialized: string): [number, number, number, number] {
  const parts = serialized.trim().split(/\s+/).map(parseFloat);
  switch (parts.length) {
    case 1: return [parts[0], parts[0], parts[0], parts[0]];
    case 2: return [parts[0], parts[1], parts[0], parts[1]];
    case 3: return [parts[0], parts[1], parts[2], parts[1]];
    case 4: return [parts[0], parts[1], parts[2], parts[3]] as [number, number, number, number];
    default: throw new Error(`unexpected radius: ${serialized}`);
  }
}

/** 断言边框色 = token 通道 + alpha（poll 收敛：工具卡边框有 0.2s transition）。 */
export async function expectBorderColor(
  page: import("@playwright/test").Page,
  selector: string,
  channelVar: string,
  alpha: number,
): Promise<void> {
  const expected = `rgba(${channelVar.split(/\s+/).join(", ")}, ${alpha})`;
  await expect
    .poll(
      () =>
        page.evaluate(
          (sel) => getComputedStyle(document.querySelector(sel)!).borderColor,
          selector,
        ),
      { timeout: 3_000 },
    )
    .toBe(expected);
}
