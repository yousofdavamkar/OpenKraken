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
