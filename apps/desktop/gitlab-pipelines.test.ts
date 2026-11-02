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
const root = await mkdtemp(join(tmpdir(), 'openkraken-gitlab-pipelines-'));
const server = setupServer();
const repository = { owner: 'group/subgroup', name: 'project' };
const options = { repository, number: 7, head: '1'.repeat(40), page: 1 };
const pipeline = (id = 9) => ({ id, sha: '1'.repeat(40), ref: 'feature', status: 'running' });
const job = (id = 21) => ({
  id,
  name: 'test <script>literal</script>',
  stage: 'test',
  status: 'failed',
  ref: 'feature',
  allow_failure: true,
  created_at: '2026-11-02T00:00:00Z',
  started_at: null,
  finished_at: null,
  duration: 1.5,
  queued_duration: null,
  failure_reason: 'script_failure',
  pipeline: { ...pipeline(), project_id: 88 },
  commit: { id: '1'.repeat(40) },
  web_url: 'https://attacker.test/ignored',
});
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});
async function setup(name: string, origin = 'https://gitlab.com') {
  const directory = join(root, name);
  const service = new ProviderService(directory, new ProviderVault(directory, protection()));
  const state = {
    merge: gitlabMergeFixture(7),
    pipelines: [pipeline()],
    jobs: [job()],
    targetStatus: 404,
    targetReads: 0,
    sourceReads: 0,
    jobsReads: 0,
  };
  server.use(
    http.get(`${origin}/api/v4/user`, () => HttpResponse.json({ id: 73, username: 'contributor' })),
    http.get(`${origin}/api/v4/projects/:project`, ({ params }) =>
      HttpResponse.json(
        params.project === '88'
          ? { id: 88, path_with_namespace: 'contributor/subgroup/fork' }
          : { id: 77, path_with_namespace: 'group/subgroup/project' },
      ),
    ),
    http.get(`${origin}/api/v4/projects/77/merge_requests/7`, () => HttpResponse.json(state.merge)),
    http.get(`${origin}/api/v4/projects/77/merge_requests/7/pipelines`, ({ request }) => {
      expect(new URL(request.url).searchParams.get('per_page')).toBe('100');
      return HttpResponse.json(state.pipelines);
    }),
    http.get(`${origin}/api/v4/projects/77/pipelines/9`, () => {
      state.targetReads++;
      return HttpResponse.json({ message: 'pipeline-secret' }, { status: state.targetStatus });
    }),
    http.get(`${origin}/api/v4/projects/88/pipelines/9`, () => {
      state.sourceReads++;
      return HttpResponse.json({
        ...pipeline(),
        project_id: 88,
        source: 'merge_request_event',
        name: 'Pipeline <script>name</script>',
        created_at: '2026-11-02T00:00:00Z',
        updated_at: '2026-11-02T00:01:00Z',
        duration: null,
        queued_duration: 0.3,
        web_url: 'https://attacker.test/ignored',
      });
    }),
    http.get(`${origin}/api/v4/projects/88/pipelines/9/jobs`, ({ request }) => {
      state.jobsReads++;
      expect(new URL(request.url).searchParams.get('include_retried')).toBe('false');
      return HttpResponse.json(state.jobs);
    }),
  );
  const account = (await service.connect({ provider: 'gitlab', origin, token: 'pipeline-secret' }))
    .accounts[0]!;
  return { service, account, origin, state };
}
const jobsOptions = { ...options, pipelineId: '9', pipelineSha: '1'.repeat(40), pipelinePage: 1 };
test('GitLab pipeline pages preserve native statuses, minimal metadata and different commit contexts with bounded paging', async () => {
  const { service, account, state } = await setup('pages');
  state.pipelines = Array.from({ length: 100 }, (_, index) => ({
    ...pipeline(index + 1),
    sha: index ? '2'.repeat(40) : options.head,
    status: index ? 'manual' : 'success',
  }));
  const page = await service.mergeRequestPipelines(account.id, options);
  expect(page).toMatchObject({ nextPage: 2, limited: false });
  expect(page.pipelines[0]).toMatchObject({
    id: '1',
    projectId: null,
    sha: options.head,
    status: 'success',
    name: null,
    source: null,
  });
  expect(page.pipelines[1]).toMatchObject({ sha: '2'.repeat(40), status: 'manual' });
  expect(await service.mergeRequestPipelines(account.id, { ...options, page: 10 })).toMatchObject({
    nextPage: null,
    limited: true,
  });
});
test('GitLab jobs bind selected page membership and discover an omitted fork project only after a 404', async () => {
  const { service, account, state } = await setup('jobs', 'https://gitlab.example.test');
  const page = await service.mergeRequestPipelineJobs(account.id, jobsOptions);
  expect(page).toMatchObject({
    pipeline: {
      id: '9',
      projectId: '88',
      source: 'merge_request_event',
      url: 'https://gitlab.example.test/contributor/subgroup/fork/-/pipelines/9',
    },
    jobs: [
      {
        id: '21',
        name: 'test <script>literal</script>',
        status: 'failed',
        allowFailure: true,
        duration: 1.5,
        url: 'https://gitlab.example.test/contributor/subgroup/fork/-/jobs/21',
      },
    ],
    nextPage: null,
    limited: false,
  });
  expect(state.targetReads).toBe(1);
  expect(state.sourceReads).toBe(1);
  state.targetStatus = 403;
  await expect(service.mergeRequestPipelineJobs(account.id, jobsOptions)).rejects.toMatchObject({
    code: 'PROVIDER_AUTH',
  });
  expect(state.sourceReads).toBe(1);
  await expect(
    service.mergeRequestPipelineJobs(account.id, { ...jobsOptions, pipelineId: '10' }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_PIPELINE' });
  await expect(
    service.mergeRequestPipelineJobs(account.id, { ...jobsOptions, pipelineSha: '3'.repeat(40) }),
  ).rejects.toMatchObject({ code: 'STALE_PROVIDER_PIPELINE' });
  expect(state.jobsReads).toBe(1);
});

test('GitLab rejects stale merge context before dispatch and during pipeline or job reads', async () => {
  const { service, account, state } = await setup('stale');
  state.merge.sha = '4'.repeat(40);
  await expect(service.mergeRequestPipelineJobs(account.id, jobsOptions)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_PIPELINE',
  });
  expect(state.sourceReads + state.targetReads + state.jobsReads).toBe(0);
  state.merge.sha = options.head;
  server.use(
    http.get('https://gitlab.com/api/v4/projects/77/merge_requests/7/pipelines', () => {
      state.merge.source_branch = 'different';
      return HttpResponse.json(state.pipelines);
    }),
  );
  await expect(service.mergeRequestPipelines(account.id, options)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_PIPELINE',
  });
  server.use(
    http.get('https://gitlab.com/api/v4/projects/88/pipelines/9/jobs', () => {
      state.merge.sha = '5'.repeat(40);
      return HttpResponse.json(state.jobs);
    }),
  );
  await expect(service.mergeRequestPipelineJobs(account.id, jobsOptions)).rejects.toMatchObject({
    code: 'STALE_PROVIDER_PIPELINE',
  });
});

test('GitLab validates pipeline ownership, details and every job binding without forwarding provider payloads', async () => {
  const { service, account, state } = await setup('binding');
  const path = 'https://gitlab.com/api/v4/projects/77/merge_requests/7/pipelines';
  server.use(http.get(path, () => HttpResponse.json([{ ...pipeline(), project_id: 999 }])));
  await expect(service.mergeRequestPipelineJobs(account.id, jobsOptions)).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
  expect(state.targetReads + state.sourceReads).toBe(0);
  server.use(http.get(path, () => HttpResponse.json([{ ...pipeline(), project_id: 88 }])));
  await expect(service.mergeRequestPipelineJobs(account.id, jobsOptions)).resolves.toMatchObject({
    pipeline: { projectId: '88' },
  });
  expect(state.targetReads).toBe(0);
  for (const extra of [{ id: 10 }, { project_id: 77 }, { sha: '2'.repeat(40) }, { ref: 'other' }]) {
    server.use(
      http.get('https://gitlab.com/api/v4/projects/88/pipelines/9', () =>
        HttpResponse.json({ ...pipeline(), project_id: 88, ...extra }),
      ),
    );
    await expect(service.mergeRequestPipelineJobs(account.id, jobsOptions)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
    });
  }
  server.use(
    http.get('https://gitlab.com/api/v4/projects/88/pipelines/9', () =>
      HttpResponse.json({ ...pipeline(), project_id: 88 }),
    ),
  );
  for (const extra of [
    { pipeline: { ...job().pipeline, id: 10 } },
    { pipeline: { ...job().pipeline, project_id: 77 } },
    { pipeline: { ...job().pipeline, sha: '2'.repeat(40) } },
    { pipeline: { ...job().pipeline, ref: 'other' } },
    { commit: { id: '2'.repeat(40) } },
    { ref: 'other' },
  ]) {
    state.jobs = [{ ...job(), ...extra }];
    await expect(service.mergeRequestPipelineJobs(account.id, jobsOptions)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
    });
  }
  state.jobs = [job(), job()];
  await expect(service.mergeRequestPipelineJobs(account.id, jobsOptions)).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
  state.jobs = Array.from({ length: 100 }, (_, i) => job(i + 1));
  await expect(service.mergeRequestPipelineJobs(account.id, jobsOptions)).resolves.toMatchObject({
    nextPage: 2,
    limited: false,
  });
  await expect(
    service.mergeRequestPipelineJobs(account.id, { ...jobsOptions, page: 10 }),
  ).resolves.toMatchObject({ nextPage: null, limited: true });
  state.jobs.push(job(101));
  await expect(service.mergeRequestPipelineJobs(account.id, jobsOptions)).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
});

test('GitLab pipeline duplicate and oversized pages fail closed and cancellation does not discover other projects', async () => {
  const { service, account, state } = await setup('bounds');
  state.pipelines = [pipeline(), pipeline()];
  await expect(service.mergeRequestPipelines(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
  state.pipelines = Array.from({ length: 101 }, (_, i) => pipeline(i + 1));
  await expect(service.mergeRequestPipelines(account.id, options)).rejects.toMatchObject({
    code: 'PROVIDER_RESPONSE',
  });
  state.pipelines = [pipeline()];
  server.use(
    http.get('https://gitlab.com/api/v4/projects/77/pipelines/9', () => HttpResponse.error()),
  );
  await expect(service.mergeRequestPipelineJobs(account.id, jobsOptions)).rejects.toMatchObject({
    code: 'PROVIDER_REQUEST',
  });
  expect(state.sourceReads).toBe(0);
  const controller = new AbortController();
  controller.abort();
  await expect(
    service.mergeRequestPipelines(account.id, options, controller.signal),
  ).rejects.toBeDefined();
  expect(state.jobsReads).toBe(0);
});
