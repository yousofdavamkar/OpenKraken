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

test('progress masks complete URL userinfo when passwords contain literal at signs', () => {
  const lines: string[] = [];
  const progress = new GitProgressLines((text) => lines.push(text));
  const bytes = Buffer.from(
    'https://user:secret@password@example.test/repo?private\n' +
      'ssh://git:secret@password@example.test/repo#private\n' +
      'https://example.test/path@revision\nssh://git@example.test/repo\n',
  );
  for (const byte of bytes) progress.push(Buffer.from([byte]));
  progress.end();
  expect(lines).toEqual([
    'https://[credentials]@example.test/repo[redacted parameters]',
    'ssh://git:[redacted]@example.test/repo[redacted parameters]',
    'https://example.test/path@revision',
    'ssh://git@example.test/repo',
  ]);
});

test('progress masks apostrophes inside URL credentials and parameters across byte boundaries', () => {
  const lines: string[] = [];
  const progress = new GitProgressLines((text) => lines.push(text));
  const bytes = Buffer.from(
    "https://private'user:private'password@example.test/repo\n" +
      "ssh://git:private'password@example.test/repo\n" +
      "https://example.test/repo?token='private-query'\n" +
      "https://example.test/repo#'private-fragment'\n" +
      "fatal: unable to access 'https://private'user:private'password@example.test/repo': denied\n" +
      "https://example.test/team's/repo\n",
  );
  for (const byte of bytes) progress.push(Buffer.from([byte]));
  progress.end();
  expect(lines).toEqual([
    'https://[credentials]@example.test/repo',
    'ssh://git:[redacted]@example.test/repo',
    'https://example.test/repo[redacted parameters]',
    'https://example.test/repo[redacted parameters]',
    "fatal: unable to access 'https://[credentials]@example.test/repo': denied",
    "https://example.test/team's/repo",
  ]);
});
