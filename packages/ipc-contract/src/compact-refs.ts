import type { Ref, Result, ServiceResult } from './index.js';

const prefixes = { local: 'refs/heads/', remote: 'refs/remotes/', tag: 'refs/tags/' } as const;

/** An ordinary commit ref needs only its object ID and canonical name on the wire. */
export function canCompactRef(ref: Ref): boolean {
  return (
    ref.objectType === 'commit' &&
    ref.peeledType === '' &&
    ref.peeled === undefined &&
    ref.isHead === false &&
    ref.upstream === undefined &&
    (ref.kind === 'local' || ref.kind === 'remote' || ref.kind === 'tag') &&
    ref.name === prefixes[ref.kind] + ref.shortName &&
    !ref.target.includes(':')
  );
}

// Main checks the string representation before allowing it onto the renderer bridge.
export const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export function packedRefKind(name: string) {
  if (name.startsWith(prefixes.local)) return 'local';
  if (name.startsWith(prefixes.remote)) return 'remote';
  if (name.startsWith(prefixes.tag)) return 'tag';
}
export function validCompactRef(value: string) {
  const separator = value.indexOf(':');
  return (
    (separator === 40 || separator === 64) &&
    objectIdPattern.test(value.slice(0, separator)) &&
    packedRefKind(value.slice(separator + 1)) !== undefined
  );
}

// Only full compact rows establish a target. Metadata-rich refs pass through in place.
function mapCompactRefs<T>(rows: (Ref | string)[], convert: (name: string, target: string) => T) {
  let target: string | undefined;
  return rows.map((row) => {
    if (typeof row !== 'string') return row;
    if (row.startsWith('refs/')) {
      if (!target) throw new Error('Missing compact reference target');
      return convert(row, target);
    }
    const separator = row.indexOf(':');
    target = row.slice(0, separator);
    return convert(row.slice(separator + 1), target);
  });
}

function expandRef(name: string, target: string): Ref {
  const kind = packedRefKind(name);
  if (!kind) throw new Error('Invalid compact reference');
  return {
    name,
    shortName: name.slice(prefixes[kind].length),
    kind,
    target,
    objectType: 'commit',
    peeledType: '',
    isHead: false,
  };
}

/** Expand a main-validated snapshot at the boundary that needs ordinary refs. */
export function expandGitServiceResult(
  result: ServiceResult,
  options: { freezeCompactRefs?: boolean } = {},
): Result {
  if (result.kind === 'tagAliasSnapshot') {
    let previous: Ref | undefined;
    const refs = result.snapshot.refs.map((row) => {
      if (typeof row !== 'string') {
        previous = row;
        return row;
      }
      if (!previous) throw new Error('Missing annotated tag');
      const ref = { ...previous, name: row, shortName: row.slice(prefixes.tag.length) };
      return options.freezeCompactRefs ? Object.freeze(ref) : ref;
    });
    return { kind: 'snapshot', snapshot: { ...result.snapshot, refs } };
  }
  if (result.kind !== 'compactSnapshot') return result;
  const refs = mapCompactRefs(result.snapshot.refs, (name, target) => {
    const ref = expandRef(name, target);
    // Compact records contain only primitives. Immer can skip their fields during publication.
    return options.freezeCompactRefs ? Object.freeze(ref) : ref;
  });
  return { kind: 'snapshot', snapshot: { ...result.snapshot, refs } };
}

/** Preserve the self-contained rows returned by the original snapshot-json API. */
export function serializeLegacySnapshot(result: ServiceResult): string {
  if (result.kind === 'tagAliasSnapshot') return JSON.stringify(expandGitServiceResult(result));
  if (
    result.kind !== 'compactSnapshot' ||
    !result.snapshot.refs.some((row) => typeof row === 'string' && row.startsWith('refs/'))
  )
    return JSON.stringify(result);
  const refs = mapCompactRefs(result.snapshot.refs, (name, target) => target + ':' + name);
  return JSON.stringify({ ...result, snapshot: { ...result.snapshot, refs } });
}
