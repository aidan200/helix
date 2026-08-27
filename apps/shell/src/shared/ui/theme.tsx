/**
 * 主题状态（tokens.md 13 节：暗 = :root 默认，亮 = html.light；
 * localStorage helix-theme 持久化，AG-14 白名单键）。
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

export type Theme = "dark" | "light";

/** 主题持久化键（AG-14 localStorage 白名单成员）。 */
export const THEME_STORAGE_KEY = "helix-theme";

export function detectTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** 首帧前同步应用（避免闪帧；main.tsx 渲染前调用一次）。 */
export function applyThemeInitial(): void {
  document.documentElement.classList.toggle("light", detectTheme() === "light");
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(detectTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("light", theme === "light");
    // W6e：主题提示回写（壳侧缓存为下次启动的窗口底色；纯浏览器 dev 无
    // 此挂载点时静默跳过——可选链降级，零形态分支）
    globalThis.helixThemeHint?.(theme);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* 持久化失败静默（会话内仍生效） */
    }
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
