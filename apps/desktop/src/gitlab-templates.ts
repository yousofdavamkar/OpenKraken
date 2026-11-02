import { createHash } from 'node:crypto';
import { ProjectTemplates } from '@gitbeaker/rest';
import { z } from 'zod';
import {
  providerPullTemplatesOptionsSchema,
  providerMergeTemplatesSchema,
  providerMergeTemplateOptionsSchema,
  providerPullTemplateSchema,
  type ProviderPullTemplatesOptions,
  type ProviderMergeTemplateOptions,
} from '@openkraken/ipc-contract';
import type { GitLabRead } from './gitlab-merges.js';
import { creationProject } from './gitlab-create.js';
import { ProviderError } from './provider-error.js';
async function listing(read: GitLabRead, origin: string, options: ProviderPullTemplatesOptions) {
  const project = await creationProject(read, options.repository);
  const entries = await read(`projects/${project.id}/templates/merge_requests`, async (client) =>
    z
      .array(providerMergeTemplatesSchema.shape.templates.element.strip())
      .max(100)
      .parse(
        await new ProjectTemplates(client).all(project.id, 'merge_requests', {
          page: 1,
          perPage: 100,
          maxPages: 1,
          pagination: 'offset',
        }),
      ),
  );
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length)
    throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned ambiguous template keys.');
  const templates = entries.slice(0, 50);
  return {
    project,
    value: providerMergeTemplatesSchema.parse({
      defaultBranch: project.defaultBranch,
      templates,
      limited: entries.length > 50,
      revision: createHash('sha256')
        .update(JSON.stringify({ origin, repository: options.repository, project, entries }))
        .digest('hex'),
    }),
  };
}
export async function loadMergeTemplates(
  read: GitLabRead,
  origin: string,
  input: ProviderPullTemplatesOptions,
) {
  return (await listing(read, origin, providerPullTemplatesOptionsSchema.parse(input))).value;
}
export async function loadMergeTemplate(
  read: GitLabRead,
  origin: string,
  input: ProviderMergeTemplateOptions,
) {
  const options = providerMergeTemplateOptionsSchema.parse(input);
  const current = await listing(read, origin, { repository: options.repository });
  const entry = current.value.templates.find((item) => item.key === options.key);
  if (current.value.revision !== options.revision || !entry)
    throw new ProviderError(
      'STALE_PROVIDER_TEMPLATE',
      'The template listing changed. Reload templates and select one again.',
    );
  return read(
    `projects/${current.project.id}/templates/merge_requests/${encodeURIComponent(entry.key)}`,
    async (client) => {
      const data = z
        .object({ name: z.string().min(1).max(1024), content: z.string().max(65536) })
        .parse(
          await new ProjectTemplates(client).show(current.project.id, 'merge_requests', entry.key),
        );
      if (data.name !== entry.name && data.name !== entry.key)
        throw new ProviderError('PROVIDER_RESPONSE', 'GitLab returned another template.');
      return providerPullTemplateSchema.parse({ body: data.content });
    },
  );
}
