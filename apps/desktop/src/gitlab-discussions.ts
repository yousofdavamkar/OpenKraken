import { MergeRequestDiscussions } from '@gitbeaker/rest';
import { z } from 'zod';
import {
  providerMergeRequestDiscussionsOptionsSchema,
  providerMergeRequestDiscussionsPageSchema,
  providerMergeRequestPositionSchema,
  type ProviderMergeRequestDiscussionsOptions,
} from '@openkraken/ipc-contract';
import { loadMergeRequest, type GitLabRead } from './gitlab-merges.js';
import { ProviderError } from './provider-error.js';

const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const date = z.string().datetime({ offset: true });
const author = z.object({ username: z.string().min(1).max(255) }).nullable();
const line = integer.nullish();
const rangeEnd = z.object({
  type: z.enum(['old', 'new']),
  old_line: line,
  new_line: line,
  line_code: z.string().min(1).max(256).nullish(),
});
const positionSchema = z.object({
  position_type: z.enum(['text', 'image', 'file']),
  base_sha: z.string(),
  head_sha: z.string(),
  start_sha: z.string(),
  old_path: z.string(),
  new_path: z.string(),
  old_line: line,
  new_line: line,
  line_range: z.object({ start: rangeEnd, end: rangeEnd }).nullish(),
  width: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
  height: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
  x: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
  y: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).nullish(),
});
const noteSchema = z.object({
  id: integer,
  type: z.enum(['DiffNote', 'DiscussionNote']).nullable(),
  body: z.string().max(262144),
  author,
  created_at: date,
  updated_at: date,
  system: z.boolean(),
  noteable_id: integer,
  noteable_type: z.literal('MergeRequest'),
  noteable_iid: integer.nullish(),
  project_id: integer,
  resolvable: z.boolean(),
  resolved: z.boolean().nullish(),
  resolved_by: author.optional(),
  resolved_at: date.nullish(),
  position: positionSchema.nullish(),
});
const discussionSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{40}$/),
  individual_note: z.boolean(),
  notes: z.array(noteSchema).min(1).max(1000),
});
function position(value: z.infer<typeof positionSchema> | null | undefined) {
  if (!value) return null;
  const base = {
    kind: value.position_type,
    revision: { base: value.base_sha, head: value.head_sha, start: value.start_sha },
    oldPath: value.old_path,
    newPath: value.new_path,
  };
  const endpoint = (end: z.infer<typeof rangeEnd>) => ({
    side: end.type,
    oldLine: end.old_line ?? null,
    newLine: end.new_line ?? null,
    lineCode: end.line_code ?? null,
  });
  return providerMergeRequestPositionSchema.parse({
    ...base,
    ...(value.position_type === 'text'
      ? {
          oldLine: value.old_line ?? null,
          newLine: value.new_line ?? null,
          range: value.line_range
            ? { start: endpoint(value.line_range.start), end: endpoint(value.line_range.end) }
            : null,
        }
      : value.position_type === 'image'
        ? {
            width: value.width ?? null,
            height: value.height ?? null,
            x: value.x ?? null,
            y: value.y ?? null,
          }
        : {}),
  });
}
export async function loadMergeRequestDiscussions(
  read: GitLabRead,
  origin: string,
  input: ProviderMergeRequestDiscussionsOptions,
) {
  const options = providerMergeRequestDiscussionsOptionsSchema.parse(input);
  const merge = await loadMergeRequest(read, origin, {
    repository: options.repository,
    number: options.number,
  });
  return read(
    `projects/${merge.target.projectId}/merge_requests/${options.number}/discussions`,
    async (client) => {
      const data = z
        .array(discussionSchema)
        .max(100)
        .parse(
          await new MergeRequestDiscussions(client).all(
            Number(merge.target.projectId),
            options.number,
            { page: options.page, perPage: 100, maxPages: 1, pagination: 'offset' },
          ),
        );
      return providerMergeRequestDiscussionsPageSchema.parse({
        discussions: data.map((discussion) => ({
          id: discussion.id,
          individual: discussion.individual_note,
          notes: discussion.notes.map((note) => {
            if (
              String(note.project_id) !== merge.target.projectId ||
              String(note.noteable_id) !== merge.id ||
              (note.noteable_iid != null && note.noteable_iid !== merge.number)
            )
              throw new ProviderError(
                'PROVIDER_RESPONSE',
                'GitLab returned a note from another merge request.',
              );
            return {
              id: note.id,
              type: note.type,
              body: note.body,
              author: note.author?.username ?? null,
              createdAt: note.created_at,
              updatedAt: note.updated_at,
              system: note.system,
              resolvable: note.resolvable,
              resolved: note.resolved ?? null,
              resolvedBy: note.resolved_by?.username ?? null,
              resolvedAt: note.resolved_at ?? null,
              position: position(note.position),
            };
          }),
        })),
        nextPage: data.length === 100 && options.page < 10 ? options.page + 1 : null,
        limited: data.length === 100 && options.page === 10,
      });
    },
  );
}
