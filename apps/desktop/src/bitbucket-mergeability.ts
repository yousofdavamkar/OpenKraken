import { z } from 'zod';
import {
  providerBitbucketMergeabilityOptionsSchema,
  providerBitbucketMergeCheckSchema,
  providerBitbucketMergeChecksSchema,
  type ProviderBitbucketMergeabilityOptions,
} from '@openkraken/ipc-contract';
import { checkBitbucketPullRevision, type BitbucketRead } from './bitbucket-pulls.js';
import { ProviderError } from './provider-error.js';

const fields = providerBitbucketMergeCheckSchema.shape;
const rawCheck = z.object({
  type: fields.type,
  status: fields.status,
  required: fields.required,
  blocking: fields.blocking,
  check: z.object({ name: fields.name.optional(), kind: fields.name.optional() }).optional(),
  state: fields.detail.optional(),
  reason: fields.detail.optional(),
  message: fields.detail.optional(),
  merge_queue: z.object({ name: fields.name.optional() }).nullish(),
  queued: z.boolean().optional(),
});
const collection = z.object({
  size: z.number().int().nonnegative().max(1000).optional(),
  values: z.array(rawCheck).max(1000),
});
export async function loadBitbucketMergeability(
  read: BitbucketRead,
  input: ProviderBitbucketMergeabilityOptions,
) {
  const options = providerBitbucketMergeabilityOptionsSchema.parse(input);
  await checkBitbucketPullRevision(read, options);
  const { repository, number } = options;
  const checks = await read(
    `repositories/${repository.owner}/${repository.name}/pullrequests/${number}/mergeability/checks`,
    (value) => {
      const data = collection.parse(value);
      if (data.size !== undefined && data.size !== data.values.length)
        throw new ProviderError(
          'PROVIDER_RESPONSE',
          'Bitbucket returned an incomplete merge check collection.',
        );
      return providerBitbucketMergeChecksSchema.parse(
        data.values.map((check) => ({
          type: check.type,
          status: check.status,
          required: check.required,
          blocking: check.blocking,
          name: check.check?.name ?? check.check?.kind ?? check.merge_queue?.name ?? null,
          detail:
            check.message ??
            check.reason ??
            check.state ??
            (check.queued === undefined ? null : check.queued ? 'Queued' : 'Outside queue'),
        })),
      );
    },
  );
  await checkBitbucketPullRevision(read, options);
  return checks;
}
