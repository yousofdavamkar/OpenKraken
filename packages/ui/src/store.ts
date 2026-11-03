import { create } from 'zustand';
import { freeze } from 'immer';
import { immer } from 'zustand/middleware/immer';
import type {
  Commit,
  DesktopApi,
  GraphView,
  Request,
  Result,
  Snapshot,
  WorkingState,
} from '@openkraken/ipc-contract';
import { patchPassages } from '@openkraken/graph';
import type { GraphRow, GraphPassage } from '@openkraken/graph';
import { GraphClient } from './graph-client.js';
import { projectCommits, selectRow } from './history-model.js';
import type { DisplayCommit, Selection } from './history-model.js';
declare global {
  interface Window {
    openkraken: DesktopApi;
  }
}
let client: GraphClient | undefined;
const graph = () => (client ??= new GraphClient());
let querySequence = 0;
interface State {
  snapshot?: Snapshot;
  workingState?: WorkingState;
  watcherMode?: 'native' | 'polling';
  refreshStatus: (background?: boolean) => Promise<void>;
  rows: DisplayCommit[];
  layout: GraphRow[];
  passages: GraphPassage[];
  maxColumns: number;
  busy?: string;
  syncing?: string;
  paging?: string;
  searching?: string;
  error?: string;
  query: string;
  matches?: string[];
  searchResults?: Commit[];
  searchTruncated: boolean;
  selection: Selection;
  detail?: Commit | DisplayCommit;
  run: (request: Request, background?: boolean) => Promise<void>;
  cancel: () => Promise<void>;
  setView: (view: GraphView) => Promise<void>;
  loadMore: (count?: number) => Promise<void>;
  search: (query: string) => Promise<void>;
  searchAll: () => Promise<void>;
  select: (oid: string, mode?: 'single' | 'toggle' | 'range') => void;
  navigate: (oid: string) => Promise<void>;
  setDetail: (commit?: Commit | DisplayCommit) => void;
}
export const useRepository = create<State>()(
  immer((set, get) => ({
    rows: [],
    layout: [],
    passages: [],
    maxColumns: 1,
    query: '',
    searchTruncated: false,
    selection: { selected: [] },
    refreshStatus: async (background = true) => {
      const previous = get(),
        snapshot = previous.snapshot;
      if (!snapshot || previous.busy || previous.paging) return;
      const id = crypto.randomUUID();
      set((s) => {
        s.busy = id;
        if (background) s.syncing = id;
      });
      let fullRefresh = false;
      try {
        const result = await window.openkraken.request({
          id,
          method: 'workingState',
          repoId: snapshot.repository.id,
        });
        if (get().busy !== id || get().snapshot?.cursor !== snapshot.cursor) return;
        if (result.kind === 'error') throw new Error(result.message);
        if (result.kind !== 'workingState') return;
        if (JSON.stringify(snapshot.repository.head) !== JSON.stringify(result.state.head)) {
          fullRefresh = true;
          return;
        }
        if (JSON.stringify(snapshot.status) === JSON.stringify(result.state.status)) {
          set((s) => {
            s.workingState = result.state;
          });
          return;
        }
        const next = { ...snapshot, status: result.state.status };
        const rows = projectCommits(next.commits, next, true);
        const layout = await graph().request({
          method: 'refresh',
          generation: snapshot.cursor,
          baseGeneration: snapshot.cursor,
          commits: rows,
          offset: 0,
          pinnedOid: snapshot.pinnedOid,
        });
        if (layout.kind !== 'layout') throw new Error('Invalid graph response');
        const nextLayout = [
          ...previous.layout.slice(0, layout.offset),
          ...layout.rows,
          ...previous.layout.slice(rows.length - layout.reusedTail, rows.length),
        ];
        freeze(nextLayout, true);
        const passages = patchPassages(
          previous.passages,
          layout.offset,
          layout.offset + layout.rows.length,
          rows.length,
          layout.passages,
        );
        freeze(passages, true);
        querySequence++;
        set((s) => {
          s.snapshot = next;
          s.workingState = result.state;
          s.rows = rows;
          s.layout = nextLayout;
          s.passages = passages;
          s.maxColumns = layout.maxColumns;
          const available = new Set(rows.map((r) => r.oid));
          s.selection.selected = s.selection.selected.filter((oid) => available.has(oid));
          if (s.selection.focus && !available.has(s.selection.focus))
            s.selection.focus = rows[0]?.oid;
          if (s.selection.anchor && !available.has(s.selection.anchor))
            s.selection.anchor = s.selection.focus;
        });
        if (get().query) await get().search(get().query);
      } catch (error) {
        set((s) => {
          s.error = error instanceof Error ? error.message : String(error);
        });
      } finally {
        set((s) => {
          if (s.busy === id) s.busy = undefined;
          if (s.syncing === id) s.syncing = undefined;
        });
        if (fullRefresh)
          await get().run(
            {
              id: crypto.randomUUID(),
              method: 'refresh',
              repoId: snapshot.repository.id,
            },
            background,
          );
      }
    },
    run: async (request, background = false) => {
      if (!background && get().syncing) await waitForBackground();
      if (get().busy) return;
      const previousPage = get().paging,
        previousSearch = get().searching;
      set((s) => {
        s.busy = request.id;
        if (background) s.syncing = request.id;
        if (!background) s.error = undefined;
      });
      if (previousPage) await window.openkraken.cancel(previousPage);
      if (previousSearch) await window.openkraken.cancel(previousSearch);
      querySequence++;
      performance.mark('repository-open-start');
      try {
        if (
          request.method === 'refresh' &&
          !request.view &&
          get().snapshot?.repository.id === request.repoId
        )
          request = { ...request, view: get().snapshot!.view };
        const result = await window.openkraken.request(request);
        if (get().busy !== request.id) return;
        if (result.kind === 'snapshot') {
          const rows = projectCommits(result.snapshot.commits, result.snapshot, true);
          const previous = get(),
            sameRepository =
              request.method === 'refresh' &&
              previous.snapshot?.repository.id === result.snapshot.repository.id;
          if (!sameRepository) {
            client?.close();
            client = new GraphClient();
          }
          const layout = await graph().request({
            ...(sameRepository
              ? ({ method: 'refresh', baseGeneration: previous.snapshot!.cursor } as const)
              : ({ method: 'reset' } as const)),
            generation: result.snapshot.cursor,
            offset: 0,
            commits: rows,
            pinnedOid: result.snapshot.pinnedOid,
          });
          if (layout.kind !== 'layout') throw new Error('Invalid graph response');
          querySequence++;
          const nextLayout = [
            ...previous.layout.slice(0, layout.offset),
            ...layout.rows,
            ...previous.layout.slice(rows.length - layout.reusedTail, rows.length),
          ];
          freeze(nextLayout, true);
          const nextPassages = patchPassages(
            previous.passages,
            layout.offset,
            layout.offset + layout.rows.length,
            rows.length,
            layout.passages,
          );
          freeze(nextPassages, true);
          const query = sameRepository ? previous.query : '';
          set((s) => {
            s.snapshot = result.snapshot;
            // Invalidate an outdated review, but keep matching state usable while
            // an unchanged background snapshot is refreshed.
            if (
              !sameRepository ||
              JSON.stringify(s.workingState?.head) !==
                JSON.stringify(result.snapshot.repository.head) ||
              JSON.stringify(s.workingState?.status) !== JSON.stringify(result.snapshot.status)
            )
              s.workingState = undefined;
            if (!sameRepository) {
              s.watcherMode = undefined;
            }
            s.rows = rows;
            s.layout = nextLayout;
            s.passages = nextPassages;
            s.maxColumns = layout.maxColumns;
            s.query = query;
            s.matches = undefined;
            s.searchResults = undefined;
            s.searching = undefined;
            s.paging = undefined;
            s.detail = undefined;
            const available = new Set(rows.map((r) => r.oid));
            const focus =
              sameRepository && s.selection.focus && available.has(s.selection.focus)
                ? s.selection.focus
                : rows[0]?.oid;
            const selected = sameRepository
              ? s.selection.selected.filter((oid) => available.has(oid))
              : [];
            const anchor =
              sameRepository && s.selection.anchor && available.has(s.selection.anchor)
                ? s.selection.anchor
                : focus;
            s.selection = {
              focus,
              anchor,
              selected: selected.length ? selected : focus ? [focus] : [],
            };
          });
          if (query) await get().search(query);
        } else if (result.kind === 'error') throw new Error(result.message);
      } catch (error) {
        set((s) => {
          s.error = error instanceof Error ? error.message : String(error);
        });
      } finally {
        set((s) => {
          if (s.busy === request.id) s.busy = undefined;
          if (s.syncing === request.id) s.syncing = undefined;
        });
      }
    },
    setView: async (view) => {
      const snapshot = get().snapshot;
      if (snapshot)
        await get().run({
          id: crypto.randomUUID(),
          method: 'refresh',
          repoId: snapshot.repository.id,
          view,
        });
    },
    loadMore: async (count = 5000) => {
      if (get().syncing) await waitForBackground();
      const snapshot = get().snapshot;
      if (!snapshot?.hasMore || get().paging || get().busy) return;
      const id = crypto.randomUUID(),
        cursor = snapshot.cursor,
        offset = snapshot.commits.length;
      set((s) => {
        s.paging = id;
        s.error = undefined;
      });
      performance.mark('history-page-start');
      try {
        const result: Result = JSON.parse(
          await window.openkraken.request(
            { id, method: 'page', repoId: snapshot.repository.id, cursor, offset, count },
            'json',
          ),
        );
        performance.mark('history-page-response');
        if (get().snapshot?.cursor !== cursor || get().busy) return;
        if (result.kind === 'error') throw new Error(result.message);
        if (result.kind !== 'page') return;
        if (result.cursor !== cursor || result.offset !== get().snapshot?.commits.length)
          throw new Error('History page no longer matches the visible graph');
        const rows = projectCommits(result.commits, snapshot);
        const layout = await graph().request({
          method: 'append',
          generation: cursor,
          offset: get().rows.length,
          commits: rows,
        });
        performance.mark('history-page-worker');
        if (get().snapshot?.cursor !== cursor || get().busy) return;
        if (layout.kind !== 'layout') throw new Error('Invalid graph response');
        const current = get();
        const nextSnapshot = {
          ...current.snapshot!,
          commits: [...current.snapshot!.commits, ...result.commits],
          hasMore: result.hasMore,
        };
        const nextRows = [...current.rows, ...rows],
          nextLayout = [...current.layout, ...layout.rows];
        const nextPassages = [...current.passages, ...layout.passages];
        freeze(nextPassages, true);
        freeze(nextSnapshot, true);
        freeze(nextRows, true);
        freeze(nextLayout, true);
        set((s) => {
          s.snapshot = nextSnapshot;
          s.rows = nextRows;
          s.layout = nextLayout;
          s.passages = nextPassages;
          s.maxColumns = layout.maxColumns;
        });
        if (get().query) await get().search(get().query);
        performance.mark('history-page-loaded');
        performance.measure('history-page', 'history-page-start', 'history-page-loaded');
      } catch (error) {
        if (get().snapshot?.cursor === cursor && !get().busy)
          set((s) => {
            s.error = error instanceof Error ? error.message : String(error);
          });
      } finally {
        set((s) => {
          if (s.paging === id) s.paging = undefined;
        });
      }
    },
    search: async (query) => {
      const sequence = ++querySequence,
        cursor = get().snapshot?.cursor;
      const previous = get().searching;
      set((s) => {
        s.query = query;
        s.matches = query.trim() ? [] : undefined;
        s.searchResults = undefined;
        s.searching = undefined;
      });
      if (previous) void window.openkraken.cancel(previous);
      if (!cursor || !query.trim()) return;
      try {
        const result = await graph().request({ method: 'search', generation: cursor, query });
        if (sequence !== querySequence || get().snapshot?.cursor !== cursor) return;
        if (result.kind === 'matches')
          set((s) => {
            s.matches = result.oids;
          });
      } catch (error) {
        if (sequence === querySequence)
          set((s) => {
            s.error = String(error);
          });
      }
    },
    searchAll: async () => {
      if (get().syncing) await waitForBackground();
      const { snapshot, query } = get();
      if (!snapshot || !query.trim() || get().searching) return;
      const id = crypto.randomUUID(),
        sequence = querySequence;
      set((s) => {
        s.searching = id;
        s.error = undefined;
      });
      try {
        const result = await window.openkraken.request({
          id,
          method: 'search',
          repoId: snapshot.repository.id,
          cursor: snapshot.cursor,
          query,
        });
        if (sequence !== querySequence || get().snapshot?.cursor !== snapshot.cursor) return;
        if (result.kind === 'error') throw new Error(result.message);
        if (result.kind === 'search')
          set((s) => {
            s.searchResults = result.commits;
            s.searchTruncated = result.truncated;
          });
      } catch (error) {
        if (sequence === querySequence)
          set((s) => {
            s.error = String(error);
          });
      } finally {
        set((s) => {
          if (s.searching === id) s.searching = undefined;
        });
      }
    },
    select: (oid, mode) =>
      set((s) => {
        s.selection = selectRow(s.rows, s.selection, oid, mode);
      }),
    navigate: async (oid) => {
      const cursor = get().snapshot?.cursor;
      while (!get().rows.some((r) => r.oid === oid) && get().snapshot?.hasMore) {
        if (get().paging || get().busy || get().snapshot?.cursor !== cursor) return;
        const before = get().rows.length;
        await get().loadMore();
        if (get().rows.length === before) return;
      }
      if (get().snapshot?.cursor === cursor) get().select(oid);
    },
    setDetail: (detail) =>
      set((s) => {
        s.detail = detail;
      }),
    cancel: async () => {
      for (const id of [get().busy, get().paging, get().searching])
        if (id) await window.openkraken.cancel(id);
    },
  })),
);

/** A user click can arrive before React paints the background busy state. Preserve that intent. */
export async function waitForBackground() {
  while (useRepository.getState().syncing) {
    await new Promise<void>((resolve) => {
      const unsubscribe = useRepository.subscribe((state) => {
        if (!state.syncing) {
          unsubscribe();
          resolve();
        }
      });
    });
  }
}
