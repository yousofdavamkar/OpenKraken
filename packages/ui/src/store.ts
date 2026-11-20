import { create } from 'zustand';
import { freeze } from 'immer';
import { immer } from 'zustand/middleware/immer';
import type {
  Commit,
  DesktopApi,
  GraphView,
  SnapshotRequest,
  Snapshot,
  WorkingState,
} from '@openkraken/ipc-contract';
import {
  decodeHistoryPage,
  decodeSnapshotBodies,
  expandGitServiceResult,
} from '@openkraken/ipc-contract';
import { passageBuckets, refreshPassageBuckets } from '@openkraken/graph';
import type { GraphRow, GraphPassage } from '@openkraken/graph';
import { GraphClient } from './graph-client.js';
import {
  projectCommits,
  sameWorkingPaths,
  workingRow,
  workingRowKind,
  selectRow,
  singleSelection,
} from './history-model.js';
import type { DisplayCommit, Selection } from './history-model.js';
declare global {
  interface Window {
    openkraken: DesktopApi;
  }
}
function rowPositions(rows: DisplayCommit[]) {
  const positions = new Map<string, number>();
  rows.forEach((row, index) => positions.set(row.oid, index));
  return positions;
}

let client: GraphClient | undefined;
const graph = () => (client ??= new GraphClient());
let querySequence = 0;
let cancellingSearch: string | undefined;
let queuedSearch: string | undefined;
function stopHistorySearch(id: string) {
  if (queuedSearch === id) {
    queuedSearch = undefined;
    return;
  }
  return window.openkraken.cancel(id);
}
let navigationSequence = 0;
interface State {
  snapshot?: Snapshot;
  workingState?: WorkingState;
  watcherMode?: 'native' | 'polling';
  refreshStatus: (background?: boolean, updateWorktrees?: boolean) => Promise<void>;
  rows: DisplayCommit[];
  layout: GraphRow[];
  passages: GraphPassage[][];
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
  run: (request: SnapshotRequest, background?: boolean) => Promise<void>;
  cancel: () => Promise<void>;
  setView: (view: GraphView) => Promise<void>;
  loadMore: (count?: number) => Promise<void>;
  search: (query: string) => Promise<void>;
  searchAll: () => Promise<void>;
  cancelSearch: () => Promise<void>;
  select: (oid: string, mode?: 'single' | 'toggle' | 'range', position?: number) => void;
  navigate: (target: string | number) => Promise<void>;
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
    refreshStatus: async (background = true, updateWorktrees = false) => {
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
        const [result, worktreeResult] = await Promise.all([
          window.openkraken.request({
            id,
            method: 'workingState',
            repoId: snapshot.repository.id,
          }),
          updateWorktrees
            ? window.openkraken.request({
                id: crypto.randomUUID(),
                method: 'worktrees',
                repoId: snapshot.repository.id,
              })
            : undefined,
        ]);
        if (get().busy !== id || get().snapshot?.cursor !== snapshot.cursor) return;
        if (result.kind === 'error') throw new Error(result.message);
        if (worktreeResult?.kind === 'error') throw new Error(worktreeResult.message);
        if (result.kind !== 'workingState') return;
        const worktrees =
          worktreeResult?.kind === 'worktrees' ? worktreeResult.state : snapshot.worktrees;
        if (
          JSON.stringify(snapshot.repository.head) !== JSON.stringify(result.state.head) ||
          worktrees?.revision !== snapshot.worktrees?.revision
        ) {
          fullRefresh = true;
          return;
        }
        const next = { ...snapshot, status: result.state.status, worktrees };
        const sameWorktrees =
          worktrees === snapshot.worktrees ||
          JSON.stringify(worktrees) === JSON.stringify(snapshot.worktrees);
        const kind = workingRowKind(result.state.status);
        if (sameWorktrees && kind === workingRowKind(snapshot.status)) {
          // A different list of dirty paths changes search and detail text. The
          // working node still has the same ID, parents and position.
          const index =
            kind && !sameWorkingPaths(snapshot.status, result.state.status)
              ? previous.rows.findIndex((row) => row.kind === kind)
              : -1;
          const row = index >= 0 ? workingRow(next) : undefined;
          if (row) {
            const { oid, summary, body, author } = row;
            const reply = await graph().request({
              method: 'updateSearchDocument',
              generation: snapshot.cursor,
              document: { oid, summary, body, author },
            });
            if (reply.kind !== 'documentUpdated') throw new Error('Invalid graph response');
          }
          if (get().busy !== id || get().snapshot?.cursor !== snapshot.cursor) return;
          const statusChanged =
            !!row || JSON.stringify(snapshot.status) !== JSON.stringify(result.state.status);
          set((s) => {
            if (statusChanged) s.snapshot = next;
            s.workingState = result.state;
            if (row) {
              s.rows[index] = row;
              if (s.detail?.oid === row.oid) s.detail = row;
            }
          });
          if (row && get().query) await updateLoadedMatches();
          return;
        }
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
        const passages = refreshPassageBuckets(
          previous.passages,
          layout.offset,
          layout.offset + layout.rows.length,
          rows.length,
          layout.passages,
        );
        freeze(passages, true);
        set((s) => {
          s.snapshot = next;
          s.workingState = result.state;
          s.rows = rows;
          if (s.detail && 'kind' in s.detail && s.detail.kind !== 'commit')
            s.detail = rows.find((row) => row.oid === s.detail?.oid);
          s.layout = nextLayout;
          s.passages = passages;
          s.maxColumns = layout.maxColumns;
          const available = rowPositions(rows);
          s.selection.selected = s.selection.selected.filter((oid) => available.has(oid));
          if (s.selection.focus && !available.has(s.selection.focus))
            s.selection.focus = rows[0]?.oid;
          if (s.selection.anchor && !available.has(s.selection.anchor))
            s.selection.anchor = s.selection.focus;
          s.selection.focusIndex = s.selection.focus ? available.get(s.selection.focus) : undefined;
          s.selection.anchorIndex = s.selection.anchor
            ? available.get(s.selection.anchor)
            : undefined;
        });
        if (get().query) await updateLoadedMatches();
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
      set((s) => {
        s.busy = request.id;
        if (background) s.syncing = request.id;
        if (!background) s.error = undefined;
      });
      performance.mark('repository-open-start');
      let candidate: GraphClient | undefined;
      try {
        if (
          request.method === 'refresh' &&
          !request.view &&
          get().snapshot?.repository.id === request.repoId
        )
          request = { ...request, view: get().snapshot!.view };
        if (
          request.method !== 'refresh' ||
          get().snapshot?.repository.id !== request.repoId ||
          client?.failed
        )
          candidate = new GraphClient();
        const serialized = await window.openkraken.request(request, 'snapshot-bodies');
        const receivedAt = performance.now();
        const decoded = decodeSnapshotBodies(serialized);
        const parsedAt = performance.now();
        const result = expandGitServiceResult(decoded, { freezeCompactRefs: true });
        if (get().busy !== request.id) return;
        if (result.kind === 'snapshot') {
          performance.mark('repository-snapshot-response', {
            detail: {
              snapshotMs: result.snapshot.elapsedMs,
              receivedAt,
              parseMs: parsedAt - receivedAt,
              expandMs: performance.now() - parsedAt,
            },
          });
          const rows = projectCommits(result.snapshot.commits, result.snapshot, true);
          const previous = get(),
            sameRepository =
              request.method === 'refresh' &&
              previous.snapshot?.repository.id === result.snapshot.repository.id;
          // An append can advance the current worker while the picker or snapshot is pending.
          // Start a separate layout if that append has not reached the store yet.
          const existing =
            sameRepository && !previous.paging && !client?.failed ? client : undefined;
          const target = existing ?? (candidate ??= new GraphClient());
          const pendingLayout = target.request({
            ...(existing
              ? ({ method: 'refresh', baseGeneration: previous.snapshot!.cursor } as const)
              : ({ method: 'reset' } as const)),
            generation: result.snapshot.cursor,
            offset: 0,
            commits: rows,
            pinnedOid: result.snapshot.pinnedOid,
          });
          // The graph worker owns a clone. Prepare immutable store data while it lays out the page.
          freeze(result.snapshot, true);
          freeze(rows, true);
          const available = rowPositions(rows);
          const layout = await pendingLayout;
          if (layout.kind !== 'layout') throw new Error('Invalid graph response');
          if (get().busy !== request.id) return;
          performance.mark('repository-layout-response');
          querySequence++;
          const nextLayout = [
            ...previous.layout.slice(0, layout.offset),
            ...layout.rows,
            ...previous.layout.slice(rows.length - layout.reusedTail, rows.length),
          ];
          freeze(nextLayout, true);
          const nextPassages = refreshPassageBuckets(
            previous.passages,
            layout.offset,
            layout.offset + layout.rows.length,
            rows.length,
            layout.passages,
          );
          freeze(nextPassages, true);
          const query = sameRepository ? get().query : '';
          const previousSearch = get().searching;
          const retainedSearch =
            sameRepository && previousSearch === queuedSearch ? previousSearch : undefined;
          if (target === candidate) {
            client?.close();
            client = target;
            candidate = undefined;
          }
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
            if (previous.snapshot?.repository.id !== result.snapshot.repository.id) {
              s.watcherMode = undefined;
            }
            s.rows = rows;
            s.layout = nextLayout;
            s.passages = nextPassages;
            s.maxColumns = layout.maxColumns;
            s.query = query;
            s.matches = undefined;
            s.searchResults = undefined;
            s.searching = retainedSearch;
            s.paging = undefined;
            s.detail = undefined;
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
              focusIndex: focus ? available.get(focus) : undefined,
              anchor,
              anchorIndex: anchor ? available.get(anchor) : undefined,
              selected: selected.length ? selected : focus ? [focus] : [],
            };
          });
          if (previousSearch && previousSearch !== retainedSearch)
            void stopHistorySearch(previousSearch);
          performance.mark('repository-state-published');
          if (query) await updateLoadedMatches();
        } else if (result.kind === 'error') throw new Error(result.message);
      } catch (error) {
        set((s) => {
          s.error = error instanceof Error ? error.message : String(error);
        });
      } finally {
        candidate?.close();
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
        const result = decodeHistoryPage(
          await window.openkraken.request(
            { id, method: 'page', repoId: snapshot.repository.id, cursor, offset, count },
            'history-page',
          ),
        );
        performance.mark('history-page-response');
        if (get().snapshot?.cursor !== cursor || get().paging !== id) return;
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
        if (get().snapshot?.cursor !== cursor || get().paging !== id) return;
        if (layout.kind !== 'layout') throw new Error('Invalid graph response');
        const current = get();
        const nextSnapshot = {
          ...current.snapshot!,
          commits: [...current.snapshot!.commits, ...result.commits],
          hasMore: result.hasMore,
        };
        const nextRows = [...current.rows, ...rows],
          nextLayout = [...current.layout, ...layout.rows];
        const nextPassages = passageBuckets(layout.passages, current.passages);
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
        if (get().query) await updateLoadedMatches();
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
      querySequence++;
      const previous = get().searching;
      set((s) => {
        s.query = query;
        s.matches = query.trim() ? [] : undefined;
        s.searchResults = undefined;
        s.searching = undefined;
      });
      if (previous) void stopHistorySearch(previous);
      await updateLoadedMatches();
    },
    searchAll: async () => {
      const { snapshot, query, searching, syncing } = get();
      if (!snapshot || !query.trim() || searching) return;
      const id = crypto.randomUUID();
      if (syncing) queuedSearch = id;
      set((s) => {
        s.searching = id;
        s.error = undefined;
      });
      try {
        if (syncing) {
          await waitForBackground();
          if (queuedSearch !== id) return;
          queuedSearch = undefined;
        }
        const current = get().snapshot;
        if (get().searching !== id || current?.repository.id !== snapshot.repository.id) return;
        const result = await window.openkraken.request({
          id,
          method: 'search',
          repoId: current.repository.id,
          cursor: current.cursor,
          query,
        });
        if (get().searching !== id || cancellingSearch === id) return;
        if (result.kind === 'error') throw new Error(result.message);
        if (result.kind === 'search')
          set((s) => {
            s.searchResults = result.commits;
            s.searchTruncated = result.truncated;
          });
      } catch (error) {
        if (get().searching === id && cancellingSearch !== id)
          set((s) => {
            s.error = String(error);
          });
      } finally {
        set((s) => {
          if (s.searching === id) s.searching = undefined;
        });
      }
    },
    cancelSearch: async () => {
      const id = get().searching;
      if (!id || cancellingSearch === id) return;
      cancellingSearch = id;
      try {
        await stopHistorySearch(id);
        if (get().searching === id) set({ searching: undefined });
      } catch (error) {
        if (get().searching === id) set({ error: String(error) });
      } finally {
        if (cancellingSearch === id) cancellingSearch = undefined;
      }
    },
    select: (oid, mode, position) => {
      const { rows, selection } = get();
      const next = selectRow(rows, selection, oid, mode, position);
      if (next === selection) return;
      set((s) => {
        s.selection = next;
      });
    },
    navigate: async (target) => {
      const sequence = ++navigationSequence;
      const { snapshot, selection } = get();
      const cursor = snapshot?.cursor;
      let checked = 0;
      while (
        get().snapshot?.cursor === cursor &&
        get().selection === selection &&
        sequence === navigationSequence
      ) {
        const { rows, busy, paging, snapshot: current } = get();
        let position = typeof target === 'number' ? target : -1;
        if (typeof target === 'string') {
          for (let i = checked; i < rows.length; i++) {
            if (rows[i]!.oid === target) {
              position = i;
              break;
            }
          }
        }
        const row = rows[position];
        if (row) {
          const nextSelection = singleSelection(row.oid, position);
          set((s) => {
            s.selection = nextSelection;
          });
          return;
        }
        if (!current?.hasMore || busy) return;
        if (paging) {
          await new Promise<void>((resolve) => {
            const unsubscribe = useRepository.subscribe((state) => {
              if (state.paging !== paging) {
                unsubscribe();
                resolve();
              }
            });
          });
        } else {
          await get().loadMore();
        }
        const updated = get().rows;
        if (updated.length === rows.length) return;
        // Appends retain earlier row objects. A working-state refresh can reproject them.
        checked = updated[rows.length - 1] === rows.at(-1) ? rows.length : 0;
      }
    },
    setDetail: (detail) =>
      set((s) => {
        s.detail = detail;
      }),
    cancel: async () => {
      for (const id of [get().busy, get().paging]) if (id) await window.openkraken.cancel(id);
    },
  })),
);

async function updateLoadedMatches() {
  const { snapshot, query, rows } = useRepository.getState();
  if (!snapshot || !query.trim()) return;
  const sequence = querySequence;
  const stillCurrent = () => {
    const state = useRepository.getState();
    return (
      state.snapshot?.cursor === snapshot.cursor &&
      state.rows === rows &&
      sequence === querySequence
    );
  };
  try {
    const result = await graph().request({ method: 'search', generation: snapshot.cursor, query });
    if (result.kind === 'matches' && stillCurrent())
      useRepository.setState({ matches: result.oids });
  } catch (error) {
    if (stillCurrent()) useRepository.setState({ error: String(error) });
  }
}

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
