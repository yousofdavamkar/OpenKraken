import { diff3Merge } from 'node-diff3';
import type { MergeInput, MergePart, MergeResult } from './merge-model.js';
self.onmessage = (event: MessageEvent<MergeInput>) => {
  let result: MergeResult;
  try {
    const lines = (text: string) => {
      if (text.length > 2 * 1024 * 1024)
        throw new Error('Text exceeds the merge calculation limit');
      const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      if (lines.length > 10000)
        throw new Error(
          'Chunk editing is limited to 10,000 lines per version. Use the output editor or an external tool.',
        );
      return lines;
    };
    const parts: MergePart[] = diff3Merge(
      lines(event.data.ours),
      lines(event.data.base),
      lines(event.data.theirs),
    ).map((part) =>
      part.ok
        ? { kind: 'stable', text: part.ok.join('') }
        : {
            kind: 'conflict',
            ours: part.conflict!.a,
            base: part.conflict!.o,
            theirs: part.conflict!.b,
          },
    );
    if (parts.length > 2000)
      throw new Error('Too many merge chunks. Use the output editor or an external tool.');
    result = { kind: 'merged', parts };
  } catch (error) {
    result = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(result);
};
