import MiniSearch from 'minisearch';
import { allocateLanes, emptyCheckpoint } from './index.js';
import type { Checkpoint, GraphCommit, GraphRow } from './index.js';
export interface GraphDocument extends GraphCommit {
  summary: string;
  body: string;
  author: { name: string; email: string };
  kind?: 'commit' | 'wip' | 'conflict';
}
export type GraphRequest =
  | {
      id: number;
      generation: string;
      method: 'reset' | 'append';
      offset: number;
      commits: GraphDocument[];
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
    }
  | { id: number; generation: string; kind: 'matches'; oids: string[] }
  | { id: number; generation: string; kind: 'error'; message: string };
export class GraphEngine {
  private generation = '';
  private checkpoint = emptyCheckpoint();
  private checkpoints: Checkpoint[] = [];
  private index = this.createIndex();
  private createIndex() {
    return new MiniSearch({
      idField: 'oid',
      fields: ['summary', 'body', 'name', 'email', 'oid'],
      searchOptions: { prefix: true, combineWith: 'AND' },
    });
  }
  handle(request: GraphRequest): GraphResponse {
    try {
      if (request.method === 'reset') {
        if (request.offset !== 0) throw new Error('Reset must start at row zero');
        this.generation = request.generation;
        this.checkpoint = emptyCheckpoint();
        this.checkpoints = [];
        this.index = this.createIndex();
      }
      if (request.generation !== this.generation) throw new Error('Stale graph generation');
      if (request.method === 'search')
        return {
          id: request.id,
          generation: this.generation,
          kind: 'matches',
          oids: request.query.trim()
            ? this.index.search(request.query.trim()).map((result) => String(result.id))
            : [],
        };
      if (request.offset !== this.checkpoint.nextRow)
        throw new Error('Graph page offset does not match continuation');
      const ids = new Set<string>();
      for (const c of request.commits) {
        if (ids.has(c.oid) || this.index.has(c.oid)) throw new Error('Duplicate graph commit');
        ids.add(c.oid);
      }
      const result = allocateLanes(request.commits, this.checkpoint);
      this.index.addAll(
        request.commits.map((c) => ({ ...c, name: c.author.name, email: c.author.email })),
      );
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
