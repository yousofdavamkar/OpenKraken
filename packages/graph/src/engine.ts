import MiniSearch from 'minisearch';
import { allocateLanes, emptyCheckpoint } from './index.js';
import type { Checkpoint, GraphCommit, GraphRow, GraphPassage } from './index.js';
export interface GraphDocument extends GraphCommit {
  summary: string;
  body: string;
  author: { name: string; email: string };
  kind?: 'commit' | 'wip' | 'conflict' | 'worktree';
}
export type GraphRequest =
  | {
      id: number;
      generation: string;
      method: 'reset' | 'append';
      pinnedOid?: string;
      offset: number;
      commits: GraphDocument[];
    }
  | {
      id: number;
      generation: string;
      baseGeneration: string;
      method: 'refresh';
      offset: 0;
      commits: GraphDocument[];
      pinnedOid?: string;
    }
  | { id: number; generation: string; method: 'search'; query: string };
export type GraphResponse =
  | {
      id: number;
      generation: string;
      kind: 'layout';
      offset: number;
      rows: GraphRow[];
      maxColumns: number;
      checkpointRows: number[];
      reusedTail: number;
      passages: GraphPassage[];
    }
  | { id: number; generation: string; kind: 'matches'; oids: string[] }
  | { id: number; generation: string; kind: 'error'; message: string };
export class GraphEngine {
  constructor(private compact = false) {}
  private generation = '';
  private documents: GraphCommit[] = [];
  private pinnedOid?: string;
  private checkpoint = emptyCheckpoint();
  private checkpoints: Checkpoint[] = [];
  private index = this.createIndex();
  private seen = new Set<string>();
  private pending: GraphDocument[] = [];
  indexPending(limit = this.pending.length) {
    this.index.addAll(
      this.pending.splice(0, limit).map((c) => ({
        oid: c.oid,
        summary: c.summary,
        body: c.body,
        name: c.author.name,
        email: c.author.email,
      })),
    );
    return this.pending.length > 0;
  }
  private createIndex() {
    return new MiniSearch({
      idField: 'oid',
      fields: ['summary', 'body', 'name', 'email', 'oid'],
      searchOptions: { prefix: true, combineWith: 'AND' },
    });
  }
  private refresh(request: Extract<GraphRequest, { method: 'refresh' }>): GraphResponse {
    if (request.baseGeneration !== this.generation) throw new Error('Stale graph generation');
    this.validateIds(request.commits);
    const sameTopology = (a: GraphCommit, b: GraphCommit) =>
      a.oid === b.oid &&
      !!a.isStash === !!b.isStash &&
      a.parents.length === b.parents.length &&
      a.parents.every((p, i) => p === b.parents[i]);
    const old = this.documents,
      next = request.commits;
    let prefix = 0;
    if (request.pinnedOid === this.pinnedOid)
      while (
        prefix < Math.min(old.length, next.length) &&
        sameTopology(old[prefix]!, next[prefix]!)
      )
        prefix++;
    // Only equal row indices can reuse Canvas rows verbatim. Insertions that shift rows
    // must relayout until a checkpoint with the same continuation state is reached.
    let suffix = next.length;
    if (old.length === next.length && request.pinnedOid === this.pinnedOid)
      while (suffix > prefix && sameTopology(old[suffix - 1]!, next[suffix - 1]!)) suffix--;
    const unchanged =
      request.pinnedOid === this.pinnedOid && prefix === next.length && next.length === old.length;
    const offset = unchanged ? prefix : Math.floor(prefix / 500) * 500;
    let state = unchanged
      ? this.checkpoint
      : offset === 0
        ? emptyCheckpoint(request.pinnedOid)
        : this.checkpoints.find((c) => c.nextRow === offset)!;
    const checkpoints = this.checkpoints.filter((c) => c.nextRow <= offset);
    const rows: GraphRow[] = [];
    const passages: GraphPassage[] = [];
    let reusedTail = 0;
    for (let at = offset; at < next.length;) {
      const end = Math.min(next.length, (Math.floor(at / 500) + 1) * 500);
      const result = allocateLanes(next.slice(at, end), state, this.compact);
      rows.push(...result.rows);
      passages.push(...result.passages);
      checkpoints.push(...result.checkpoints);
      state = result.checkpoint;
      at = end;
      const previous = this.checkpoints.find((c) => c.nextRow === at);
      if (
        old.length === next.length &&
        at < next.length &&
        at >= suffix &&
        previous &&
        JSON.stringify(state) === JSON.stringify(previous)
      ) {
        reusedTail = next.length - at;
        checkpoints.push(...this.checkpoints.filter((c) => c.nextRow > at));
        state = this.checkpoint;
        break;
      }
    }
    this.generation = request.generation;
    this.pinnedOid = request.pinnedOid;
    this.documents = next.map(({ oid, parents, isStash }) => ({ oid, parents, isStash }));
    this.checkpoint = state;
    this.checkpoints = checkpoints;
    this.index = this.createIndex();
    this.pending = [...next];
    this.seen = new Set(next.map((c) => c.oid));
    return {
      id: request.id,
      generation: this.generation,
      kind: 'layout',
      offset,
      rows,
      maxColumns: state.maxColumns,
      checkpointRows: checkpoints.map((c) => c.nextRow),
      reusedTail,
      passages,
    };
  }
  private validateIds(commits: GraphDocument[], append = false) {
    const ids = new Set<string>();
    for (const c of commits) {
      if (ids.has(c.oid) || (append && this.seen.has(c.oid)))
        throw new Error('Duplicate graph commit');
      ids.add(c.oid);
    }
  }
  handle(request: GraphRequest): GraphResponse {
    try {
      if (request.method === 'refresh') return this.refresh(request);
      if (request.method === 'reset') {
        if (request.offset !== 0) throw new Error('Reset must start at row zero');
        this.validateIds(request.commits);
        this.generation = request.generation;
        this.pinnedOid = request.pinnedOid;
        this.documents = [];
        this.checkpoint = emptyCheckpoint(request.pinnedOid);
        this.checkpoints = [];
        this.index = this.createIndex();
        this.seen.clear();
        this.pending = [];
      }
      if (request.generation !== this.generation) throw new Error('Stale graph generation');
      if (request.method === 'search') {
        this.indexPending();
        return {
          id: request.id,
          generation: this.generation,
          kind: 'matches',
          oids: request.query.trim()
            ? this.index.search(request.query.trim()).map((result) => String(result.id))
            : [],
        };
      }
      if (request.offset !== this.checkpoint.nextRow)
        throw new Error('Graph page offset does not match continuation');
      this.validateIds(request.commits, true);
      const result = allocateLanes(request.commits, this.checkpoint, this.compact);
      this.documents.push(
        ...request.commits.map(({ oid, parents, isStash }) => ({ oid, parents, isStash })),
      );
      this.pending.push(...request.commits);
      for (const c of request.commits) this.seen.add(c.oid);
      this.checkpoint = result.checkpoint;
      this.checkpoints.push(...result.checkpoints);
      return {
        id: request.id,
        generation: this.generation,
        kind: 'layout',
        offset: request.offset,
        rows: result.rows,
        maxColumns: result.checkpoint.maxColumns,
        checkpointRows: result.checkpoints.map((c) => c.nextRow),
        reusedTail: 0,
        passages: result.passages,
      };
    } catch (error) {
      return {
        id: request.id,
        generation: request.generation,
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
