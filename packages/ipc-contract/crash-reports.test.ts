import { expect, test } from 'vitest';
import { requestSchema, resultSchema, serviceRequestSchema } from './src/index.js';
const id = '00000000-0000-4000-8000-000000000001';
test('crash reporting consent routes are strict and main-only', () => {
  for (const request of [
    { id, method: 'crashReporting' },
    { id, method: 'crashReportingSave', enabled: true, revision: null },
    { id, method: 'rendererFailure', reason: 'unhandled-exception' },
    { id, method: 'rendererFailure', reason: 'unhandled-rejection' },
  ]) {
    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(serviceRequestSchema.safeParse(request).success).toBe(false);
    expect(requestSchema.safeParse({ ...request, dsn: 'https://attacker.invalid' }).success).toBe(
      false,
    );
    expect(requestSchema.safeParse({ ...request, message: '/private/repo' }).success).toBe(false);
  }
  expect(
    requestSchema.safeParse({ id, method: 'crashReportingCapture', reason: 'crashed' }).success,
  ).toBe(false);
  expect(
    requestSchema.safeParse({ id, method: 'rendererFailure', reason: 'unclean-exit' }).success,
  ).toBe(false);
  expect(
    requestSchema.safeParse({
      id,
      method: 'rendererFailure',
      reason: 'unhandled-exception',
      process: 'main',
    }).success,
  ).toBe(false);
  expect(
    resultSchema.safeParse({
      kind: 'crashReporting',
      state: {
        enabled: false,
        revision: null,
        destination: null,
        warning: null,
        delivery: 'idle',
        stack: 'private',
      },
    }).success,
  ).toBe(false);
});
