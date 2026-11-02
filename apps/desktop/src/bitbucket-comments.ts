import { z } from 'zod';
import {
  providerBitbucketCommentsOptionsSchema,
  providerBitbucketCommentsPageSchema,
  providerBitbucketIdSchema,
  providerPullNumberSchema,
  type ProviderBitbucketCommentsOptions,
} from '@openkraken/ipc-contract';
import { loadBitbucketPull, type BitbucketRead } from './bitbucket-pulls.js';
import { bitbucketPageSchema, bitbucketPagination, bitbucketUnique } from './bitbucket-response.js';
import { ProviderError } from './provider-error.js';
const person = z.object({
  uuid: providerBitbucketIdSchema,
  display_name: z.string().min(1).max(255),
});
const date = z.string().datetime({ offset: true }).nullish();
const line = providerPullNumberSchema.nullish();
const rawComment = z.object({
  id: providerPullNumberSchema,
  type: z.literal('pullrequest_comment').optional(),
  user: person.nullish(),
  content: z.object({ raw: z.string().max(262144).optional() }).nullish(),
  deleted: z.boolean(),
  pending: z.boolean().nullish(),
  created_on: date,
  updated_on: date,
  parent: z.object({ id: providerPullNumberSchema }).nullish(),
  inline: z
    .object({
      path: z.string().min(1).max(4096),
      from: line,
      to: line,
      start_from: line,
      start_to: line,
      outdated: z.boolean().nullish(),
    })
    .nullish(),
  resolution: z
    .object({
      type: z.literal('comment_resolution').optional(),
      user: person.nullish(),
      created_on: date,
    })
    .nullish(),
  pullrequest: z.object({
    id: providerPullNumberSchema,
    destination: z
      .object({
        repository: z.object({
          uuid: providerBitbucketIdSchema,
          full_name: z.string().min(3).max(511),
        }),
      })
      .optional(),
  }),
});
const author = (user: z.infer<typeof person> | null | undefined) =>
  user ? { id: user.uuid, name: user.display_name } : null;
export async function loadBitbucketComments(
  read: BitbucketRead,
  input: ProviderBitbucketCommentsOptions,
) {
  const options = providerBitbucketCommentsOptionsSchema.parse(input);
  const check = async () => {
    const current = await loadBitbucketPull(read, {
      repository: options.repository,
      number: options.number,
    });
    if (current.repositoryId !== options.repositoryId)
      throw new ProviderError(
        'STALE_PROVIDER_MERGE',
        'The pull-request repository changed. Choose the repository again.',
      );
  };
  await check();
  const path = `${options.repository.owner}/${options.repository.name}`;
  const endpoint = `repositories/${path}/pullrequests/${options.number}/comments`;
  const result = await read(
    `${endpoint}?page=${options.page}&pagelen=100&sort=created_on`,
    (value) => {
      const data = bitbucketPageSchema(rawComment).parse(value);
      bitbucketUnique(data.values.map((comment) => String(comment.id)));
      const parents = new Map(data.values.map((comment) => [comment.id, comment.parent?.id]));
      for (const comment of data.values) {
        const seen = new Set<number>();
        let id: number | undefined = comment.id;
        while (id !== undefined && parents.has(id)) {
          if (seen.has(id))
            throw new ProviderError(
              'PROVIDER_RESPONSE',
              'Bitbucket returned a cyclic comment relationship.',
            );
          seen.add(id);
          id = parents.get(id);
        }
      }
      return providerBitbucketCommentsPageSchema.parse({
        comments: data.values.map((comment) => {
          const repository = comment.pullrequest.destination?.repository;
          if (
            comment.pullrequest.id !== options.number ||
            (repository &&
              (repository.uuid !== options.repositoryId || repository.full_name !== path))
          )
            throw new ProviderError(
              'PROVIDER_RESPONSE',
              'Bitbucket returned a comment from another pull request.',
            );
          if (!comment.deleted && comment.content?.raw === undefined)
            throw new ProviderError('PROVIDER_RESPONSE', 'Bitbucket omitted comment text.');
          return {
            id: comment.id,
            author: author(comment.user),
            body: comment.deleted ? null : comment.content!.raw,
            deleted: comment.deleted,
            pending: comment.pending ?? null,
            parentId: comment.parent?.id ?? null,
            createdAt: comment.created_on ?? null,
            updatedAt: comment.updated_on ?? null,
            inline: comment.inline
              ? {
                  path: comment.inline.path,
                  oldLine: comment.inline.from ?? null,
                  newLine: comment.inline.to ?? null,
                  oldStart: comment.inline.start_from ?? null,
                  newStart: comment.inline.start_to ?? null,
                  outdated: comment.inline.outdated ?? null,
                }
              : null,
            resolution:
              comment.resolution === undefined
                ? { status: 'unknown' }
                : comment.resolution === null
                  ? { status: 'unresolved' }
                  : {
                      status: 'resolved',
                      author: author(comment.resolution.user),
                      createdAt: comment.resolution.created_on ?? null,
                    },
          };
        }),
        ...bitbucketPagination(data, options.page, endpoint),
      });
    },
  );
  await check();
  return result;
}
