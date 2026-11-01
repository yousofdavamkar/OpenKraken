import { afterAll, expect, test } from 'vitest';
import fc from 'fast-check';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, fixtureKinds } from '../test-fixtures/src/index.js';
import { RepositoryService } from '../git-core/src/index.js';
import { allocateLanes, emptyCheckpoint, type GraphCommit } from './src/index.js';
const root = mkdtempSync(join(tmpdir(), 'openkraken-graph-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function invariants(commits: GraphCommit[], pinnedOid?: string) {
  const { rows } = allocateLanes(commits, emptyCheckpoint(pinnedOid));
  expect(new Set(rows.map((r) => `${r.rowIndex}:${r.column}`)).size).toBe(rows.length);
  const positions = new Map(rows.map((r, i) => [r.oid, i]));
  commits.forEach((commit, index) => {
    for (const parent of commit.isStash ? commit.parents.slice(0, 1) : commit.parents) {
      const start = rows[index]!.edges.find(
        (e) => e.target === parent && e.kind !== 'pass' && e.kind !== 'end',
      );
      expect(start).toBeDefined();
      let lane = start!.to;
      const end = positions.get(parent);
      if (end === undefined) continue;
      expect(end).toBeGreaterThan(index);
      for (let row = index + 1; row <= end; row++) {
        const segment = rows[row]!.edges.find(
          (e) => e.from === lane && e.target === parent && (e.kind === 'pass' || e.kind === 'end'),
        );
        expect(segment, `Disconnected ${commit.oid} → ${parent} at ${row}`).toBeDefined();
        lane = segment!.to;
      }
      expect(lane).toBe(rows[end]!.column);
    }
  });
}
for (const kind of fixtureKinds)
  test(`${kind} golden layout and edges`, async () => {
    const service = new RepositoryService('git');
    const repo = await service.open(createFixture(join(root, kind), kind));
    const { commits } = await service.snapshot(repo.id);
    invariants(commits);
    const labels = new Map(commits.map((c) => [c.oid, c.isStash ? 'stash' : c.summary]));
    const layout = allocateLanes(commits);
    const golden = layout.rows.map((r) => ({
      ...r,
      oid: labels.get(r.oid),
      edges: r.edges.map((e) => ({ ...e, target: labels.get(e.target) ?? 'boundary' })),
    }));
    expect(golden).toMatchSnapshot();
  });
test('random DAG paths connect and paging preserves every earlier row', () => {
  fc.assert(
    fc.property(
      fc.array(fc.array(fc.nat(100), { maxLength: 5 }), { minLength: 1, maxLength: 60 }),
      fc.nat(100),
      (links, cut) => {
        const commits = links.map((parents, i) => ({
          oid: String(i),
          parents: [
            ...new Set(
              parents.map((p) => i + 1 + (p % (links.length - i))).filter((p) => p < links.length),
            ),
          ].map(String),
        }));
        invariants(commits);
        const at = cut % commits.length;
        const pin = commits[at]!.oid;
        invariants(commits, pin);
        const pinned = allocateLanes(commits, emptyCheckpoint(pin));
        let ancestor: string | undefined = pin;
        while (ancestor) {
          expect(pinned.rows.find((r) => r.oid === ancestor)?.column).toBe(0);
          ancestor = commits.find((c) => c.oid === ancestor)?.parents[0];
        }
        const pinnedPage = allocateLanes(commits.slice(0, at), emptyCheckpoint(pin));
        expect([
          ...pinnedPage.rows,
          ...allocateLanes(commits.slice(at), pinnedPage.checkpoint).rows,
        ]).toEqual(pinned.rows);
        const first = allocateLanes(commits.slice(0, at));
        const saved = structuredClone(first);
        const second = allocateLanes(commits.slice(at), first.checkpoint);
        expect([...first.rows, ...second.rows]).toEqual(allocateLanes(commits).rows);
        expect(first).toEqual(saved);
        // Brute-force active parent frontier bounds the lanes needed at every row.
        const active = new Set<string>();
        let peak = 1;
        for (const c of commits) {
          peak = Math.max(peak, active.size + (active.has(c.oid) ? 0 : 1));
          active.delete(c.oid);
          c.parents.forEach((p) => active.add(p));
          peak = Math.max(peak, active.size);
        }
        expect(second.checkpoint.maxColumns).toBeLessThanOrEqual(peak + 1);
      },
    ),
    { numRuns: 300 },
  );
});
test('checkpoints every 500 rows and boundary continuation', () => {
  const commits = Array.from({ length: 1001 }, (_, i) => ({
    oid: String(i),
    parents: [String(i + 1)],
  }));
  const result = allocateLanes(commits);
  expect(result.checkpoints.map((c) => c.nextRow)).toEqual([500, 1000]);
  expect(result.checkpoint.lanes[0]?.target).toBe('1001');
});
