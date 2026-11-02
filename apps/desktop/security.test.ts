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

test('device IPC accepts only session IDs for browser opening and rejects private challenge fields', () => {
  const id = '00000000-0000-4000-8000-000000000000';
  const open = { id, method: 'providerDeviceOpen', challengeId: id };
  expect(requestSchema.safeParse(open).success).toBe(true);
  expect(requestSchema.safeParse({ ...open, url: 'https://other.test' }).success).toBe(false);
  expect(serviceRequestSchema.safeParse(open).success).toBe(false);
  const response = {
    id,
    result: {
      kind: 'providerDevice',
      challenge: {
        id,
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://github.com/login/device',
        expiresAt: 900000,
        nextPollAt: 5000,
      },
    },
  };
  expect(serviceResponseSchema.safeParse(response).success).toBe(true);
  expect(
    serviceResponseSchema.safeParse({
      ...response,
      result: {
        ...response.result,
        challenge: { ...response.result.challenge, deviceCode: 'private' },
      },
    }).success,
  ).toBe(false);
});

test('repository browsing accepts bounded page numbers without renderer-supplied hosts or tokens', () => {
  const request = {
    id: '00000000-0000-4000-8000-000000000000',
    method: 'providerRepositories',
    accountId: 'a'.repeat(64),
    page: 1,
  };
  expect(requestSchema.safeParse(request).success).toBe(true);
  expect(serviceRequestSchema.safeParse(request).success).toBe(false);
  for (const fields of [
    { page: 0 },
    { page: 101 },
    { page: 1.5 },
    { url: 'https://attacker.test' },
    { token: 'secret' },
  ])
    expect(requestSchema.safeParse({ ...request, ...fields }).success).toBe(false);
});

test('saved clone tokens are accepted only by the private utility contract for the exact requested URL', () => {
  const request = {
    id: '00000000-0000-4000-8000-000000000000',
    method: 'clone',
    options: { url: 'https://github.com/team/project.git' },
    providerAccountId: 'a'.repeat(64),
  };
  expect(requestSchema.safeParse(request).success).toBe(true);
  const credential = {
    url: request.options.url,
    username: 'fixture-user',
    password: 'fixture-secret',
  };
  expect(requestSchema.safeParse({ ...request, credential }).success).toBe(false);
  const internal = {
    id: request.id,
    method: 'clone',
    path: '/chosen/folder',
    options: request.options,
    credential,
  };
  expect(serviceRequestSchema.safeParse(internal).success).toBe(true);
  expect(
    serviceRequestSchema.safeParse({
      ...internal,
      credential: { ...credential, url: 'https://other.test/team/project.git' },
    }).success,
  ).toBe(false);
  expect(
    serviceResponseSchema.safeParse({
      id: request.id,
      result: { kind: 'providerCredential', credential },
    }).success,
  ).toBe(false);
});

test('provider Git requests expose account selection but keep resolved targets and credentials private', () => {
  const id = '00000000-0000-4000-8000-000000000000';
  const operation = {
    method: 'fetch',
    repoId: 'a'.repeat(64),
    name: 'origin',
    revision: 'c'.repeat(64),
  };
  const request = { id, method: 'providerGit', accountId: 'b'.repeat(64), operation };
  expect(requestSchema.safeParse(request).success).toBe(true);
  expect(serviceRequestSchema.safeParse(request).success).toBe(false);
  const credential = {
    url: 'https://github.com/team/project.git',
    username: 'fixture-user',
    password: 'fixture-secret',
  };
  expect(requestSchema.safeParse({ ...request, credential }).success).toBe(false);
  const target = { id, method: 'providerGitTarget', operation };
  expect(requestSchema.safeParse(target).success).toBe(false);
  expect(serviceRequestSchema.safeParse(target).success).toBe(true);
  expect(
    serviceRequestSchema.safeParse({
      id,
      method: 'providerGit',
      operation,
      credential,
      token: 'c'.repeat(64),
    }).success,
  ).toBe(true);
  for (const extra of [
    { background: true },
    { url: 'https://other.test/team/project.git' },
    { credential },
  ])
    expect(
      requestSchema.safeParse({ ...request, operation: { ...operation, ...extra } }).success,
    ).toBe(false);
});
