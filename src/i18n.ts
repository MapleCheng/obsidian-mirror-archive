import en from "./locales/en.json";
import zhTW from "./locales/zh-TW.json";

export const LANGUAGE_OPTIONS = {
  SYSTEM: "system",
  EN: "en",
  ZH_TW: "zh-TW",
} as const;

export type LanguageSetting = (typeof LANGUAGE_OPTIONS)[keyof typeof LANGUAGE_OPTIONS];
export type EffectiveLanguage = Exclude<LanguageSetting, typeof LANGUAGE_OPTIONS.SYSTEM>;
export type TranslationKey = keyof typeof en;
export type TranslationDictionary = Record<TranslationKey, string>;

export const TRANSLATIONS: Record<EffectiveLanguage, TranslationDictionary> = {
  en,
  "zh-TW": zhTW,
};
