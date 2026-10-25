import type { Locale } from "../../shared/locale";
import { EN, type Strings } from "./strings";
import { T_ZH } from "./strings.zh-CN";

export const viewerCatalogs: Record<Locale, Strings> = { en: EN, "zh-CN": T_ZH };
export const viewerStrings = (locale: Locale): Strings => viewerCatalogs[locale];
