import { afterAll, expect, test } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runGit } from './src/runner.js';
import { patchedContents } from './src/working-comparison.js';
const root = await mkdtemp(join(tmpdir(), 'openkraken-native-full-patch-'));
afterAll(() => rm(root, { recursive: true, force: true }));
test('complete native patches reconstruct arbitrary bytes and final-newline states', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ maxLength: 500 }),
      fc.uint8Array({ maxLength: 500 }),
      async (old, next) => {
        const before = join(root, 'before'),
          after = join(root, 'after');
        await writeFile(before, old);
        await writeFile(after, next);
        const patch = await runGit(
          'git',
          [
            'diff',
            '--no-index',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            '--text',
            '--',
            before,
            after,
          ],
          { allowedExitCodes: [0, 1], cwd: root },
        );
        expect(patchedContents(Buffer.from(old), patch.stdout, 'file')).toEqual(Buffer.from(next));
      },
    ),
    { numRuns: 100, seed: 6721 },
  );
});
