import { expect, test } from 'vitest';
import { requestSchema, resultSchema, serviceRequestSchema } from './src/index.js';

test('updates stay in main and renderer requests cannot choose trust or download destinations', () => {
  for (const method of [
    'updatesRead',
    'updatesCheck',
    'updatesCancel',
    'updatesDownload',
    'updatesStarted',
    'updatesInstall',
  ]) {
    const request = {
      id: crypto.randomUUID(),
      method,
      ...(method === 'updatesDownload' ? { format: 'AppImage' } : {}),
      ...(method === 'updatesInstall' ? { installId: crypto.randomUUID() } : {}),
    };
    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(serviceRequestSchema.safeParse(request).success).toBe(false);
    for (const extra of [
      { url: 'https://evil.test' },
      { path: '/tmp/evil' },
      { publicKey: 'evil' },
      { command: 'sh' },
    ])
      expect(requestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
  }
  expect(
    requestSchema.safeParse({
      id: crypto.randomUUID(),
      method: 'updatesDownload',
      format: '../evil',
    }).success,
  ).toBe(false);
  const state = {
    phase: 'disabled',
    version: null,
    artifacts: [],
    selected: null,
    downloaded: 0,
    error: null,
  };
  expect(resultSchema.safeParse({ kind: 'updates', state }).success).toBe(true);
  expect(
    resultSchema.safeParse({ kind: 'updates', state: { ...state, url: 'https://evil.test' } })
      .success,
  ).toBe(false);
});
