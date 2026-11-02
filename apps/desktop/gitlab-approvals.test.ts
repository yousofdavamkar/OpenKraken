import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { protection } from '../../tests/provider-protection.js';
import { gitlabMergeFixture } from '../../tests/gitlab-fixtures.js';
import { ProviderService } from './src/providers.js';
import { ProviderVault } from './src/provider-vault.js';

const root = await mkdtemp(join(tmpdir(), 'openkraken-gitlab-discussions-'));
const server = setupServer();
const repository = { owner: 'group/subgroup', name: 'project' };
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});
async function setup(name: string, origin = 'https://gitlab.com') {
  const directory = join(root, name);
  const service = new ProviderService(directory, new ProviderVault(directory, protection()));
  server.use(
    http.get(`${origin}/api/v4/user`, () => HttpResponse.json({ id: 73, username: 'gitlab-user' })),
    http.get(`${origin}/api/v4/projects/:project`, () =>
      HttpResponse.json({ id: 77, path_with_namespace: 'group/subgroup/project' }),
    ),
    http.get(`${origin}/api/v4/projects/77/merge_requests/7`, () =>
      HttpResponse.json(gitlabMergeFixture(7)),
    ),
  );
  const account = (
    await service.connect({ provider: 'gitlab', origin, token: 'discussion-secret' })
  ).accounts[0]!;
  return { service, account, origin };
}

const approvals = () => ({
  approved: true,
  user_can_approve: true,
  user_has_approved: false,
  approved_by: [{ user: { id: 81, username: 'reviewer' }, approved_at: '2026-10-02T12:00:00Z' }],
});
test('GitLab approval reads preserve Community and Enterprise metadata without inventing missing requirements', async () => {
  const { service, account, origin } = await setup('read');
  let enterprise = false;
  server.use(
    http.get(`${origin}/api/v4/projects/77/merge_requests/7/approvals`, () =>
      HttpResponse.json({
        ...approvals(),
        ...(enterprise
          ? {
              approved: false,
              id: 1007,
              iid: 7,
              project_id: 77,
              approvals_required: 2,
              approvals_left: 1,
              require_password_to_approve: true,
              approval_rules_left: [
                { id: 9, name: 'Security <script>rule</script>', rule_type: 'code_owner' },
              ],
              invalid_approvers_rules: [],
            }
          : {}),
      }),
    ),
  );
  const community = await service.mergeApprovals(account.id, { repository, number: 7 });
  expect(community).toMatchObject({
    mergeRequest: { id: '1007', number: 7 },
    state: {
      approved: true,
      canApprove: true,
      hasApproved: false,
      required: null,
      remaining: null,
      passwordRequired: null,
      rulesLeft: null,
      invalidRules: null,
      approvedBy: [{ id: '81', login: 'reviewer', approvedAt: '2026-10-02T12:00:00Z' }],
    },
  });
  enterprise = true;
  expect(await service.mergeApprovals(account.id, { repository, number: 7 })).toMatchObject({
    state: {
      required: 2,
      remaining: 1,
      passwordRequired: true,
      rulesLeft: [{ id: '9', name: 'Security <script>rule</script>', type: 'code_owner' }],
      invalidRules: [],
    },
  });
});

test('GitLab approval confirmation binds the account, current head and state, and sends SHA-conditional approval once', async () => {
  const { service, account, origin } = await setup('writes', 'https://gitlab.example.test');
  let state = { ...approvals(), require_password_to_approve: true };
  const writes: unknown[] = [];
  const base = `${origin}/api/v4/projects/77/merge_requests/7`;
  server.use(
    http.get(`${base}/approvals`, () => HttpResponse.json(state)),
    http.post(`${base}/approve`, async ({ request }) => {
      writes.push({ action: 'approve', body: await request.json() });
      state = {
        ...state,
        user_has_approved: true,
        user_can_approve: false,
        approved_by: [
          ...state.approved_by,
          { user: { id: 73, username: 'gitlab-user' }, approved_at: '2026-10-03T00:00:00Z' },
        ],
      };
      return HttpResponse.json(state, { status: 201 });
    }),
    http.post(`${base}/unapprove`, async ({ request }) => {
      writes.push({ action: 'unapprove', body: await request.text() });
      state = {
        ...state,
        user_has_approved: false,
        user_can_approve: true,
        approved_by: state.approved_by.filter((entry) => entry.user.id !== 73),
      };
      return HttpResponse.json(state, { status: 201 });
    }),
  );
  const intent = { repository, number: 7, action: 'approve' as const, head: '1'.repeat(40) };
  const preview = await service.previewMergeApproval(account.id, intent);
  expect(preview).toMatchObject({ state: { passwordRequired: true, hasApproved: false } });
  expect(writes).toEqual([]);
  state.approved_by[0]!.approved_at = '2026-10-04T00:00:00Z';
  await expect(
    service.writeMergeApproval(account.id, {
      ...intent,
      revision: preview.revision,
      password: 'approval-password',
    }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_APPROVAL' });
  const fresh = await service.previewMergeApproval(account.id, intent);
  await expect(
    service.writeMergeApproval(account.id, { ...intent, revision: fresh.revision }),
  ).rejects.toMatchObject({ code: 'PROVIDER_APPROVAL_PASSWORD' });
  expect(writes).toEqual([]);
  const result = await service.writeMergeApproval(account.id, {
    ...intent,
    revision: fresh.revision,
    password: 'approval-password',
  });
  expect(result).toMatchObject({ hasApproved: true, approvedBy: [{ id: '81' }, { id: '73' }] });
  expect(JSON.stringify(result)).not.toContain('approval-password');
  expect(writes).toEqual([
    { action: 'approve', body: { sha: '1'.repeat(40), approval_password: 'approval-password' } },
  ]);
  const remove = { ...intent, action: 'unapprove' as const };
  const removal = await service.previewMergeApproval(account.id, remove);
  expect(
    await service.writeMergeApproval(account.id, { ...remove, revision: removal.revision }),
  ).toMatchObject({ hasApproved: false });
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual({ action: 'unapprove', body: '{}' });
});

test('GitLab refuses foreign, inconsistent, duplicate or oversized approval data', async () => {
  const { service, account, origin } = await setup('invalid');
  const duplicateRule = { id: 9, name: 'Rule', rule_type: 'regular' };
  for (const state of [
    { ...approvals(), id: 1008 },
    { ...approvals(), iid: 8 },
    { ...approvals(), project_id: 78 },
    { ...approvals(), user_has_approved: true },
    { ...approvals(), approved_by: [approvals().approved_by[0], approvals().approved_by[0]] },
    { ...approvals(), approval_rules_left: [duplicateRule, duplicateRule] },
    {
      ...approvals(),
      approved_by: Array.from({ length: 1001 }, (_, i) => ({
        user: { id: i + 100, username: 'user' },
      })),
    },
    { ...approvals(), approvals_left: -1 },
  ]) {
    server.use(
      http.get(`${origin}/api/v4/projects/77/merge_requests/7/approvals`, () =>
        HttpResponse.json(state),
      ),
    );
    await expect(
      service.mergeApprovals(account.id, { repository, number: 7 }),
    ).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' });
  }
});

test('GitLab approval reviews refuse stale heads, unavailable permissions and changes during reads', async () => {
  const { service, account, origin } = await setup('guards');
  let state = approvals();
  let merge = gitlabMergeFixture(7);
  let change = false;
  const base = `${origin}/api/v4/projects/77/merge_requests/7`;
  server.use(
    http.get(base, () => HttpResponse.json(merge)),
    http.get(`${base}/approvals`, () => {
      if (change) merge = { ...merge, sha: '4'.repeat(40) };
      return HttpResponse.json(state);
    }),
  );
  const intent = { repository, number: 7, action: 'approve' as const, head: '1'.repeat(40) };
  await expect(
    service.previewMergeApproval(account.id, { ...intent, head: '5'.repeat(40) }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_APPROVAL' });
  await expect(
    service.previewMergeApproval(account.id, { ...intent, action: 'unapprove' }),
  ).rejects.toMatchObject({ code: 'PROVIDER_APPROVAL_STATE' });
  state = { ...state, user_can_approve: false };
  await expect(service.previewMergeApproval(account.id, intent)).rejects.toMatchObject({
    code: 'PROVIDER_APPROVAL_STATE',
  });
  state = approvals();
  change = true;
  await expect(service.mergeApprovals(account.id, { repository, number: 7 })).rejects.toMatchObject(
    { code: 'STALE_PROVIDER_APPROVAL' },
  );
});

test('GitLab approval failures and cancellation never retry or expose credentials', async () => {
  const { service, account, origin } = await setup('failures');
  const base = `${origin}/api/v4/projects/77/merge_requests/7`;
  server.use(http.get(`${base}/approvals`, () => HttpResponse.json(approvals())));
  const intent = { repository, number: 7, action: 'approve' as const, head: '1'.repeat(40) };
  const preview = await service.previewMergeApproval(account.id, intent);
  let writes = 0;
  for (const status of [409, 403, 503, 201]) {
    server.use(
      http.post(`${base}/approve`, () => {
        writes++;
        return HttpResponse.json({ message: 'approval-password discussion-secret' }, { status });
      }),
    );
    await expect(
      service.writeMergeApproval(account.id, {
        ...intent,
        revision: preview.revision,
        password: 'approval-password',
      }),
    ).rejects.toMatchObject({
      code:
        status === 409 || status === 403 ? 'PROVIDER_WRITE_REJECTED' : 'PROVIDER_WRITE_UNCERTAIN',
      message: expect.not.stringMatching(/approval-password|discussion-secret/),
    });
  }
  const early = new AbortController();
  early.abort();
  await expect(
    service.writeMergeApproval(account.id, { ...intent, revision: preview.revision }, early.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(writes).toBe(4);
  const late = new AbortController();
  server.use(
    http.post(`${base}/approve`, () => {
      writes++;
      late.abort();
      return HttpResponse.json({}, { status: 201 });
    }),
  );
  await expect(
    service.writeMergeApproval(account.id, { ...intent, revision: preview.revision }, late.signal),
  ).rejects.toMatchObject({ code: 'PROVIDER_WRITE_UNCERTAIN' });
  expect(writes).toBe(5);
});
