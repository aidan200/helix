/**
 * JS 侧主题 token 引用（desk shared/config/theme.ts 搬运）。
 *
 * 真源是 shared/ui/styles/tokens.css 的 :root / html.light 变量；
 * THEME_VAR 仅用于可解析 CSS 变量的 JS 上下文（inline style / gradient），
 * 不跟随主题的 JS-only 场景不要使用。
 */
export const THEME_VAR = {
  cyan: "var(--accent)",
  violet: "var(--violet)",
  ok: "var(--success)",
  warn: "var(--warning)",
  err: "var(--error)",
  inkFaint: "var(--text-faint)",
  inkDim: "var(--text-dim)",
} as const;
