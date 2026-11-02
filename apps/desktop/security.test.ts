import { expect, test } from 'vitest';
import { isTrustedDocument, windowPreferences } from './src/security.js';
import {
  requestSchema,
  serviceRequestSchema,
  serviceResponseSchema,
} from '../../packages/ipc-contract/src/index.js';
test('exact top-level document only', () => {
  const url = 'file:///app/index.html';
  expect(isTrustedDocument({ url, parent: null }, url, true)).toBe(true);
  for (const frame of [
    null,
    { url: 'https://evil.test', parent: null },
    { url: url + '?evil', parent: null },
    { url, parent: {} },
  ])
    expect(isTrustedDocument(frame, url, true)).toBe(false);
  expect(isTrustedDocument({ url, parent: null }, url, false)).toBe(false);
  expect(windowPreferences).toMatchObject({
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  });
});
test('contract rejects arbitrary commands, paths, channels and malformed replies', () => {
  const id = '00000000-0000-4000-8000-000000000000';
  for (const request of [
    { id, method: 'exec', command: 'git' },
    { id, method: 'open', path: '/private' },
    { id, method: 'refresh', repoId: '../private' },
  ])
    expect(requestSchema.safeParse(request).success).toBe(false);
  expect(serviceRequestSchema.safeParse({ id, method: 'open' }).success).toBe(false);
  expect(
    serviceResponseSchema.safeParse({ id, result: { kind: 'snapshot', snapshot: {} } }).success,
  ).toBe(false);
});

test('provider IPC rejects malformed hosts and keeps credential requests out of the Git service', () => {
  const request = {
    id: '00000000-0000-4000-8000-000000000000',
    method: 'providerConnect',
    options: { provider: 'github', origin: 'https://github.com', token: 'fixture-pat' },
  };
  expect(requestSchema.safeParse(request).success).toBe(true);
  expect(serviceRequestSchema.safeParse(request).success).toBe(false);
  for (const origin of [
    'not a URL',
    '',
    'https://',
    'http://github.com',
    'https://user:secret@github.com',
  ])
    expect(
      requestSchema.safeParse({ ...request, options: { ...request.options, origin } }).success,
    ).toBe(false);
});
