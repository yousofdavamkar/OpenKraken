import { z } from 'zod';
import {
  providerBitbucketStatusSchema,
  providerBitbucketStatusesOptionsSchema,
  providerBitbucketStatusesPageSchema,
  type ProviderBitbucketStatusesOptions,
} from '@openkraken/ipc-contract';
import { checkBitbucketPullRevision, type BitbucketRead } from './bitbucket-pulls.js';
import { bitbucketPageSchema, bitbucketPagination } from './bitbucket-response.js';

const fields = providerBitbucketStatusSchema.shape;
const status = z.object({
  key: fields.key,
  state: fields.state,
  name: fields.name.nullish(),
  description: fields.description.nullish(),
  refname: fields.refname.nullish(),
  updated_on: fields.updatedAt.nullish(),
});

export async function loadBitbucketStatuses(
  read: BitbucketRead,
  input: ProviderBitbucketStatusesOptions,
) {
  const options = providerBitbucketStatusesOptionsSchema.parse(input);
  const { repository, number, page } = options;
  await checkBitbucketPullRevision(read, options);
  const endpoint = `repositories/${repository.owner}/${repository.name}/pullrequests/${number}/statuses`;
  const result = await read(`${endpoint}?page=${page}&pagelen=100&sort=key`, (value) => {
    const data = bitbucketPageSchema(status).parse(value);
    const statuses = data.values.map((item) => ({
      key: item.key,
      state: item.state,
      name: item.name ?? '',
      description: item.description ?? '',
      refname: item.refname ?? null,
      updatedAt: item.updated_on ?? null,
    }));
    return providerBitbucketStatusesPageSchema.parse({
      statuses,
      ...bitbucketPagination(data, page, endpoint),
    });
  });
  await checkBitbucketPullRevision(read, options);
  return result;
}
