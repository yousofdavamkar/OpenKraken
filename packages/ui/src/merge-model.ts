export type MergePart =
  | { kind: 'stable'; text: string }
  | { kind: 'conflict'; ours: string[]; base: string[]; theirs: string[] };
export type MergeInput = { base: string; ours: string; theirs: string };
export type MergeResult =
  { kind: 'merged'; parts: MergePart[] } | { kind: 'error'; message: string };
export function renderMerge(parts: MergePart[], resolutions: Record<number, string>) {
  return parts
    .map((part, index) =>
      part.kind === 'stable'
        ? part.text
        : (resolutions[index] ??
          `<<<<<<< ours\n${part.ours.join('')}||||||| base\n${part.base.join('')}=======\n${part.theirs.join('')}>>>>>>> theirs\n`),
    )
    .join('');
}

// Chunk indices refer to the three-stage merge that produced the recovered output.
export function resolveChunkChoices(
  parts: MergePart[],
  choices: { index: number; ours: string; theirs: string }[],
) {
  const resolutions: Record<number, string> = {};
  for (const { index, ours, theirs } of choices) {
    const part = parts[index];
    if (
      part?.kind !== 'conflict' ||
      ours.length !== part.ours.length ||
      theirs.length !== part.theirs.length
    )
      return;
    resolutions[index] = [
      ...part.ours.filter((_, i) => ours[i] === '1'),
      ...part.theirs.filter((_, i) => theirs[i] === '1'),
    ].join('');
  }
  return resolutions;
}
