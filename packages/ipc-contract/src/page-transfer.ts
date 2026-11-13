import type { Commit, Result } from './index.js';

type Page = Extract<Result, { kind: 'page' }>;
type Metadata = Omit<Page, 'commits'> & { commits: Omit<Commit, 'body'>[] };
export interface HistoryPageTransfer {
  kind: 'page';
  metadata: string;
  bodies: string[];
}

export type HistoryPageReply = HistoryPageTransfer | Exclude<Result, Page>;

/** Called by main only after validating the Git service reply. */
export function encodeHistoryPage(page: Page): HistoryPageTransfer {
  const bodies: string[] = [];
  const commits = page.commits.map(({ body, ...metadata }) => {
    bodies.push(body);
    return metadata;
  });
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
