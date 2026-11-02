import { MergeRequests } from '@gitbeaker/rest';
import { z } from 'zod';
import {
  providerMergeRequestFilesOptionsSchema,
  providerMergeRequestFilesPageSchema,
  type ProviderMergeRequestFilesOptions,
} from '@openkraken/ipc-contract';
import { loadMergeRequest, type GitLabRead } from './gitlab-merges.js';
import { ProviderError } from './provider-error.js';

const fileSchema = z
  .object({
    old_path: z.string().min(1).max(4096),
    new_path: z.string().min(1).max(4096),
    a_mode: z.string().regex(/^(?:0|[0-7]{6})$/),
    b_mode: z.string().regex(/^(?:0|[0-7]{6})$/),
    new_file: z.boolean(),
    renamed_file: z.boolean(),
    deleted_file: z.boolean(),
    generated_file: z.boolean().optional(),
    collapsed: z.boolean().optional(),
    too_large: z.boolean().optional(),
    diff: z.string().nullish(),
  })
  .refine(
    (file) => Number(file.new_file) + Number(file.renamed_file) + Number(file.deleted_file) <= 1,
  );

export async function loadMergeRequestFiles(
  read: GitLabRead,
  origin: string,
  input: ProviderMergeRequestFilesOptions,
) {
  const options = providerMergeRequestFilesOptionsSchema.parse(input);
  const check = async () => {
    const current = await loadMergeRequest(read, origin, {
      repository: options.repository,
      number: options.number,
    });
    const revision = current.diffRefs;
    if (
      !revision ||
      revision.base !== options.revision.base ||
      revision.head !== options.revision.head ||
      revision.start !== options.revision.start ||
      (current.source.sha !== null && current.source.sha !== revision.head)
    )
      throw new ProviderError(
        'STALE_PROVIDER_MERGE',
        'The merge-request diff changed or is still being prepared. Refresh details before loading files.',
      );
    return current.target.projectId;
  };
  const project = await check();
  const result = await read(
    `projects/${project}/merge_requests/${options.number}/diffs`,
    async (client) => {
      const data = z
        .array(fileSchema)
        .max(100)
        .parse(
          await new MergeRequests(client).allDiffs(Number(project), options.number, {
            page: options.page,
            perPage: 100,
            maxPages: 1,
            pagination: 'offset',
          }),
        );
      return providerMergeRequestFilesPageSchema.parse({
        files: data.map((file) => ({
          path: file.new_path,
          previousPath: file.old_path === file.new_path ? null : file.old_path,
          status: file.new_file
            ? 'added'
            : file.deleted_file
              ? 'removed'
              : file.renamed_file
                ? 'renamed'
                : 'modified',
          oldMode: file.a_mode,
          newMode: file.b_mode,
          generated: file.generated_file ?? null,
          collapsed: file.collapsed ?? null,
          tooLarge: file.too_large ?? null,
          patch: file.diff ? file.diff.slice(0, 262144) : null,
          patchTruncated: (file.diff?.length ?? 0) > 262144,
        })),
        nextPage: data.length === 100 && options.page < 30 ? options.page + 1 : null,
        limited: data.length === 100 && options.page === 30,
      });
    },
  );
  if ((await check()) !== project)
    throw new ProviderError(
      'STALE_PROVIDER_MERGE',
      'The merge-request project changed. Choose the repository again.',
    );
  return result;
}
