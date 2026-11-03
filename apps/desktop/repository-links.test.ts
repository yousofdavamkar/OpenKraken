import { expect, test } from 'vitest';
import { RepositoryLinks } from './src/repository-links.js';

const link = (path: string) => `openkraken://repo?path=${encodeURIComponent(path)}`;

test('repository links require an explicit single-use acceptance and preserve the reviewed target', () => {
  const links = new RepositoryLinks('linux', () => {});
  expect(links.read()).toBeNull();
  expect(links.receive(link('/home/test/space and ünicode'))).toBe(true);
  const reviewed = links.read()!;
  expect(reviewed.path).toBe('/home/test/space and ünicode');
  expect(links.receive(link('/other/repository'))).toBe(false);
  expect(links.read()).toEqual(reviewed);
  expect(() => links.accept(crypto.randomUUID())).toThrow('no longer available');
  expect(links.read()).toEqual(reviewed);
  expect(links.accept(reviewed.id)).toBe(reviewed.path);
  expect(links.read()).toBeNull();
  expect(() => links.accept(reviewed.id)).toThrow('no longer available');
  expect(links.receive(link('/another/repo'))).toBe(true);
  links.dismiss(reviewed.id);
  expect(links.read()).not.toBeNull();
  links.dismiss(links.read()!.id);
  expect(links.read()).toBeNull();
});

test('repository links reject ambiguous syntax and traversal before creating a pending action', () => {
  const links = new RepositoryLinks('linux', () => {});
  for (const raw of [
    '',
    'https://repo?path=/tmp/repo',
    'openkraken://login?token=secret',
    'openkraken://repo/../repo?path=/tmp/repo',
    'openkraken://repo/?path=/tmp/repo',
    'openkraken://user@repo?path=/tmp/repo',
    'openkraken://repo:42?path=/tmp/repo',
    'openkraken://repo?path=/tmp/repo&path=/other',
    'openkraken://repo?path=/tmp/repo&run=fetch',
    'openkraken://repo?path=/tmp/repo#extra',
    'openkraken://repo?path=%FF',
    'openkraken://repo?path=%',
    ' openkraken://repo?path=/tmp/repo',
    ...[
      'relative',
      '~/repo',
      '/tmp/../repo',
      '/tmp/./repo',
      '/tmp/%2e%2e/repo',
      '//host/share',
      '/tmp//repo',
      '/tmp/\\../repo',
      '/tmp/\0repo',
      '/tmp/\nrepo',
      '/tmp/\u202erepo',
      '/tmp/' + 'x'.repeat(16384),
    ].map(link),
  ]) {
    expect(links.receive(raw), raw).toBe(false);
    expect(links.read()).toBeNull();
  }
});

test('Windows links accept only local drive-qualified paths and reject device and network paths', () => {
  const links = new RepositoryLinks('win32', () => {});
  for (const path of [
    'C:relative',
    '/posix/repo',
    '\\\\host\\share',
    '\\\\?\\C:\\repo',
    'C:\\repo\\..\\other',
    'C:/repo/../other',
    'C:\\repo:stream',
    'C:\\NUL\\repo',
    'C:\\repo.\\child',
    'C:\\repo \\child',
    'C:\\repo\\CON.txt',
  ])
    expect(links.receive(link(path)), path).toBe(false);
  for (const path of ['C:\\Users\\Test User\\repo', 'D:/work/repo']) {
    expect(links.receive(link(path))).toBe(true);
    expect(links.accept(links.read()!.id)).toBe(path);
  }
});
