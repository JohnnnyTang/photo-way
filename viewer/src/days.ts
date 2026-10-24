import type { Item } from "./model";
import { parseDay } from "./util";

export const NO_DAY = "none";

export interface DayGroup {
  /** `YYYY-MM-DD`, or `none` for items without a capture time. */
  key: string;
  /** Item ids in time order. */
  ids: number[];
}

export function dayKeyOf(item: Pick<Item, "day" | "time">): string {
  const d = item.day ?? (item.time ? item.time.slice(0, 10) : null);
  return parseDay(d) ? (d as string).slice(0, 10) : NO_DAY;
}

/** Orders by capture instant ascending, items without one last (stable by id). */
export function sortByTime<T extends { id: number; ts: number | null }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.ts == null && b.ts == null) return a.id - b.id;
    if (a.ts == null) return 1;
    if (b.ts == null) return -1;
    return a.ts - b.ts || a.id - b.id;
  });
}

/** Groups by local calendar day, days in order of first appearance, undated group last. */
export function groupByDay(items: readonly Item[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const it of sortByTime(items)) {
    const key = dayKeyOf(it);
    let g = groups.get(key);
    if (!g) {
      g = { key, ids: [] };
      groups.set(key, g);
    }
    g.ids.push(it.id);
  }
  const list = [...groups.values()];
  const none = list.findIndex((g) => g.key === NO_DAY);
  if (none >= 0 && none !== list.length - 1) list.push(list.splice(none, 1)[0]!);
  return list;
}

export type Row = { kind: "day"; key: string; index: number } | { kind: "item"; id: number };

/** Flattens groups into timeline rows (separator + items), skipping ids rejected by `keep`. */
export function buildRows(groups: readonly DayGroup[], keep: (id: number) => boolean = () => true): Row[] {
  const rows: Row[] = [];
  groups.forEach((g, index) => {
    const ids = g.ids.filter(keep);
    if (!ids.length) return;
    rows.push({ kind: "day", key: g.key, index });
    for (const id of ids) rows.push({ kind: "item", id });
  });
  return rows;
}
