import { z } from 'zod';

export const providerOriginSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      value === value.trim() &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    );
  }, 'Use an HTTPS provider origin without credentials, a path or query parameters')
  .transform((value) => new URL(value).origin);
export const providerAccountSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{64}$/),
    provider: z.literal('github'),
    origin: providerOriginSchema,
    providerUserId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    login: z.string().min(1).max(255),
    authentication: z.literal('device').optional(),
    expiresAt: z.number().int().positive().optional(),
  })
  .strict();
export const providerAccountsSchema = z
  .object({
    keychainAvailable: z.boolean(),
    accounts: z.array(providerAccountSchema).max(50),
  })
  .strict();
export const providerConnectSchema = z
  .object({
    provider: z.literal('github'),
    origin: providerOriginSchema,
    token: z
      .string()
      .min(1)
      .max(16384)
      .regex(/^[\x21-\x7e]+$/),
  })
  .strict();
export type ProviderAccount = z.infer<typeof providerAccountSchema>;
export type ProviderAccounts = z.infer<typeof providerAccountsSchema>;
export type ProviderConnect = z.infer<typeof providerConnectSchema>;

export const deviceStartSchema = z
  .object({
    clientId: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9_.-]+$/),
    privateRepositories: z.boolean(),
  })
  .strict();
export const deviceChallengeSchema = z
  .object({
    id: z.string().uuid(),
    userCode: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[A-Z0-9-]+$/),
    verificationUri: z.literal('https://github.com/login/device'),
    expiresAt: z.number().int().nonnegative(),
    nextPollAt: z.number().int().nonnegative(),
  })
  .strict();
export type DeviceStart = z.infer<typeof deviceStartSchema>;
export type DeviceChallenge = z.infer<typeof deviceChallengeSchema>;

// GitHub/GHES repository components are literal path segments, never URLs.
export const providerRepositoryNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/)
  .refine((value) => value !== '.' && value !== '..');
export const providerRepositoryPageNumberSchema = z.number().int().min(1).max(100);
export const providerRepositorySchema = z
  .object({
    id: z.string().regex(/^[1-9][0-9]{0,19}$/),
    owner: providerRepositoryNameSchema,
    name: providerRepositoryNameSchema,
    description: z.string().max(1000),
    private: z.boolean(),
    archived: z.boolean(),
    cloneUrl: z.string().max(4096),
  })
  .strict()
  .refine((repo) => {
    try {
      const url = new URL(repo.cloneUrl);
      return (
        providerOriginSchema.safeParse(url.origin).success &&
        repo.cloneUrl === `${url.origin}/${repo.owner}/${repo.name}.git`
      );
    } catch {
      return false;
    }
  });
export const providerRepositoryPageSchema = z
  .object({
    repositories: z.array(providerRepositorySchema).max(100),
    nextPage: providerRepositoryPageNumberSchema.nullable(),
    limited: z.boolean(),
  })
  .strict();
export type ProviderRepository = z.infer<typeof providerRepositorySchema>;
export type ProviderRepositoryPage = z.infer<typeof providerRepositoryPageSchema>;

export const providerCloneUrlSchema = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      const parts = url.pathname.split('/');
      return (
        providerOriginSchema.safeParse(url.origin).success &&
        value === `${url.origin}${url.pathname}` &&
        parts.length === 3 &&
        providerRepositoryNameSchema.safeParse(parts[1]).success &&
        parts[2]!.endsWith('.git') &&
        providerRepositoryNameSchema.safeParse(parts[2]!.slice(0, -4)).success
      );
    } catch {
      return false;
    }
  });
/** Main-to-utility only. Never accepted in renderer requests or returned in results. */
export const providerGitCredentialSchema = z
  .object({
    url: providerCloneUrlSchema,
    username: providerRepositoryNameSchema,
    password: providerConnectSchema.shape.token,
  })
  .strict();
export type ProviderGitCredential = z.infer<typeof providerGitCredentialSchema>;
export type ProviderGitTarget = Pick<ProviderGitCredential, 'url' | 'username'>;

export const providerRemoteTargetSchema = z
  .object({ url: providerCloneUrlSchema, token: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
export type ProviderRemoteTarget = z.infer<typeof providerRemoteTargetSchema>;
export type ProviderRemoteAuthorization = ProviderRemoteTarget & { username: string };

export const providerRepositoryTargetSchema = z
  .object({ owner: providerRepositoryNameSchema, name: providerRepositoryNameSchema })
  .strict();
export const providerPullNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const providerPullListOptionsSchema = z
  .object({
    repository: providerRepositoryTargetSchema,
    state: z.enum(['open', 'closed', 'all']),
    page: providerRepositoryPageNumberSchema,
  })
  .strict();
export const providerPullOptionsSchema = z
  .object({ repository: providerRepositoryTargetSchema, number: providerPullNumberSchema })
  .strict();
const providerDateSchema = z.string().datetime({ offset: true });
export const providerPullSummarySchema = z
  .object({
    number: providerPullNumberSchema,
    title: z.string().min(1).max(4096),
    author: z.string().min(1).max(255).nullable(),
    state: z.enum(['open', 'closed']),
    draft: z.boolean(),
    createdAt: providerDateSchema,
    updatedAt: providerDateSchema,
    mergedAt: providerDateSchema.nullable(),
    url: z
      .string()
      .url()
      .max(4096)
      .refine((value) => {
        try {
          const url = new URL(value);
          const parts = url.pathname.split('/');
          return (
            value === `${url.origin}${url.pathname}` &&
            providerOriginSchema.safeParse(url.origin).success &&
            parts.length === 5 &&
            providerRepositoryNameSchema.safeParse(parts[1]).success &&
            providerRepositoryNameSchema.safeParse(parts[2]).success &&
            parts[3] === 'pull' &&
            /^[1-9][0-9]*$/.test(parts[4]!)
          );
        } catch {
          return false;
        }
      }),
  })
  .strict();
export const providerPullPageSchema = z
  .object({
    pullRequests: z.array(providerPullSummarySchema).max(100),
    nextPage: providerRepositoryPageNumberSchema.nullable(),
    limited: z.boolean(),
  })
  .strict();
const providerPullBranchSchema = z
  .object({
    label: z.string().min(1).max(2048),
    ref: z.string().min(1).max(1024),
    sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  })
  .strict();
const providerCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const providerPullDetailsSchema = providerPullSummarySchema
  .extend({
    body: z.string().max(262144),
    head: providerPullBranchSchema,
    base: providerPullBranchSchema,
    merged: z.boolean(),
    mergeable: z.boolean().nullable(),
    mergeableState: z.string().max(64),
    comments: providerCountSchema,
    reviewComments: providerCountSchema,
    commits: providerCountSchema,
    changedFiles: providerCountSchema,
    additions: providerCountSchema,
    deletions: providerCountSchema,
  })
  .strict();
export type ProviderPullListOptions = z.infer<typeof providerPullListOptionsSchema>;
export type ProviderPullOptions = z.infer<typeof providerPullOptionsSchema>;
export type ProviderPullSummary = z.infer<typeof providerPullSummarySchema>;
export type ProviderPullPage = z.infer<typeof providerPullPageSchema>;
export type ProviderPullDetails = z.infer<typeof providerPullDetailsSchema>;

const providerCommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const providerPullRevisionSchema = z
  .object({ head: providerCommitSchema, base: providerCommitSchema })
  .strict();
export const providerPullFilesOptionsSchema = providerPullOptionsSchema
  .extend({ revision: providerPullRevisionSchema, page: z.number().int().min(1).max(30) })
  .strict();
export const providerPullFileSchema = z
  .object({
    path: z.string().min(1).max(4096),
    previousPath: z.string().min(1).max(4096).nullable(),
    status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
    additions: providerCountSchema,
    deletions: providerCountSchema,
    changes: providerCountSchema,
    sha: providerCommitSchema,
    patch: z.string().max(262144).nullable(),
    patchTruncated: z.boolean(),
  })
  .strict();
export const providerPullFilesPageSchema = z
  .object({
    files: z.array(providerPullFileSchema).max(100),
    nextPage: z.number().int().min(1).max(30).nullable(),
    limited: z.boolean(),
  })
  .strict();
export const providerPullReviewsOptionsSchema = providerPullOptionsSchema
  .extend({ page: providerRepositoryPageNumberSchema })
  .strict();
export const providerPullReviewSchema = z
  .object({
    id: z.string().regex(/^[1-9][0-9]{0,19}$/),
    author: z.string().min(1).max(255).nullable(),
    state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']),
    body: z.string().max(262144),
    submittedAt: providerDateSchema.nullable(),
    commitId: providerCommitSchema.nullable(),
  })
  .strict();
export const providerPullReviewsPageSchema = z
  .object({
    reviews: z.array(providerPullReviewSchema).max(100),
    nextPage: providerRepositoryPageNumberSchema.nullable(),
    limited: z.boolean(),
  })
  .strict();
export const providerSubmitReviewSchema = providerPullOptionsSchema
  .extend({
    revision: providerPullRevisionSchema,
    event: z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']),
    body: z.string().max(65536),
  })
  .strict()
  .refine((value) => value.event === 'APPROVE' || !!value.body.trim(), 'Enter review text');
export type ProviderPullFilesOptions = z.infer<typeof providerPullFilesOptionsSchema>;
export type ProviderPullFilesPage = z.infer<typeof providerPullFilesPageSchema>;
export type ProviderPullFile = z.infer<typeof providerPullFileSchema>;
export type ProviderPullReviewsOptions = z.infer<typeof providerPullReviewsOptionsSchema>;
export type ProviderPullReviewsPage = z.infer<typeof providerPullReviewsPageSchema>;
export type ProviderPullReview = z.infer<typeof providerPullReviewSchema>;
export type ProviderSubmitReview = z.infer<typeof providerSubmitReviewSchema>;
