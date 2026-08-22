/**
 * 轻量 i18n（desk shared/i18n 方案裁剪搬运：React context + localStorage +
 * navigator.language；词条裁剪为 P-1 所需 40+ key，AD-18）。
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Translations } from "./lang/zh-CN";
import { zhCN } from "./lang/zh-CN";
import { enUS } from "./lang/en-US";

/** 语言代码（T1.1：自 types.ts 迁入）。 */
export type Lang = "zh-CN" | "en-US";

/** Translations 单一事实源在 lang/zh-CN.ts（typeof zhCN，T1.1）；此处为消费面 re-export 单点。 */
export type { Translations };

const TRANSLATIONS: Record<Lang, Translations> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

/** 语言持久化键（AG-14 localStorage 白名单成员）。 */
const STORAGE_KEY = "helix-lang";

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as Lang | null;
    if (saved && saved in TRANSLATIONS) return saved;
  } catch {
    /* localStorage 不可用时退回探测 */
  }
  return navigator.language.startsWith("zh") ? "zh-CN" : "en-US";
}

function getValue(obj: unknown, path: string): string | undefined {
  let current: unknown = obj;
  for (const part of path.split(".")) {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === "string" ? current : undefined;
}

/** 取词：缺 key 回退 key 本身（DEV 警告）；{var} 插值。 */
export function t(
  translations: Translations,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const value = getValue(translations, key);
  if (!value) {
    if (import.meta.env.DEV) console.warn(`[i18n] missing key: ${key}`);
    return key;
  }
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const v = vars[name];
    return v !== undefined ? String(v) : `{${name}}`;
  });
}

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* 持久化失败静默（会话内仍生效） */
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const tx = useCallback(
    (key: string, vars?: Record<string, string | number>) =>
      t(TRANSLATIONS[lang], key, vars),
    [lang],
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, t: tx }}>{children}</I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
