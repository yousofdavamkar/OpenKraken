import { expect, test } from 'vitest';
import { requestSchema, serviceRequestSchema } from './src/index.js';

test('repository link requests are main-only and cannot supply a path, URI or native command', () => {
  for (const request of [
    { id: crypto.randomUUID(), method: 'repositoryLink' },
    { id: crypto.randomUUID(), method: 'repositoryLinkOpen', linkId: crypto.randomUUID() },
    { id: crypto.randomUUID(), method: 'repositoryLinkDismiss', linkId: crypto.randomUUID() },
  ]) {
    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(serviceRequestSchema.safeParse(request).success).toBe(false);
    for (const extra of [{ path: '/tmp/repo' }, { uri: 'openkraken://repo' }, { command: 'fetch' }])
      expect(requestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
  }
});
