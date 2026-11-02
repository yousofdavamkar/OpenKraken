import { expect, test } from 'vitest';
import { isTrustedDocument, windowPreferences } from './src/security.js';
import {
  requestSchema,
  serviceRequestSchema,
  serviceResponseSchema,
  resultSchema,
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

test('GitLab IPC exposes only bounded loopback metadata and cannot open arbitrary URLs or accept private PKCE material', () => {
  const id = '00000000-0000-4000-8000-000000000000';
  const options = { origin: 'https://gitlab.com', clientId: 'public-client', callbackPort: 47653 };
  const start = { id, method: 'providerGitLabStart', options };
  expect(requestSchema.safeParse(start).success).toBe(true);
  expect(serviceRequestSchema.safeParse(start).success).toBe(false);
  for (const fields of [
    { callbackPort: 80 },
    { callbackPort: 65536 },
    { redirectUri: 'https://attacker.test' },
    { codeVerifier: 'secret' },
    { clientSecret: 'secret' },
    { origin: 'http://gitlab.com' },
  ])
    expect(requestSchema.safeParse({ ...start, options: { ...options, ...fields } }).success).toBe(
      false,
    );
  const open = { id, method: 'providerGitLabOpen', challengeId: id };
  expect(requestSchema.safeParse(open).success).toBe(true);
  expect(requestSchema.safeParse({ ...open, url: 'https://attacker.test' }).success).toBe(false);
  const challenge = {
    id,
    origin: options.origin,
    redirectUri: 'http://127.0.0.1:47653/callback',
    expiresAt: 600000,
  };
  expect(resultSchema.safeParse({ kind: 'providerGitLab', challenge }).success).toBe(true);
  for (const fields of [
    { state: 'secret' },
    { codeVerifier: 'secret' },
    { code: 'secret' },
    { redirectUri: 'http://localhost:47653/callback' },
    { redirectUri: 'http://127.0.0.1:80/callback' },
  ])
    expect(
      resultSchema.safeParse({ kind: 'providerGitLab', challenge: { ...challenge, ...fields } })
        .success,
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

test('nested provider clone paths retain every namespace component and reject noncanonical credential targets', () => {
  const id = '00000000-0000-4000-8000-000000000000';
  const url = 'https://gitlab.example.test/company/division/team/project.git';
  const request = {
    id,
    method: 'clone',
    path: '/chosen/folder',
    options: { url },
    credential: { url, username: 'oauth2', password: 'fixture-secret' },
  };
  expect(serviceRequestSchema.safeParse(request).success).toBe(true);
  for (const path of [
    'company//team/project.git',
    'company/../team/project.git',
    'company/%2e%2e/team/project.git',
    'company/team%2fproject.git',
    'company/team/project.git/',
    'company/team/project.git?token=secret',
    'company/team/project.git#secret',
    'company/team\\project.git',
  ]) {
    const target = `https://gitlab.example.test/${path}`;
    expect(
      serviceRequestSchema.safeParse({
        ...request,
        options: { url: target },
        credential: { ...request.credential, url: target },
      }).success,
    ).toBe(false);
  }
  expect(
    requestSchema.safeParse({
      id,
      method: 'providerPullRequests',
      accountId: 'a'.repeat(64),
      options: {
        repository: { owner: 'company/division/team', name: 'project' },
        state: 'open',
        page: 1,
      },
    }).success,
  ).toBe(true);
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

test('saved-account push accepts a reviewed plan but no caller-supplied destination URL or credential', () => {
  const id = '00000000-0000-4000-8000-000000000000',
    repoId = 'a'.repeat(64),
    accountId = 'b'.repeat(64),
    revision = 'c'.repeat(64);
  const selection = { name: 'origin', source: 'refs/heads/main', destination: 'refs/heads/main' };
  const preview = {
    id,
    method: 'providerGit',
    accountId,
    operation: { method: 'pushPreview', repoId, selection, revision },
  };
  expect(requestSchema.safeParse(preview).success).toBe(true);
  expect(
    requestSchema.safeParse({
      ...preview,
      operation: { ...preview.operation, url: 'https://other.test/team/project.git' },
    }).success,
  ).toBe(false);
  const plan = {
    ...selection,
    sourceOid: '1'.repeat(40),
    remoteOid: '2'.repeat(40),
    token: revision,
    url: 'https://github.com/team/project.git',
  };
  const push = {
    id,
    method: 'providerGit',
    accountId,
    operation: { method: 'push', repoId, options: { plan, force: true, upstream: true } },
  };
  expect(requestSchema.safeParse(push).success).toBe(true);
  expect(
    requestSchema.safeParse({
      ...push,
      operation: { ...push.operation, credential: { password: 'secret' } },
    }).success,
  ).toBe(false);
});

test('saved pull requires working and remote revisions and resolves its upstream internally', () => {
  const id = '00000000-0000-4000-8000-000000000000',
    repoId = 'a'.repeat(64);
  const options = { mode: 'ff-only', revision: 'b'.repeat(64) };
  const preview = { id, method: 'providerPullPreview', repoId, options };
  expect(requestSchema.safeParse(preview).success).toBe(true);
  expect(serviceRequestSchema.safeParse(preview).success).toBe(true);
  const operation = { method: 'pull', repoId, options, revision: 'c'.repeat(64) };
  const request = { id, method: 'providerGit', accountId: 'd'.repeat(64), operation };
  expect(requestSchema.safeParse(request).success).toBe(true);
  for (const extra of [
    { revision: undefined },
    { name: 'another' },
    { upstream: 'refs/heads/other' },
    { url: 'https://other.test/team/repo.git' },
    { credential: { password: 'secret' } },
  ])
    expect(
      requestSchema.safeParse({ ...request, operation: { ...operation, ...extra } }).success,
    ).toBe(false);
});

test('saved remote deletion requires a reviewed ref and exact tip without caller credentials', () => {
  const id = '00000000-0000-4000-8000-000000000000',
    repoId = 'a'.repeat(64),
    accountId = 'b'.repeat(64),
    revision = 'c'.repeat(64);
  const selection = { name: 'origin', destination: 'refs/tags/release' };
  const preview = {
    id,
    method: 'providerGit',
    accountId,
    operation: { method: 'deleteRemotePreview', repoId, selection, revision },
  };
  expect(requestSchema.safeParse(preview).success).toBe(true);
  const plan = {
    ...selection,
    token: revision,
    url: 'https://github.com/team/repo.git',
    remoteOid: '1'.repeat(40),
  };
  const request = {
    id,
    method: 'providerGit',
    accountId,
    operation: { method: 'deleteRemote', repoId, plan },
  };
  expect(requestSchema.safeParse(request).success).toBe(true);
  for (const override of [
    { remoteOid: null },
    { remoteOid: '' },
    { token: undefined },
    { destination: 'refs/notes/private' },
  ])
    expect(
      requestSchema.safeParse({
        ...request,
        operation: { ...request.operation, plan: { ...plan, ...override } },
      }).success,
    ).toBe(false);
  for (const extra of [
    { credential: { password: 'secret' } },
    { url: 'https://other.test/team/repo.git' },
    { force: true },
  ])
    expect(
      requestSchema.safeParse({ ...preview, operation: { ...preview.operation, ...extra } })
        .success,
    ).toBe(false);
});

test('pull-request browsing accepts only bounded repository selectors and account IDs', () => {
  const id = '00000000-0000-4000-8000-000000000000',
    accountId = 'a'.repeat(64);
  const repository = { owner: 'team', name: 'project' };
  const list = {
    id,
    method: 'providerPullRequests',
    accountId,
    options: { repository, state: 'open', page: 1 },
  };
  const detail = {
    id,
    method: 'providerPullRequest',
    accountId,
    options: { repository, number: 1 },
  };
  expect(requestSchema.safeParse(list).success).toBe(true);
  expect(requestSchema.safeParse(detail).success).toBe(true);
  expect(serviceRequestSchema.safeParse(list).success).toBe(false);
  expect(serviceRequestSchema.safeParse(detail).success).toBe(false);
  for (const extra of [
    { page: 0 },
    { page: 101 },
    { state: 'unknown' },
    { origin: 'https://other.test' },
    { token: 'secret' },
    { repository: { owner: '../other', name: 'project' } },
  ])
    expect(
      requestSchema.safeParse({ ...list, options: { ...list.options, ...extra } }).success,
    ).toBe(false);
  for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(
      requestSchema.safeParse({ ...detail, options: { ...detail.options, number } }).success,
    ).toBe(false);
});

test('PR files and review IPC require bounded pages, revisions and explicit review events', () => {
  const id = '00000000-0000-4000-8000-000000000000',
    accountId = 'a'.repeat(64);
  const options = {
    repository: { owner: 'team', name: 'project' },
    number: 1,
    revision: { head: '1'.repeat(40), base: '2'.repeat(40) },
  };
  const files = { id, accountId, method: 'providerPullFiles', options: { ...options, page: 1 } };
  const review = {
    id,
    accountId,
    method: 'providerSubmitReview',
    options: { ...options, event: 'COMMENT', body: 'Review text' },
  };
  expect(requestSchema.safeParse(files).success).toBe(true);
  expect(requestSchema.safeParse(review).success).toBe(true);
  expect(serviceRequestSchema.safeParse(review).success).toBe(false);
  expect(
    requestSchema.safeParse({ ...files, options: { ...files.options, page: 31 } }).success,
  ).toBe(false);
  for (const extra of [
    { revision: undefined },
    { event: 'PENDING' },
    { event: 'REQUEST_CHANGES', body: ' ' },
    { event: 'COMMENT', body: '' },
    { body: 'x'.repeat(65537) },
    { token: 'secret' },
    { comments: [] },
    { url: 'https://other.test' },
  ])
    expect(
      requestSchema.safeParse({ ...review, options: { ...review.options, ...extra } }).success,
    ).toBe(false);
});

test('inline comment IPC accepts only explicit line or reply targets and stays out of the Git utility', () => {
  const request = {
    id: '00000000-0000-4000-8000-000000000000',
    accountId: 'a'.repeat(64),
    method: 'providerCreateComment',
    options: {
      repository: { owner: 'team', name: 'project' },
      number: 1,
      revision: { head: '1'.repeat(40), base: '2'.repeat(40) },
      body: 'A comment',
      target: { kind: 'line', path: 'src/main.ts', side: 'RIGHT', line: 2 },
    },
  };
  expect(requestSchema.safeParse(request).success).toBe(true);
  expect(serviceRequestSchema.safeParse(request).success).toBe(false);
  expect(
    requestSchema.safeParse({
      ...request,
      options: { ...request.options, target: { kind: 'reply', commentId: 10 } },
    }).success,
  ).toBe(true);
  for (const extra of [
    { body: ' ' },
    { body: 'x'.repeat(65537) },
    { revision: undefined },
    { url: 'https://other.test' },
    { token: 'secret' },
    { target: { kind: 'line', path: 'x', line: 0, side: 'LEFT' } },
    { target: { kind: 'reply', commentId: Number.MAX_SAFE_INTEGER + 1 } },
    { target: { kind: 'reply', commentId: 10, path: 'x' } },
  ])
    expect(
      requestSchema.safeParse({ ...request, options: { ...request.options, ...extra } }).success,
    ).toBe(false);
});

test('PR creation IPC requires reviewed commits and literal branch/template selectors', () => {
  const common = { id: '00000000-0000-4000-8000-000000000000', accountId: 'a'.repeat(64) };
  const options = {
    repository: { owner: 'team', name: 'project' },
    source: { owner: 'contributor', name: 'fork' },
    head: 'feature/name',
    base: 'main',
    revision: { head: '1'.repeat(40), base: '2'.repeat(40) },
    title: 'Change',
    body: '',
    draft: false,
    maintainerCanModify: false,
  };
  const create = { ...common, method: 'providerCreatePull', options };
  expect(requestSchema.safeParse(create).success).toBe(true);
  expect(serviceRequestSchema.safeParse(create).success).toBe(false);
  for (const extra of [
    { revision: undefined },
    { title: ' ' },
    { title: 'x\ny' },
    { body: 'x'.repeat(65537) },
    { head: '../main' },
    { head: 'feature:other' },
    { head: 'a@{1}' },
    { base: '-main' },
    { url: 'https://other.test' },
    { token: 'secret' },
  ])
    expect(requestSchema.safeParse({ ...create, options: { ...options, ...extra } }).success).toBe(
      false,
    );
  const template = {
    ...common,
    method: 'providerPullTemplate',
    options: {
      repository: options.repository,
      revision: options.revision.base,
      path: '.github/PULL_REQUEST_TEMPLATE/bug.md',
    },
  };
  expect(requestSchema.safeParse(template).success).toBe(true);
  expect(serviceRequestSchema.safeParse(template).success).toBe(false);
  for (const path of [
    '../README.md',
    '.github/PULL_REQUEST_TEMPLATE/../secret',
    'README.md',
    '/pull_request_template.md',
  ])
    expect(
      requestSchema.safeParse({ ...template, options: { ...template.options, path } }).success,
    ).toBe(false);
});

test('PR merge IPC requires explicit method and reviewed branch identities without rule bypass options', () => {
  const common = { id: '00000000-0000-4000-8000-000000000000', accountId: 'a'.repeat(64) };
  const options = {
    repository: { owner: 'team', name: 'project' },
    number: 1,
    revision: { head: '1'.repeat(40), base: '2'.repeat(40), headRef: 'feature', baseRef: 'main' },
    method: 'squash',
  };
  const merge = { ...common, method: 'providerMergePull', options };
  const preview = {
    ...common,
    method: 'providerMergePreview',
    options: { repository: options.repository, number: 1 },
  };
  expect(requestSchema.safeParse(merge).success).toBe(true);
  expect(requestSchema.safeParse(preview).success).toBe(true);
  expect(serviceRequestSchema.safeParse(merge).success).toBe(false);
  expect(serviceRequestSchema.safeParse(preview).success).toBe(false);
  for (const extra of [
    { revision: undefined },
    { revision: { head: options.revision.head, base: options.revision.base } },
    { method: 'queue' },
    { method: 'rebase', commitTitle: 'Custom' },
    { commitTitle: ' ' },
    { commitTitle: 'x\ny' },
    { commitMessage: 'x'.repeat(65537) },
    { bypass_rules: true },
    { merge_action: 'merge_queue' },
    { url: 'https://other.test' },
    { token: 'secret' },
  ])
    expect(requestSchema.safeParse({ ...merge, options: { ...options, ...extra } }).success).toBe(
      false,
    );
});

test('PR check IPC permits bounded selectors but no caller-supplied GraphQL or credentials', () => {
  const request = {
    id: '00000000-0000-4000-8000-000000000000',
    accountId: 'a'.repeat(64),
    method: 'providerPullChecks',
    options: {
      repository: { owner: 'team', name: 'project' },
      number: 1,
      head: '1'.repeat(40),
      after: null,
    },
  };
  expect(requestSchema.safeParse(request).success).toBe(true);
  expect(serviceRequestSchema.safeParse(request).success).toBe(false);
  for (const extra of [
    { head: undefined },
    { head: 'main' },
    { after: '' },
    { after: 'x'.repeat(2049) },
    { after: 'a\nb' },
    { query: 'mutation {}' },
    { url: 'https://other.test/graphql' },
    { token: 'secret' },
  ])
    expect(
      requestSchema.safeParse({ ...request, options: { ...request.options, ...extra } }).success,
    ).toBe(false);
});

test('issue browsing IPC permits bounded repository selectors but no credentials or arbitrary URLs', () => {
  const common = { id: '00000000-0000-4000-8000-000000000000', accountId: 'a'.repeat(64) };
  const repository = { owner: 'team', name: 'project' };
  const requests = [
    { ...common, method: 'providerIssues', options: { repository, state: 'open', page: 1 } },
    { ...common, method: 'providerIssue', options: { repository, number: 1 } },
    { ...common, method: 'providerIssueComments', options: { repository, number: 1, page: 1 } },
  ];
  for (const request of requests) {
    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(serviceRequestSchema.safeParse(request).success).toBe(false);
    for (const extra of [
      { token: 'secret' },
      { url: 'https://other.test' },
      { repository: { owner: '..', name: 'project' } },
      { page: 101 },
      { number: -1 },
    ])
      expect(
        requestSchema.safeParse({ ...request, options: { ...request.options, ...extra } }).success,
      ).toBe(false);
  }
});

test('polling policy IPC exposes only account timing and validates retry timestamps', () => {
  const request = {
    id: '00000000-0000-4000-8000-000000000000',
    method: 'providerPollingPolicy',
    accountId: 'a'.repeat(64),
  };
  expect(requestSchema.safeParse(request).success).toBe(true);
  expect(serviceRequestSchema.safeParse(request).success).toBe(false);
  expect(requestSchema.safeParse({ ...request, token: 'secret' }).success).toBe(false);
  const policy = { minimumIntervalMs: 120000, blockedUntil: 1793491320000 };
  expect(resultSchema.safeParse({ kind: 'providerPollingPolicy', policy }).success).toBe(true);
  expect(
    resultSchema.safeParse({
      kind: 'providerPollingPolicy',
      policy: { ...policy, token: 'secret' },
    }).success,
  ).toBe(false);
  for (const retryAt of [-1, Infinity, 1.5, 8640000000000001]) {
    expect(
      resultSchema.safeParse({
        kind: 'error',
        code: 'PROVIDER_RATE_LIMIT',
        message: 'Wait',
        retryAt,
      }).success,
    ).toBe(false);
    expect(
      resultSchema.safeParse({
        kind: 'providerPollingPolicy',
        policy: { ...policy, blockedUntil: retryAt },
      }).success,
    ).toBe(false);
  }
  expect(
    resultSchema.parse({
      kind: 'error',
      code: 'PROVIDER_RATE_LIMIT',
      message: 'Wait',
      retryAt: 1793491320000,
    }),
  ).toMatchObject({ retryAt: 1793491320000 });
});

test('issue action IPC requires bounded text and reviewed state without unrelated changes', () => {
  const common = { id: '00000000-0000-4000-8000-000000000000', accountId: 'a'.repeat(64) };
  const target = {
    repository: { owner: 'team', name: 'project' },
    number: 1,
    revision: 'a'.repeat(64),
  };
  const create = { action: 'create', repository: target.repository, title: 'Title', body: '' };
  const comment = { action: 'comment', ...target, body: 'Comment' };
  const state = { action: 'state', ...target, state: 'closed', reason: 'completed' };
  const preview = {
    ...common,
    method: 'providerIssueActionPreview',
    options: { repository: target.repository, number: 1 },
  };
  expect(requestSchema.safeParse(preview).success).toBe(true);
  expect(serviceRequestSchema.safeParse(preview).success).toBe(false);
  for (const options of [create, comment, state]) {
    const request = { ...common, method: 'providerWriteIssue', options };
    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(serviceRequestSchema.safeParse(request).success).toBe(false);
    for (const extra of [
      { token: 'secret' },
      { url: 'https://other.test' },
      { labels: ['injected'] },
      { body: 'x'.repeat(65537) },
    ])
      expect(
        requestSchema.safeParse({ ...request, options: { ...options, ...extra } }).success,
      ).toBe(false);
  }
  for (const options of [
    { ...create, title: ' ' },
    { ...create, title: 'a\nb' },
    { ...comment, body: ' ' },
    { ...comment, revision: undefined },
    { ...state, revision: undefined },
    { ...state, state: 'open' },
    { ...state, reason: 'reopened' },
    { ...state, reason: 'duplicate', duplicate_issue_id: 2 },
  ])
    expect(
      requestSchema.safeParse({ ...common, method: 'providerWriteIssue', options }).success,
    ).toBe(false);
});

test('GitLab detail IPC accepts nested selectors but never passes provider reads to the Git service', () => {
  const request = {
    id: '00000000-0000-4000-8000-000000000000',
    method: 'providerMergeRequest',
    accountId: 'a'.repeat(64),
    options: { repository: { owner: 'group/subgroup', name: 'project' }, number: 7 },
  };
  expect(requestSchema.safeParse(request).success).toBe(true);
  expect(serviceRequestSchema.safeParse(request).success).toBe(false);
  for (const owner of ['../group', 'group/%2Fsecret', 'group//secret'])
    expect(
      requestSchema.safeParse({
        ...request,
        options: { ...request.options, repository: { owner, name: 'project' } },
      }).success,
    ).toBe(false);
  expect(requestSchema.safeParse({ ...request, token: 'secret' }).success).toBe(false);
});

test('GitLab file reads require all three diff revisions and bounded manual pages', () => {
  const request = {
    id: '00000000-0000-4000-8000-000000000000',
    method: 'providerMergeRequestFiles',
    accountId: 'a'.repeat(64),
    options: {
      repository: { owner: 'group/subgroup', name: 'project' },
      number: 7,
      revision: { head: '1'.repeat(40), base: '2'.repeat(40), start: '3'.repeat(40) },
      page: 1,
    },
  };
  expect(requestSchema.safeParse(request).success).toBe(true);
  expect(serviceRequestSchema.safeParse(request).success).toBe(false);
  for (const page of [0, 31, 1.5])
    expect(
      requestSchema.safeParse({ ...request, options: { ...request.options, page } }).success,
    ).toBe(false);
  expect(
    requestSchema.safeParse({
      ...request,
      options: { ...request.options, revision: { head: '1'.repeat(40), base: '2'.repeat(40) } },
    }).success,
  ).toBe(false);
  expect(
    requestSchema.safeParse({
      ...request,
      options: { ...request.options, endpoint: 'https://attacker.test' },
    }).success,
  ).toBe(false);
});

test('GitLab discussions use bounded selectors and never enter the Git service', () => {
  const request = {
    id: '00000000-0000-4000-8000-000000000000',
    method: 'providerMergeRequestDiscussions',
    accountId: 'a'.repeat(64),
    options: { repository: { owner: 'group/subgroup', name: 'project' }, number: 7, page: 1 },
  };
  expect(requestSchema.safeParse(request).success).toBe(true);
  expect(serviceRequestSchema.safeParse(request).success).toBe(false);
  for (const page of [0, 11, 1.5])
    expect(
      requestSchema.safeParse({ ...request, options: { ...request.options, page } }).success,
    ).toBe(false);
  expect(
    requestSchema.safeParse({
      ...request,
      options: { ...request.options, endpoint: 'https://attacker.test' },
    }).success,
  ).toBe(false);
});

test('GitLab reviewed discussion writes use strict public IPC and cannot enter the Git service', () => {
  const intent = {
    action: 'reply',
    repository: { owner: 'group/subgroup', name: 'project' },
    number: 7,
    discussionId: 'b'.repeat(40),
    body: 'Reply',
  };
  const request = {
    id: '00000000-0000-4000-8000-000000000000',
    method: 'providerWriteMergeDiscussion',
    accountId: 'a'.repeat(64),
    options: { intent, revision: 'c'.repeat(64) },
  };
  expect(requestSchema.safeParse(request).success).toBe(true);
  expect(serviceRequestSchema.safeParse(request).success).toBe(false);
  for (const options of [
    { intent },
    { ...request.options, revision: 'invalid' },
    { ...request.options, intent: { ...intent, discussionId: '../other' } },
    { ...request.options, intent: { ...intent, body: ' ' } },
    { ...request.options, intent: { ...intent, endpoint: 'https://attacker.test' } },
  ])
    expect(requestSchema.safeParse({ ...request, options }).success).toBe(false);
  expect(
    requestSchema.safeParse({
      ...request,
      method: 'providerMergeDiscussionPreview',
      options: intent,
    }).success,
  ).toBe(true);
});

test('GitLab inline discussion selectors require exact three-SHA locations and bounded file pages', () => {
  const options = {
    action: 'inline',
    repository: { owner: 'group/subgroup', name: 'project' },
    number: 7,
    body: 'Comment',
    page: 2,
    position: {
      revision: { base: '2'.repeat(40), head: '1'.repeat(40), start: '3'.repeat(40) },
      oldPath: 'old.ts',
      newPath: 'new.ts',
      oldLine: null,
      newLine: 21,
    },
  };
  const request = {
    id: '00000000-0000-4000-8000-000000000000',
    method: 'providerMergeDiscussionPreview',
    accountId: 'a'.repeat(64),
    options,
  };
  expect(requestSchema.safeParse(request).success).toBe(true);
  expect(serviceRequestSchema.safeParse(request).success).toBe(false);
  for (const invalid of [
    { ...options, page: 31 },
    { ...options, position: { ...options.position, newLine: null } },
    { ...options, position: { ...options.position, oldLine: 0 } },
    { ...options, position: { ...options.position, revision: { head: '1'.repeat(40) } } },
    { ...options, position: { ...options.position, endpoint: 'https://attacker.test' } },
  ])
    expect(requestSchema.safeParse({ ...request, options: invalid }).success).toBe(false);
});

test('GitLab approval IPC requires a reviewed commit and keeps approval passwords out of reads and revocations', () => {
  const options = {
    repository: { owner: 'group/subgroup', name: 'project' },
    number: 7,
    head: '1'.repeat(40),
    action: 'approve',
    revision: 'a'.repeat(64),
    password: 'transient-password',
  };
  const request = {
    id: '00000000-0000-4000-8000-000000000000',
    method: 'providerWriteMergeApproval',
    accountId: 'a'.repeat(64),
    options,
  };
  expect(requestSchema.safeParse(request).success).toBe(true);
  expect(serviceRequestSchema.safeParse(request).success).toBe(false);
  for (const invalid of [
    { ...options, head: '' },
    { ...options, revision: undefined },
    { ...options, action: 'unapprove' },
    { ...options, action: 'reset' },
  ])
    expect(requestSchema.safeParse({ ...request, options: invalid }).success).toBe(false);
  expect(
    requestSchema.safeParse({ ...request, method: 'providerMergeApprovalPreview' }).success,
  ).toBe(false);
  expect(
    requestSchema.safeParse({
      ...request,
      method: 'providerMergeApprovals',
      options: { repository: options.repository, number: 7 },
    }).success,
  ).toBe(true);
});
test('GitLab creation and template IPC bind drafts and reviewed selections without Git-service access', () => {
  const envelope = { id: '00000000-0000-4000-8000-000000000000', accountId: 'a'.repeat(64) };
  const repository = { owner: 'group/subgroup', name: 'project' };
  const intent = {
    repository,
    source: repository,
    head: 'feature/topic',
    base: 'main',
    title: 'Title',
    body: 'Body',
    draft: true,
    maintainerCanModify: false,
  };
  const write = {
    ...envelope,
    method: 'providerCreateMergeRequest',
    options: { intent, revision: 'b'.repeat(64) },
  };
  expect(requestSchema.safeParse(write).success).toBe(true);
  expect(serviceRequestSchema.safeParse(write).success).toBe(false);
  expect(requestSchema.safeParse({ ...write, options: { intent } }).success).toBe(false);
  expect(
    requestSchema.safeParse({
      ...write,
      options: { ...write.options, intent: { ...intent, head: '../bad' } },
    }).success,
  ).toBe(false);
  expect(
    requestSchema.safeParse({
      ...envelope,
      method: 'providerPreviewMergeCreation',
      options: intent,
    }).success,
  ).toBe(true);
  const template = {
    ...envelope,
    method: 'providerMergeTemplate',
    options: { repository, revision: 'c'.repeat(64), key: 'Feature' },
  };
  expect(requestSchema.safeParse(template).success).toBe(true);
  expect(serviceRequestSchema.safeParse(template).success).toBe(false);
  for (const key of ['..', '.', '../outside', 'bad\\name', 'bad\nname'])
    expect(
      requestSchema.safeParse({ ...template, options: { ...template.options, key } }).success,
    ).toBe(false);
});
test('GitLab merge IPC requires reviewed intent and rejects queues, unsupported methods and message mismatches', () => {
  const envelope = { id: '00000000-0000-4000-8000-000000000000', accountId: 'a'.repeat(64) };
  const target = { repository: { owner: 'group/subgroup', name: 'project' }, number: 7 };
  const intent = {
    ...target,
    head: 'b'.repeat(40),
    squash: true,
    removeSourceBranch: false,
    squashMessage: 'Message',
  };
  const write = {
    ...envelope,
    method: 'providerMergeRequestMerge',
    options: { intent, revision: 'c'.repeat(64) },
  };
  expect(requestSchema.safeParse(write).success).toBe(true);
  expect(serviceRequestSchema.safeParse(write).success).toBe(false);
  expect(requestSchema.safeParse({ ...write, options: { intent } }).success).toBe(false);
  for (const changed of [
    { ...intent, autoMerge: true },
    { ...intent, method: 'rebase' },
    { ...intent, head: 'bad' },
    { ...intent, squash: false },
  ])
    expect(
      requestSchema.safeParse({ ...write, options: { ...write.options, intent: changed } }).success,
    ).toBe(false);
  expect(
    requestSchema.safeParse({
      ...envelope,
      method: 'providerMergeRequestMergeState',
      options: target,
    }).success,
  ).toBe(true);
  expect(
    requestSchema.safeParse({
      ...envelope,
      method: 'providerMergeRequestMergePreview',
      options: intent,
    }).success,
  ).toBe(true);
});

test('GitLab pipelines and jobs require bounded pages and pinned commits outside the Git service', () => {
  const base = {
    id: '00000000-0000-4000-8000-000000000000',
    accountId: 'a'.repeat(64),
    options: {
      repository: { owner: 'group/subgroup', name: 'project' },
      number: 7,
      head: '1'.repeat(40),
      page: 1,
    },
  };
  for (const request of [
    { ...base, method: 'providerMergeRequestPipelines' },
    {
      ...base,
      method: 'providerMergeRequestPipelineJobs',
      options: { ...base.options, pipelineId: '9', pipelineSha: '2'.repeat(40), pipelinePage: 1 },
    },
  ]) {
    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(serviceRequestSchema.safeParse(request).success).toBe(false);
    for (const extra of [
      { page: 0 },
      { page: 11 },
      { head: 'bad' },
      { endpoint: 'https://attacker.test' },
    ])
      expect(
        requestSchema.safeParse({ ...request, options: { ...request.options, ...extra } }).success,
      ).toBe(false);
    expect(requestSchema.safeParse({ ...request, token: 'secret' }).success).toBe(false);
  }
  const jobs = {
    ...base,
    method: 'providerMergeRequestPipelineJobs',
    options: { ...base.options, pipelineId: '9', pipelineSha: '2'.repeat(40), pipelinePage: 1 },
  };
  for (const extra of [
    { pipelineId: '9007199254740992' },
    { pipelineId: '../9' },
    { pipelinePage: 11 },
    { pipelineSha: '' },
  ])
    expect(
      requestSchema.safeParse({ ...jobs, options: { ...jobs.options, ...extra } }).success,
    ).toBe(false);
});
