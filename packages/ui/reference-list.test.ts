import { expect, test } from 'vitest';
import type { Ref } from '@openkraken/ipc-contract';
import { blockLength, blockStart, groupReferences } from './src/reference-list.js';

const prefixes = {
  local: 'heads/',
  remote: 'remotes/origin/',
  tag: 'tags/',
  stash: '',
  other: 'notes/',
};
function reference(kind: Ref['kind'], shortName: string): Ref {
  return {
    kind,
    shortName,
    name: 'refs/' + prefixes[kind] + shortName,
    target: 'a'.repeat(40),
    objectType: 'commit',
    peeledType: '',
    isHead: false,
  };
}

test('sidebar positions, headings and focus follow group order across noncontiguous ranges', () => {
  const local = reference('local', 'topic');
  const remote = reference('remote', 'topic');
  const tags = Array.from({ length: 6 }, (_, i) => reference('tag', 'topic-' + i));
  const notes = [reference('other', 'left'), reference('other', 'right')];
  const stash = reference('stash', 'stash');
  const refs = [notes[0]!, tags[0]!, remote, ...tags.slice(1), stash, local, notes[1]!];
  for (const query of ['', '  TOPIC  ', 'absent']) {
    const list = groupReferences(refs, query);
    const expected = [local, remote, ...tags, stash, ...notes].filter((ref) =>
      ref.name.includes(query.trim().toLowerCase()),
    );
    if (!query) expect(list.refs).toBe(refs);
    const headings = [];
    const ordered: Ref[] = [];
    for (let i = 0; i < list.blocks; i++) {
      const span = list.section(i)!;
      if (i === span.firstBlock && span.title) headings.push(span.title);
      const start = blockStart(span, i);
      for (let index = start; index < start + blockLength(span, i); index++) {
        const ref = list.refs[index]!;
        ordered.push(ref);
        expect(span.firstPosition + index - span.from).toBe(ordered.length);
        expect(list.focusedBlock(ref.name)).toBe(i);
      }
    }
    expect(ordered).toEqual(expected);
    expect(list.count).toBe(expected.length);
    expect(headings).toEqual(
      query === ''
        ? ['Branches', 'Remotes', 'Tags', 'Stashes', 'Other refs']
        : expected.length
          ? ['Branches', 'Remotes', 'Tags']
          : [],
    );
    expect(list.section(-1)).toBeUndefined();
    expect(list.section(list.blocks)).toBeUndefined();
    expect(list.focusedBlock('refs/missing')).toBe(-1);
  }
});
