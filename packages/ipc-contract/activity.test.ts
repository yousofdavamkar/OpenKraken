import { expect, test } from 'vitest';
import { activityEventSchema } from './src/activity.js';

test('activity notifications carry only a finished action, outcome and identifier', () => {
  const completed = {
    id: '79df7edb-82db-4629-941c-61dbac7582e7',
    action: 'commit',
    outcome: 'succeeded',
  };
  const encode = (completion: unknown) =>
    activityEventSchema.safeParse({ type: 'activityChanged', completed: completion }).success;
  expect(encode(undefined)).toBe(true);
  expect(encode(completed)).toBe(true);
  for (const outcome of ['failed', 'cancelled', 'unknown', 'attention'])
    expect(encode({ ...completed, outcome })).toBe(true);
  expect(encode({ ...completed, outcome: 'running' })).toBe(false);
  expect(encode({ ...completed, id: 'invalid' })).toBe(false);
  expect(encode({ ...completed, action: 'repository path' })).toBe(false);
  expect(encode({ ...completed, message: 'private hook output' })).toBe(false);
});
