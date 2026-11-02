import { oidSchema, type MergePrediction } from '@openkraken/ipc-contract';
import { NulDecoder } from './parsers.js';
import { GitError, type RunOptions, type runGit } from './runner.js';
export async function predictMerge(
  run: (args: string[], options: RunOptions) => ReturnType<typeof runGit>,
  head: string,
  target: string,
  signal?: AbortSignal,
): Promise<MergePrediction> {
  oidSchema.parse(head);
  oidSchema.parse(target);
  let tree: string | undefined;
  const paths: MergePrediction['paths'] = [];
  const parser = new NulDecoder((field) => {
    if (tree === undefined) {
      tree = oidSchema.parse(field.toString());
      return;
    }
    if (!field.length) return;
    if (paths.length >= 10000)
      throw new GitError('PREDICTION_LIMIT', 'Merge prediction exceeds 10,000 conflict paths');
    paths.push({ path: field.toString('utf8'), pathBytes: field.toString('base64') });
  });
  const result = await run(
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', head, target],
    {
      signal,
      allowedExitCodes: [0, 1],
      timeoutMs: 30000,
      maxBytes: 2 * 1024 * 1024,
      onStdout: (chunk) => parser.push(chunk),
    },
  );
  parser.finish();
  if (!tree) throw new GitError('INVALID_PREDICTION', 'Git did not return a merge tree');
  // Some directory conflicts have no individual unmerged paths. Exit status is authoritative.
  return { head, target, tree, clean: result.exitCode === 0, paths };
}
