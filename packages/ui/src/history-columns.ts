/** Resizable commit history columns. The graph sizes to its lanes and the message fills the rest. */
export const columnKeys = ['refs', 'commit', 'author', 'date'] as const;
export type ColumnKey = (typeof columnKeys)[number];
export type ColumnWidths = Record<ColumnKey, number>;
export const columnLabels: Record<ColumnKey, string> = {
  refs: 'Branch / tag',
  commit: 'Commit',
  author: 'Author',
  date: 'Date',
};
export const defaultColumnWidths: ColumnWidths = { refs: 130, commit: 80, author: 130, date: 90 };
export const columnLimits: Record<ColumnKey, { min: number; max: number }> = {
  refs: { min: 60, max: 480 },
  commit: { min: 56, max: 240 },
  author: { min: 60, max: 480 },
  date: { min: 60, max: 320 },
};
export const messageMinWidth = 160;
/** Keyboard resizing moves a column edge by this many pixels; Shift moves it further. */
export const columnStep = 10;

export function clampColumn(key: ColumnKey, width: number) {
  const { min, max } = columnLimits[key];
  return Math.round(Math.min(max, Math.max(min, width)));
}

const storageKey = (repoId: string) => `openkraken.history-columns.v1.${repoId}`;

/** Reads saved widths. Missing, damaged or out-of-range values fall back per column. */
export function loadColumnWidths(repoId: string, storage: Pick<Storage, 'getItem'>): ColumnWidths {
  let saved: unknown;
  try {
    saved = JSON.parse(storage.getItem(storageKey(repoId)) ?? 'null');
  } catch {
    saved = null;
  }
  const widths = { ...defaultColumnWidths };
  if (saved && typeof saved === 'object' && !Array.isArray(saved))
    for (const key of columnKeys) {
      const value = (saved as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value))
        widths[key] = clampColumn(key, value);
    }
  return widths;
}

/** Saves only columns that differ from their defaults; returns false when storage is unavailable. */
export function saveColumnWidths(
  repoId: string,
  widths: ColumnWidths,
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
) {
  const changed = Object.fromEntries(
    columnKeys
      .filter((key) => widths[key] !== defaultColumnWidths[key])
      .map((key) => [key, clampColumn(key, widths[key])]),
  );
  try {
    if (Object.keys(changed).length) storage.setItem(storageKey(repoId), JSON.stringify(changed));
    else storage.removeItem(storageKey(repoId));
    return true;
  } catch {
    return false;
  }
}

/** The CSS grid template shared by the column head and every row. */
export function gridColumns(widths: ColumnWidths, graphWidth: number) {
  return `${widths.refs}px ${graphWidth}px ${widths.commit}px minmax(${messageMinWidth}px, 1fr) ${widths.author}px ${widths.date}px`;
}

export function totalColumnsWidth(widths: ColumnWidths, graphWidth: number) {
  // Includes the row's 10 px horizontal padding.
  return (
    widths.refs + graphWidth + widths.commit + messageMinWidth + widths.author + widths.date + 10
  );
}
