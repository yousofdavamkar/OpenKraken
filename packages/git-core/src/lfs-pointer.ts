/** Recognize bounded, canonical pointer metadata without running filters or fetching content. */
export function lfsPointer(content: Buffer): { oid: string; size: string } | undefined {
  if (!content.length || content.length >= 1024) return;
  const text = content.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(content) || !text.endsWith('\n')) return;
  const lines = text.slice(0, -1).split('\n');
  if (
    ![
      'version https://git-lfs.github.com/spec/v1',
      'version https://hawser.github.com/spec/v1',
    ].includes(lines.shift() ?? '')
  )
    return;
  const fields = new Map<string, string>();
  let previous = '';
  for (const line of lines) {
    const match = /^([a-z0-9.-]+) ([^\r\n]+)$/.exec(line);
    if (!match || match[1]! <= previous || match[1] === 'version') return;
    previous = match[1]!;
    fields.set(previous, match[2]!);
  }
  const oid = /^sha256:([0-9a-f]{64})$/.exec(fields.get('oid') ?? '')?.[1];
  const size = fields.get('size');
  if (!oid || !size || !/^(?:0|[1-9][0-9]*)$/.test(size) || BigInt(size) > 9223372036854775807n)
    return;
  return { oid, size };
}
