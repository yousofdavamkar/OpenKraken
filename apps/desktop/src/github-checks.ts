import { z } from 'zod';
import type { Octokit } from '@octokit/rest';
import {
  oidSchema,
  providerCheckStateSchema,
  providerCheckRunStatusSchema,
  providerCheckConclusionSchema,
  providerPullChecksPageSchema,
  type ProviderPullChecksOptions,
} from '@openkraken/ipc-contract';
import { ProviderError } from './provider-error.js';
const query = `query OpenKrakenPullChecks($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      commits(last: 1) { nodes { commit {
        oid
        statusCheckRollup {
          state
          contexts(first: 100, after: $after) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on CheckRun { id name status conclusion }
              ... on StatusContext { id context state description }
            }
          }
        }
      } } }
    }
  }
}`;
const node = z.discriminatedUnion('__typename', [
  z.object({
    __typename: z.literal('CheckRun'),
    id: z.string(),
    name: z.string(),
    status: providerCheckRunStatusSchema,
    conclusion: providerCheckConclusionSchema.nullable(),
  }),
  z.object({
    __typename: z.literal('StatusContext'),
    id: z.string(),
    context: z.string(),
    state: providerCheckStateSchema,
    description: z.string().nullable(),
  }),
]);
const envelope = z.object({
  errors: z.array(z.unknown()).max(0).optional(),
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        headRefOid: oidSchema,
        commits: z.object({
          nodes: z
            .array(
              z.object({
                commit: z.object({
                  oid: oidSchema,
                  statusCheckRollup: z
                    .object({
                      state: providerCheckStateSchema,
                      contexts: z.object({
                        totalCount: z.number().int().nonnegative(),
                        nodes: z.array(node).max(100),
                        pageInfo: z.object({
                          hasNextPage: z.boolean(),
                          endCursor: z.string().nullable(),
                        }),
                      }),
                    })
                    .nullable(),
                }),
              }),
            )
            .length(1),
        }),
      }),
    }),
  }),
});
export async function loadPullChecks(
  client: Octokit,
  headers: Record<string, string>,
  host: string,
  options: ProviderPullChecksOptions,
) {
  const url =
    host === 'https://github.com' ? 'https://api.github.com/graphql' : `${host}/api/graphql`;
  const { data } = await client.request('POST {url}', {
    url,
    headers,
    query,
    variables: {
      owner: options.repository.owner,
      name: options.repository.name,
      number: options.number,
      after: options.after,
    },
  });
  const parsed = envelope.safeParse(data);
  const invalid = () =>
    new ProviderError(
      'PROVIDER_CHECKS_RESPONSE',
      'Check results could not be read. Check account permissions and provider support, then retry.',
    );
  if (!parsed.success) throw invalid();
  const pull = parsed.data.data.repository.pullRequest;
  const commit = pull.commits.nodes[0]!.commit;
  if (pull.headRefOid !== options.head || commit.oid !== options.head)
    throw new ProviderError(
      'STALE_PROVIDER_PULL',
      'The pull-request head changed. Refresh details to load checks for the new commit.',
    );
  const rollup = commit.statusCheckRollup;
  const contexts = rollup?.contexts;
  if (
    contexts &&
    (contexts.totalCount < contexts.nodes.length ||
      (contexts.pageInfo.hasNextPage &&
        (!contexts.nodes.length ||
          !contexts.pageInfo.endCursor ||
          contexts.pageInfo.endCursor === options.after)))
  )
    throw invalid();
  const result = providerPullChecksPageSchema.safeParse({
    head: commit.oid,
    state: rollup?.state ?? null,
    total: contexts?.totalCount ?? 0,
    nextCursor: contexts?.pageInfo.hasNextPage ? contexts.pageInfo.endCursor : null,
    checks:
      contexts?.nodes.map((item) =>
        item.__typename === 'CheckRun'
          ? {
              id: item.id,
              kind: 'check',
              name: item.name,
              status: item.status,
              conclusion: item.conclusion,
              description: '',
            }
          : {
              id: item.id,
              kind: 'status',
              name: item.context,
              status: item.state,
              conclusion: null,
              description: item.description ?? '',
            },
      ) ?? [],
  });
  if (!result.success) throw invalid();
  return result.data;
}
