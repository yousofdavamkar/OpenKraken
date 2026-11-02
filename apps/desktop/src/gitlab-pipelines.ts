import { Jobs, MergeRequests, Pipelines, Projects } from '@gitbeaker/rest';
import { z } from 'zod';
import {
  providerMergePipelinesOptionsSchema,
  providerMergePipelinesPageSchema,
  providerMergePipelineJobsOptionsSchema,
  providerMergePipelineJobsPageSchema,
  providerRepositoryTargetSchema,
  type ProviderMergePipelinesOptions,
  type ProviderMergePipelineJobsOptions,
} from '@openkraken/ipc-contract';
import { loadMergeRequest, type GitLabRead } from './gitlab-merges.js';
import { ProviderError } from './provider-error.js';
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const date = z.string().datetime({ offset: true });
const duration = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish();
const pipelineSchema = z.object({
  id: integer,
  project_id: integer.nullish(),
  sha: oid,
  ref: z.string().min(1).max(1024),
  status: z.string().min(1).max(128),
  name: z.string().max(1024).nullish(),
  source: z.string().min(1).max(128).nullish(),
  created_at: date.nullish(),
  updated_at: date.nullish(),
});
const normalize = (data: z.infer<typeof pipelineSchema>) => ({
  id: String(data.id),
  projectId:
    data.project_id === null || data.project_id === undefined ? null : String(data.project_id),
  sha: data.sha,
  ref: data.ref,
  status: data.status,
  name: data.name ?? null,
  source: data.source ?? null,
  createdAt: data.created_at ?? null,
  updatedAt: data.updated_at ?? null,
});
const context = async (
  read: GitLabRead,
  origin: string,
  options: ProviderMergePipelinesOptions,
) => {
  const merge = await loadMergeRequest(read, origin, {
    repository: options.repository,
    number: options.number,
  });
  if (merge.source.sha !== options.head)
    throw new ProviderError(
      'STALE_PROVIDER_PIPELINE',
      'The merge-request source commit changed. Refresh details before loading pipelines.',
    );
  return { id: merge.id, source: merge.source, target: merge.target };
};
function guard(before: unknown, after: unknown) {
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new ProviderError(
      'STALE_PROVIDER_PIPELINE',
      'The merge-request context changed. Refresh details and pipelines.',
    );
}
async function list(read: GitLabRead, projectId: string, number: number, page: number) {
  return read(`projects/${projectId}/merge_requests/${number}/pipelines`, async (client) => {
    const data = z
      .array(pipelineSchema)
      .max(100)
      .parse(
        await new MergeRequests(client).allPipelines(Number(projectId), number, {
          page,
          perPage: 100,
          maxPages: 1,
          pagination: 'offset',
        }),
      );
    if (new Set(data.map((entry) => entry.id)).size !== data.length)
      throw new ProviderError(
        'PROVIDER_RESPONSE',
        'GitLab returned duplicate pipeline identities.',
      );
    return data;
  });
}
export async function loadMergeRequestPipelines(
  read: GitLabRead,
  origin: string,
  input: ProviderMergePipelinesOptions,
) {
  const options = providerMergePipelinesOptionsSchema.parse(input);
  const before = await context(read, origin, options);
  const data = await list(read, before.target.projectId, options.number, options.page);
  guard(before, await context(read, origin, options));
  return providerMergePipelinesPageSchema.parse({
    pipelines: data.map(normalize),
    nextPage: data.length === 100 && options.page < 10 ? options.page + 1 : null,
    limited: data.length === 100 && options.page === 10,
  });
}
export async function loadMergeRequestPipelineJobs(
  read: GitLabRead,
  origin: string,
  input: ProviderMergePipelineJobsOptions,
) {
  const options = providerMergePipelineJobsOptionsSchema.parse(input);
  const before = await context(read, origin, options);
  const selected = (
    await list(read, before.target.projectId, options.number, options.pipelinePage)
  ).find((entry) => String(entry.id) === options.pipelineId);
  if (!selected || selected.sha !== options.pipelineSha)
    throw new ProviderError(
      'STALE_PROVIDER_PIPELINE',
      'The selected pipeline is no longer on its reviewed page. Refresh pipelines and select it again.',
    );
  const allowed = [
    ...new Set([
      before.target.projectId,
      ...(before.source.projectId ? [before.source.projectId] : []),
    ]),
  ];
  if (
    selected.project_id !== null &&
    selected.project_id !== undefined &&
    !allowed.includes(String(selected.project_id))
  )
    throw new ProviderError('PROVIDER_RESPONSE', 'The pipeline belongs to an unexpected project.');
  const candidates =
    selected.project_id === null || selected.project_id === undefined
      ? allowed
      : [String(selected.project_id)];
  const detailSchema = pipelineSchema.extend({
    project_id: integer,
    duration,
    queued_duration: duration,
  });
  let detail: z.infer<typeof detailSchema> | undefined;
  for (const projectId of candidates) {
    try {
      detail = await read(
        `projects/${projectId}/pipelines/${options.pipelineId}`,
        async (client) => {
          const data = detailSchema.parse(
            await new Pipelines(client).show(Number(projectId), Number(options.pipelineId)),
          );
          if (
            String(data.id) !== options.pipelineId ||
            String(data.project_id) !== projectId ||
            data.sha !== selected.sha ||
            data.ref !== selected.ref
          )
            throw new ProviderError(
              'PROVIDER_RESPONSE',
              'GitLab returned another pipeline or commit.',
            );
          return data;
        },
      );
      break;
    } catch (error) {
      if (!(error instanceof ProviderError) || error.httpStatus !== 404) throw error;
    }
  }
  if (!detail)
    throw new ProviderError(
      'PROVIDER_REQUEST',
      'The selected pipeline was not found in the merge-request projects.',
    );
  const pipeline = detail;
  const project = await read(`projects/${pipeline.project_id}`, async (client) => {
    const data = z
      .object({ id: integer, path_with_namespace: z.string().min(3).max(2304) })
      .parse(await new Projects(client).show(pipeline.project_id));
    if (data.id !== pipeline.project_id)
      throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned another pipeline project.');
    const parts = data.path_with_namespace.split('/');
    const repository = providerRepositoryTargetSchema.parse({
      owner: parts.slice(0, -1).join('/'),
      name: parts.at(-1),
    });
    if (
      String(data.id) === before.target.projectId &&
      (repository.owner !== options.repository.owner || repository.name !== options.repository.name)
    )
      throw new ProviderError(
        'STALE_PROVIDER_PIPELINE',
        'The pipeline project path changed. Choose the repository again.',
      );
    return `${origin}/${repository.owner}/${repository.name}`;
  });
  const jobs = await read(
    `projects/${pipeline.project_id}/pipelines/${pipeline.id}/jobs`,
    async (client) => {
      const data = z
        .array(
          z.object({
            id: integer,
            name: z.string().min(1).max(1024),
            stage: z.string().min(1).max(1024),
            status: z.string().min(1).max(128),
            ref: z.string().min(1).max(1024),
            allow_failure: z.boolean(),
            created_at: date,
            started_at: date.nullish(),
            finished_at: date.nullish(),
            duration,
            queued_duration: duration,
            failure_reason: z.string().max(1024).nullish(),
            pipeline: z.object({
              id: integer,
              project_id: integer,
              sha: oid,
              ref: z.string().min(1).max(1024),
            }),
            commit: z.object({ id: oid }),
          }),
        )
        .max(100)
        .parse(
          await new Jobs(client).all(pipeline.project_id, {
            pipelineId: pipeline.id,
            includeRetried: false,
            page: options.page,
            perPage: 100,
            maxPages: 1,
            pagination: 'offset',
          }),
        );
      if (
        new Set(data.map((entry) => entry.id)).size !== data.length ||
        data.some(
          (entry) =>
            entry.pipeline.id !== pipeline.id ||
            entry.pipeline.project_id !== pipeline.project_id ||
            entry.pipeline.sha !== pipeline.sha ||
            entry.pipeline.ref !== pipeline.ref ||
            entry.commit.id !== pipeline.sha ||
            entry.ref !== pipeline.ref,
        )
      )
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'GitLab returned duplicate or unrelated pipeline jobs.',
        );
      return data.map((entry) => ({
        id: String(entry.id),
        name: entry.name,
        stage: entry.stage,
        status: entry.status,
        allowFailure: entry.allow_failure,
        createdAt: entry.created_at,
        startedAt: entry.started_at ?? null,
        finishedAt: entry.finished_at ?? null,
        duration: entry.duration ?? null,
        queuedDuration: entry.queued_duration ?? null,
        failureReason: entry.failure_reason ?? null,
        url: `${project}/-/jobs/${entry.id}`,
      }));
    },
  );
  guard(before, await context(read, origin, options));
  return providerMergePipelineJobsPageSchema.parse({
    pipeline: {
      ...normalize(pipeline),
      projectId: String(pipeline.project_id),
      url: `${project}/-/pipelines/${pipeline.id}`,
      duration: pipeline.duration ?? null,
      queuedDuration: pipeline.queued_duration ?? null,
    },
    jobs,
    nextPage: jobs.length === 100 && options.page < 10 ? options.page + 1 : null,
    limited: jobs.length === 100 && options.page === 10,
  });
}
