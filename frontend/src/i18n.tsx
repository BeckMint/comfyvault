import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Lang = "zh" | "en";

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  toggleLang: () => void;
  t: (zh: string, en: string) => string;
}

const I18nContext = createContext<I18nContextValue>({
  lang: "zh",
  setLang: () => {},
  toggleLang: () => {},
  t: (zh) => zh,
});

function getInitialLang(): Lang {
  try {
    const saved = localStorage.getItem("comfyvault_lang");
    if (saved === "zh" || saved === "en") return saved;
    if (typeof navigator !== "undefined" && !navigator.language.toLowerCase().startsWith("zh")) {
      return "en";
    }
  } catch {
    // ignore
  }
  return "zh";
}

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Lang>(getInitialLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem("comfyvault_lang", next);
    } catch {
      // ignore
    }
  }, []);

  const toggleLang = useCallback(() => {
    setLang(lang === "zh" ? "en" : "zh");
  }, [lang, setLang]);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  const t = useCallback((zh: string, en: string) => (lang === "zh" ? zh : en), [lang]);

  return <I18nContext.Provider value={{ lang, setLang, toggleLang, t }}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
