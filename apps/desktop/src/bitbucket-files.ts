import {
  providerBitbucketDiffOptionsSchema,
  providerBitbucketDiffSchema,
  type ProviderBitbucketDiffOptions,
} from '@openkraken/ipc-contract';
import { z } from 'zod';
import {
  providerBitbucketFilesOptionsSchema,
  providerBitbucketFilesPageSchema,
  providerBitbucketFileSchema,
  type ProviderBitbucketFilesOptions,
  type ProviderBitbucketPullDetails,
} from '@openkraken/ipc-contract';
import { loadBitbucketPull, type BitbucketRead } from './bitbucket-pulls.js';
import { bitbucketPageSchema, bitbucketPagination, bitbucketUnique } from './bitbucket-response.js';
import { ProviderError } from './provider-error.js';

type Redirect = (endpoint: string) => Promise<string>;
const side = z.object({ path: z.string().min(1).max(4096) }).nullish();
const rawFile = z.object({
  status: providerBitbucketFileSchema.shape.status,
  old: side,
  new: side,
  lines_added: providerBitbucketFileSchema.shape.additions,
  lines_removed: providerBitbucketFileSchema.shape.deletions,
});
function stale(): never {
  throw new ProviderError(
    'STALE_PROVIDER_MERGE',
    'The pull-request comparison changed or is unavailable. Refresh details before loading files.',
  );
}
async function check(read: BitbucketRead, options: ProviderBitbucketFilesOptions) {
  const current = await loadBitbucketPull(read, {
    repository: options.repository,
    number: options.number,
  });
  const revision = options.revision;
  if (
    current.repositoryId !== revision.repositoryId ||
    current.source.repository?.id !== revision.sourceRepositoryId ||
    current.source.commit !== revision.sourceCommit ||
    current.destination.commit !== revision.destinationCommit
  )
    stale();
  return current;
}
function comparison(
  location: string,
  current: ProviderBitbucketPullDetails,
  kind: 'diffstat' | 'diff',
) {
  const url = new URL(location, 'https://api.bitbucket.org');
  const destination = current.destination.repository!;
  const source = current.source.repository!;
  const root = `repositories/${destination.owner}/${destination.name}/${kind}/`;
  const prefix = `/2.0/${root}`;
  const sourceRefs = [
    current.source.commit,
    `${source.owner}/${source.name}:${current.source.commit}`,
  ];
  const destinationRefs = [
    current.destination.commit,
    `${destination.owner}/${destination.name}:${current.destination.commit}`,
  ];
  const validSpecs = sourceRefs.flatMap((a) => destinationRefs.map((b) => `${a}..${b}`));
  const params = url.searchParams;
  if (
    url.origin !== 'https://api.bitbucket.org' ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith(prefix) ||
    !validSpecs.includes(decodeURIComponent(url.pathname.slice(prefix.length))) ||
    [...params.keys()].some(
      (key) => !['topic', 'from_pullrequest_id'].includes(key) || params.getAll(key).length !== 1,
    ) ||
    params.get('topic') !== 'true' ||
    (params.has('from_pullrequest_id') &&
      params.get('from_pullrequest_id') !== String(current.number))
  )
    throw new ProviderError(
      'PROVIDER_RESPONSE',
      'Bitbucket returned an unexpected comparison redirect.',
    );
  // Only this validated, fixed-origin endpoint is reconstructed for an authenticated read.
  return { endpoint: url.pathname.slice('/2.0/'.length), params };
}
export async function loadBitbucketFiles(
  read: BitbucketRead,
  redirect: Redirect,
  input: ProviderBitbucketFilesOptions,
) {
  const options = providerBitbucketFilesOptionsSchema.parse(input);
  const current = await check(read, options);
  const location = await redirect(
    `repositories/${options.repository.owner}/${options.repository.name}/pullrequests/${options.number}/diffstat`,
  );
  const { endpoint, params } = comparison(location, current, 'diffstat');
  params.set('page', String(options.page));
  params.set('pagelen', '100');
  const result = await read(`${endpoint}?${params}`, (value) => {
    const data = bitbucketPageSchema(rawFile).parse(value);
    const files = data.values.map((file) => {
      if (
        (!file.old && !file.new) ||
        (file.status === 'added' && !file.new) ||
        (file.status === 'removed' && !file.old) ||
        (!['added', 'removed', 'merge conflict'].includes(file.status) && (!file.old || !file.new))
      )
        throw new ProviderError('PROVIDER_RESPONSE', 'Bitbucket returned an invalid changed file.');
      return {
        path: (file.new ?? file.old)!.path,
        previousPath:
          file.old && file.new && file.old.path !== file.new.path ? file.old.path : null,
        status: file.status,
        additions: file.lines_added,
        deletions: file.lines_removed,
      };
    });
    bitbucketUnique(files.map((file) => file.path));
    return providerBitbucketFilesPageSchema.parse({
      files,
      ...bitbucketPagination(data, options.page, endpoint),
    });
  });
  const after = await check(read, options);
  if (
    JSON.stringify(after.source) !== JSON.stringify(current.source) ||
    JSON.stringify(after.destination) !== JSON.stringify(current.destination)
  )
    stale();
  return result;
}

export async function loadBitbucketDiff(
  read: BitbucketRead,
  redirect: Redirect,
  text: (endpoint: string) => Promise<string>,
  input: ProviderBitbucketDiffOptions,
) {
  const options = providerBitbucketDiffOptionsSchema.parse(input);
  const { path, ...filesOptions } = options;
  const current = await check(read, filesOptions);
  const files = await loadBitbucketFiles(read, redirect, filesOptions);
  if (!files.files.some((file) => file.path === path))
    throw new ProviderError(
      'PROVIDER_RESPONSE',
      'The selected file is no longer on this comparison page. Refresh files.',
    );
  const location = await redirect(
    `repositories/${options.repository.owner}/${options.repository.name}/pullrequests/${options.number}/diff`,
  );
  const { endpoint, params } = comparison(location, current, 'diff');
  params.set('path', path);
  const patch = await text(`${endpoint}?${params}`);
  const after = await check(read, filesOptions);
  if (
    JSON.stringify(after.source) !== JSON.stringify(current.source) ||
    JSON.stringify(after.destination) !== JSON.stringify(current.destination)
  )
    stale();
  return providerBitbucketDiffSchema.parse({
    text: patch.slice(0, 262144),
    truncated: patch.length > 262144,
  });
}
