/** Locale resolution shared by the desktop shell and exported viewer. */
export type Locale = "en" | "zh-CN";
export type AppLanguage = "system" | Locale;

export function normalizeLocale(value: unknown): Locale | null {
  if (typeof value !== "string") return null;
  const tag = value.trim().replaceAll("_", "-").toLowerCase();
  if (/^en(?:-|$)/.test(tag)) return "en";
  if (tag === "zh" || /^zh-(?:hans|cn|sg)(?:-|$)/.test(tag)) return "zh-CN";
  return null;
}

export function resolveAppLocale(choice: unknown, systemLocale: unknown): Locale {
  if (choice === "en" || choice === "zh-CN") return choice;
  return normalizeLocale(systemLocale) ?? "en";
}

export function resolveExportLocale(choice: unknown, appLocale: Locale): Locale {
  return choice === "en" || choice === "zh-CN" ? choice : appLocale;
}

/** An explicit unsupported embedded value is deliberate and falls back to English. */
export function resolveViewerLocale(saved: unknown, embedded: unknown, browserLocale: unknown): Locale {
  if (saved === "en" || saved === "zh-CN") return saved;
  if (embedded !== undefined && embedded !== null) return embedded === "en" || embedded === "zh-CN" ? embedded : "en";
  return normalizeLocale(browserLocale) ?? "en";
}

export function formatCount(n: number, locale: Locale): string {
  return new Intl.NumberFormat(locale).format(n);
}

export function formatDay(day: string, locale: Locale): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== day) return day;
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" }).format(date);
}

export function viewerLanguageKey(projectId: string): string {
  return `photoway:${projectId}:language`;
}

/** UI components subscribe and redraw labels without remounting trip state. */
export class LanguageState {
  private listeners = new Set<(locale: Locale) => void>();
  constructor(private current: Locale) {}
  get locale(): Locale { return this.current; }
  set(locale: Locale): void {
    if (locale === this.current) return;
    this.current = locale;
    for (const listener of this.listeners) listener(locale);
  }
  subscribe(listener: (locale: Locale) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
