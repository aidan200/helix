/**
 * hotkey-combo —— 全局组合键纯逻辑面（B4；AG-14 零 React 零 IO——录制控件
 * 与注册面共用，steward-voice-machine 同构纯函数纪律）。
 *
 * 两件职责：
 * - captureCombo：录制态按键事件 → 裁决四态——修饰键单独按下（不完整组合，
 *   继续等）/ Esc（取消录制）/ 单键无修饰（拒收——组合键必须含修饰键
 *   ⌘/⌥/⇧/⌃ 至少其一 + 主键）/ 合法组合（定格回显串）；
 * - comboToAccel：回显串 → tauri-plugin-global-shortcut 注册 accel
 *   （⌘→CommandOrControl、⌥→Alt、⇧→Shift、⌃→Control；主键透传）。
 *
 * 回显串即存储串（localStorage 偏好原文）：macOS 优先、⌘ 显示（B4 批次
 * 钳制——Windows/Linux 快捷键适配细节另批）；修饰序恒 ⌘⌥⇧⌃（⌘⇧K 先例）。
 */

/** 修饰符符号（定序 ⌘⌥⇧⌃；与 captureCombo 组装序一致）。 */
const MOD_SYMBOLS = ["⌘", "⌥", "⇧", "⌃"] as const;

/** 修饰键 key 值（单独按下 = 组合不完整，不裁决不拒收）。 */
const MODIFIER_KEYS = new Set(["Meta", "Alt", "Shift", "Control"]);

/** 录制态按键裁决（四态互斥）。 */
export type ComboCapture =
  /** 修饰键单独按下：不完整组合，继续等待主键。 */
  | { readonly kind: "none" }
  /** Esc：取消录制（Esc 不可被录成组合键）。 */
  | { readonly kind: "cancel" }
  /** 单键（无修饰）拒收：主键已归一，供行内提示。 */
  | { readonly kind: "need-modifier"; readonly key: string }
  /** 合法组合：定格回显串（如「⌘⇧K」）。 */
  | { readonly kind: "combo"; readonly combo: string };

/** 按键事件最小面（KeyboardEvent 结构子集——纯函数可测面）。 */
export interface ComboKeyEvent {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
}

/** 主键归一：单字符大写 / 空格 → Space / 命名键原样。 */
function normalizeKey(key: string): string {
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key;
}

/** 录制态按键裁决（纯函数）。 */
export function captureCombo(e: ComboKeyEvent): ComboCapture {
  if (e.key === "Escape") return { kind: "cancel" };
  if (MODIFIER_KEYS.has(e.key)) return { kind: "none" };
  const key = normalizeKey(e.key);
  const mods: string[] = [];
  if (e.metaKey === true) mods.push("⌘");
  if (e.altKey === true) mods.push("⌥");
  if (e.shiftKey === true) mods.push("⇧");
  if (e.ctrlKey === true) mods.push("⌃");
  if (mods.length === 0) return { kind: "need-modifier", key };
  return { kind: "combo", combo: `${mods.join("")}${key}` };
}

/** 回显符号 → 注册 accel 修饰名。 */
const ACCEL_MODS: Readonly<Record<string, string>> = {
  "⌘": "CommandOrControl",
  "⌥": "Alt",
  "⇧": "Shift",
  "⌃": "Control",
};

/**
 * 回显串 → tauri-plugin-global-shortcut accel（如 "⌘⇧K" →
 * "CommandOrControl+Shift+K"）。非法串（空/无主键）原样低语境透传由
 * 注册面拒收交代——本函数不裁决合法性（captureCombo 已保证）。
 */
export function comboToAccel(combo: string): string {
  let i = 0;
  const mods: string[] = [];
  while (i < combo.length && MOD_SYMBOLS.includes(combo[i] as (typeof MOD_SYMBOLS)[number])) {
    mods.push(ACCEL_MODS[combo[i]!]!);
    i += 1;
  }
  const key = combo.slice(i);
  return [...mods, key].join("+");
}
