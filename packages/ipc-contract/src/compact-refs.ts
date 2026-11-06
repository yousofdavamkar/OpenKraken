import type { Ref } from './index.js';

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

/** Only the target needs additional validation: all other fields come from strings or fixed defaults. */
export function expandRef(value: string): Ref | undefined {
  const separator = value.indexOf(':');
  if (separator !== 40 && separator !== 64) return undefined;
  const name = value.slice(separator + 1);
  const kind = name.startsWith(prefixes.local)
    ? 'local'
    : name.startsWith(prefixes.remote)
      ? 'remote'
      : name.startsWith(prefixes.tag)
        ? 'tag'
        : undefined;
  if (!kind) return undefined;
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
