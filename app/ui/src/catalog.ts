import type { Locale } from "../../../shared/locale";
import { S, type AppStrings } from "./strings";
import { S_ZH } from "./strings.zh-CN";

export const appCatalogs: Record<Locale, AppStrings> = { en: S, "zh-CN": S_ZH };
export const appStrings = (locale: Locale): AppStrings => appCatalogs[locale];
