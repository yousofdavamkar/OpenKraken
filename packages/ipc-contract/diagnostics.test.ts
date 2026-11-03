import { expect, test } from 'vitest';
import { requestSchema, serviceRequestSchema, diagnosticEntrySchema } from './src/index.js';
test('diagnostics are main-owned and cannot receive arbitrary log messages or paths', () => {
  for (const method of ['diagnosticsRead', 'diagnosticsClear']) {
    const request = { id: crypto.randomUUID(), method };
    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(serviceRequestSchema.safeParse(request).success).toBe(false);
    for (const extra of [{ path: '/private' }, { message: 'secret' }, { code: 'PRIVATE_TOKEN' }])
      expect(requestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
  }
  const event = {
    id: crypto.randomUUID(),
    time: Date.now(),
    type: 'process',
    component: 'git',
    reason: 'crashed',
  };
  expect(diagnosticEntrySchema.safeParse(event).success).toBe(true);
  expect(diagnosticEntrySchema.safeParse({ ...event, message: 'secret' }).success).toBe(false);
  expect(
    diagnosticEntrySchema.safeParse({ ...event, reason: 'https://user:secret@example.test' })
      .success,
  ).toBe(false);
});
