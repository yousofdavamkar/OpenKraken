import { z } from 'zod';
import { ProviderError } from './provider-error.js';

export function bitbucketPagination(
  data: { page?: number; next?: string | null },
  page: number,
  endpoint: string,
) {
  if (data.page !== undefined && data.page !== page)
    throw new ProviderError('PROVIDER_RESPONSE', 'Bitbucket returned a different page.');
  if (data.next) {
    const next = new URL(data.next);
    if (
      next.origin !== 'https://api.bitbucket.org' ||
      next.username ||
      next.password ||
      next.hash ||
      next.pathname !== `/2.0/${endpoint}` ||
      next.searchParams.getAll('page').length !== 1 ||
      next.searchParams.get('page') !== String(page + 1)
    )
      throw new ProviderError('PROVIDER_RESPONSE', 'Bitbucket returned invalid pagination.');
  }
  // Reconstruct subsequent requests locally, never follow provider links.
  return {
    nextPage: data.next && page < 100 ? page + 1 : null,
    limited: !!data.next && page === 100,
  };
}
export function bitbucketPageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    page: z.number().int().positive().optional(),
    next: z.string().url().max(4096).nullish(),
    values: z.array(item).max(100),
  });
}
export function bitbucketUnique(ids: string[]) {
  if (new Set(ids).size !== ids.length)
    throw new ProviderError('PROVIDER_RESPONSE', 'Bitbucket returned duplicate entries.');
}
