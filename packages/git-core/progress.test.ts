import { expect, test } from 'vitest';
import { GitProgressLines } from './src/progress.js';
import { runProcess } from './src/runner.js';
test('progress frames complete UTF-8 lines, masks split URL credentials and bounds oversized lines', () => {
  const lines: string[] = [];
  const progress = new GitProgressLines((text) => lines.push(text));
  const bytes = Buffer.from(
    'Receiving objects: 20%\rremote: Grüße\nhttps://name:secret@example.test/repo?token=private\n',
  );
  for (const byte of bytes) progress.push(Buffer.from([byte]));
  progress.push(Buffer.from('x'.repeat(20000) + '\nDone\n'));
  progress.end();
  expect(lines).toContain('Receiving objects: 20%');
  expect(lines).toContain('remote: Grüße');
  expect(lines.at(-1)).toBe('Done');
  expect(lines.join('\n')).not.toMatch(/name|secret|private/);
  expect(lines.every((line) => line.length <= 4096)).toBe(true);
});
test('stderr can stream progress while preserving bounded diagnostic output', async () => {
  const chunks: Buffer[] = [];
  const result = await runProcess(
    process.execPath,
    ['-e', 'process.stderr.write("Counting objects: 5\\rDone\\n")'],
    {
      onStderr: (chunk) => {
        chunks.push(chunk);
      },
    },
  );
  expect(Buffer.concat(chunks).toString()).toBe('Counting objects: 5\rDone\n');
  expect(result.stderr).toBe('Counting objects: 5\rDone\n');
});
