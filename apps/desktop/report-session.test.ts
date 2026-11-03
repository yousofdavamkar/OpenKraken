import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReportSession } from './src/report-session.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'openkraken-report-session-'));
  roots.push(root);
  return root;
}
const runtime = { version: '0.1.0', platform: 'linux' as const, arch: 'x64' as const };
const consent = 'a'.repeat(64);

test('a matching interrupted session retains the previous release and a clean exit clears it', async () => {
  const root = await fixture();
  const first = new ReportSession(root);
  expect(await first.begin(consent, runtime)).toBeNull();
  const file = join(root, 'reporting-session.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  expect(Object.keys(saved).sort()).toEqual(['consent', 'runtime', 'session', 'version']);
  expect(saved.runtime).toEqual(runtime);
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  const second = new ReportSession(root);
  expect(await second.begin(consent, { ...runtime, version: '0.2.0' })).toEqual(runtime);
  await expect(first.end()).rejects.toThrow(/changed/);
  await second.end();
  await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await new ReportSession(root).begin(consent, runtime)).toBeNull();
});

test('a different consent never recovers the old session', async () => {
  const root = await fixture();
  await new ReportSession(root).begin(consent, runtime);
  expect(await new ReportSession(root).begin('b'.repeat(64), runtime)).toBeNull();
});

test('corrupt and redirected markers are preserved without reporting or overwriting', async () => {
  const root = await fixture();
  const file = join(root, 'reporting-session.json');
  await writeFile(file, 'private text');
  await expect(new ReportSession(root).begin(consent, runtime)).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe('private text');
  await rm(file);
  const target = join(root, 'original');
  await writeFile(target, 'original');
  await symlink(target, file);
  await expect(new ReportSession(root).begin(consent, runtime)).rejects.toThrow();
  expect(await readFile(target, 'utf8')).toBe('original');
});
