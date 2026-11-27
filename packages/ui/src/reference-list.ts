import type { Ref } from '@openkraken/ipc-contract';

export const referenceGroups = [
  ['local', 'Branches'],
  ['remote', 'Remotes'],
  ['tag', 'Tags'],
  ['stash', 'Stashes'],
  ['other', 'Other refs'],
] as const;

const refsPerBlock = 4;
type Span = {
  kind: Ref['kind'];
  title?: string;
  from: number;
  end: number;
  firstBlock: number;
  endBlock: number;
  firstPosition: number;
  /** Matching references of this kind, including those in a collapsed section. */
  total: number;
  /** A collapsed section is one heading-only block with no references. */
  collapsed?: true;
};

export function blockStart(span: Span, block: number) {
  return span.from + (block - span.firstBlock) * refsPerBlock;
}

export function blockLength(span: Span, block: number) {
  if (span.collapsed) return 0;
  return Math.min(refsPerBlock, span.end - blockStart(span, block));
}

export function groupReferences(
  source: readonly Ref[],
  query: string,
  collapsed: ReadonlySet<Ref['kind']> = new Set(),
) {
  const search = query.trim().toLocaleLowerCase();
  const refs = search
    ? source.filter((ref) => ref.name.toLocaleLowerCase().includes(search))
    : source;
  // Git normally returns each namespace in one run. Other namespaces can be
  // interleaved with them. Preserve each kind's original order in either case.
  const runs = new Map<Ref['kind'], { from: number; end: number }[]>(
    referenceGroups.map(([kind]) => [kind, []]),
  );
  for (let from = 0; from < refs.length;) {
    const kind = refs[from]!.kind;
    let end = from + 1;
    while (end < refs.length && refs[end]!.kind === kind) end++;
    runs.get(kind)!.push({ from, end });
    from = end;
  }
  const spans: Span[] = [];
  let blocks = 0;
  let position = 1;
  for (const [kind, title] of referenceGroups) {
    const ranges = runs.get(kind)!;
    const total = ranges.reduce((sum, range) => sum + range.end - range.from, 0);
    if (total && collapsed.has(kind)) {
      // Keep the heading so the section can be expanded again.
      const from = ranges[0]!.from;
      spans.push({
        kind,
        title,
        from,
        end: from,
        firstPosition: position,
        firstBlock: blocks,
        endBlock: blocks + 1,
        total,
        collapsed: true,
      });
      blocks++;
      continue;
    }
    for (const range of ranges) {
      const endBlock = blocks + Math.ceil((range.end - range.from) / refsPerBlock);
      spans.push({
        ...range,
        kind,
        title: range === ranges[0] ? title : undefined,
        firstPosition: position,
        firstBlock: blocks,
        endBlock,
        total,
      });
      position += range.end - range.from;
      blocks = endBlock;
    }
  }
  return {
    refs,
    count: refs.length,
    /** References shown in expanded sections, for list positions. */
    listed: position - 1,
    blocks,
    section(block: number) {
      if (block < 0 || block >= blocks) return undefined;
      let low = 0,
        high = spans.length - 1;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (block < spans[middle]!.endBlock) high = middle;
        else low = middle + 1;
      }
      return spans[low];
    },
    focusedBlock(name: string) {
      const index = refs.findIndex((ref) => ref.name === name);
      if (index < 0) return -1;
      const span = spans.find((item) => index >= item.from && index < item.end);
      if (!span) return -1;
      return span.firstBlock + Math.floor((index - span.from) / refsPerBlock);
    },
  };
}
