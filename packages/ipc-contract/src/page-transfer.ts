import type { Commit, Result, ServiceResult } from './index.js';

type Page = Extract<Result, { kind: 'page' }>;
type Metadata = Omit<Page, 'commits'> & { commits: Omit<Commit, 'body'>[] };
export interface HistoryPageTransfer {
  kind: 'page';
  metadata: string;
  bodies: string[];
}

export type HistoryPageReply = HistoryPageTransfer | Exclude<Result, Page>;

function separateBodies(source: Commit[]) {
  const bodies: string[] = [];
  const commits = source.map(({ body, ...metadata }) => {
    bodies.push(body);
    return metadata;
  });
  return { bodies, commits };
}

/** Called by main only after validating the Git service reply. */
export function encodeHistoryPage(page: Page): HistoryPageTransfer {
  const { bodies, commits } = separateBodies(page.commits);
  return {
    kind: 'page',
    metadata: JSON.stringify({ ...page, commits } satisfies Metadata),
    bodies,
  };
}

export function decodeHistoryPage(reply: HistoryPageReply): Result {
  if (reply.kind !== 'page') return reply;
  const page: Metadata = JSON.parse(reply.metadata);
  if (page.commits.length !== reply.bodies.length) throw new Error('Incomplete history page');
  const commits = page.commits.map((commit, index) => ({ ...commit, body: reply.bodies[index]! }));
  return { ...page, commits };
}

export interface SnapshotBodies {
  metadata: string;
  bodies: string[];
}

/** Split the initial commit messages after main validates the complete snapshot. */
export function encodeSnapshotBodies(result: ServiceResult): SnapshotBodies | string {
  if (
    result.kind !== 'snapshot' &&
    result.kind !== 'compactSnapshot' &&
    result.kind !== 'tagAliasSnapshot'
  )
    return JSON.stringify(result);
  const { commits, bodies } = separateBodies(result.snapshot.commits);
  return {
    metadata: JSON.stringify({ ...result, snapshot: { ...result.snapshot, commits } }),
    bodies,
  };
}

export function decodeSnapshotBodies(reply: SnapshotBodies | string): ServiceResult {
  if (typeof reply === 'string') return JSON.parse(reply);
  const result: Extract<
    ServiceResult,
    { kind: 'snapshot' | 'compactSnapshot' | 'tagAliasSnapshot' }
  > = JSON.parse(reply.metadata);
  const commits = result.snapshot.commits;
  if (commits.length !== reply.bodies.length) throw new Error('Incomplete snapshot commit bodies');
  for (let i = 0; i < commits.length; i++) commits[i]!.body = reply.bodies[i]!;
  return result;
}
