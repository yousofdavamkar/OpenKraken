import type { Ref, Result, ServiceResult } from './index.js';

const prefixes = { local: 'refs/heads/', remote: 'refs/remotes/', tag: 'refs/tags/' } as const;

/** An ordinary commit ref needs only its object ID and canonical name on the wire. */
export function compactRef(ref: Ref): string | Ref {
  if (
    ref.objectType !== 'commit' ||
    ref.peeledType !== '' ||
    ref.peeled !== undefined ||
    ref.isHead !== false ||
    ref.upstream !== undefined ||
    (ref.kind !== 'local' && ref.kind !== 'remote' && ref.kind !== 'tag') ||
    ref.name !== prefixes[ref.kind] + ref.shortName ||
    ref.target.includes(':')
  )
    return ref;
  return ref.target + ':' + ref.name;
}

// Main checks the string representation before allowing it onto the renderer bridge.
export const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function packedRefKind(name: string) {
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

function expandRef(value: string): Ref {
  const separator = value.indexOf(':');
  const name = value.slice(separator + 1);
  const kind = packedRefKind(name);
  if (!kind) throw new Error('Invalid compact reference');
  return {
    name,
    shortName: name.slice(prefixes[kind].length),
    kind,
    target: value.slice(0, separator),
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
  if (result.kind !== 'compactSnapshot') return result;
  const refs = result.snapshot.refs.map((row) => {
    if (typeof row !== 'string') return row;
    const ref = expandRef(row);
    // Compact records contain only primitives. Immer can skip their fields during publication.
    return options.freezeCompactRefs ? Object.freeze(ref) : ref;
  });
  return { kind: 'snapshot', snapshot: { ...result.snapshot, refs } };
}
