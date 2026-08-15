/**
 * Tailwind v3 配置（tokens.md §13：自研 Cyber HUD，Tailwind 颜色一律走
 * `rgb(var(--x-rgb) / <alpha-value>)` 通道变量模式）。
 *
 * 注意（tokens.md §13 沿用 desk 裁决）：preflight 关闭，全局 reset 由
 * shared/ui/styles/app.css 自持有（原型组件契约的直接移植）。
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        accent: "rgb(var(--accent-rgb) / <alpha-value>)",
        violet: "rgb(var(--violet-rgb) / <alpha-value>)",
        ok: "rgb(var(--success-rgb) / <alpha-value>)",
        warn: "rgb(var(--warning-rgb) / <alpha-value>)",
        err: "rgb(var(--error-rgb) / <alpha-value>)",
        search: "rgb(var(--search-rgb) / <alpha-value>)",
        edge: "rgb(var(--edge-rgb) / <alpha-value>)",
        void: "rgb(var(--void-rgb) / <alpha-value>)",
        panel: "rgb(var(--panel-solid-rgb) / <alpha-value>)",
        ink: {
          DEFAULT: "rgb(var(--text-rgb) / <alpha-value>)",
          muted: "rgb(var(--text-muted-rgb) / <alpha-value>)",
          dim: "rgb(var(--text-dim-rgb) / <alpha-value>)",
          faint: "rgb(var(--text-faint-rgb) / <alpha-value>)",
        },
      },
      fontFamily: {
        mono: ["var(--font-mono)"],
        sans: ["var(--font-sans)"],
      },
      fontSize: {
        micro: ["var(--text-micro)", { lineHeight: "1.6" }],
        cap: ["var(--text-cap)", { lineHeight: "1.6" }],
        body: ["var(--text-body)", { lineHeight: "1.6" }],
        main: ["var(--text-main)", { lineHeight: "1.6" }],
        title: ["var(--text-title)", { lineHeight: "1.6" }],
        head: ["var(--text-head)", { lineHeight: "1.6" }],
        stat: ["var(--text-stat)", { lineHeight: "1.4" }],
      },
    },
  },
  plugins: [],
};
