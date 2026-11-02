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

const providerPositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const providerCommentSideSchema = z.enum(['LEFT', 'RIGHT']);
export const providerPullCommentSchema = z
  .object({
    id: providerPositiveIntegerSchema,
    replyTo: providerPositiveIntegerSchema.nullable(),
    author: z.string().min(1).max(255).nullable(),
    body: z.string().max(262144),
    path: z.string().min(1).max(4096),
    hunk: z.string().max(262144),
    hunkTruncated: z.boolean(),
    commitId: providerCommitSchema,
    originalCommitId: providerCommitSchema,
    line: providerPositiveIntegerSchema.nullable(),
    originalLine: providerPositiveIntegerSchema.nullable(),
    startLine: providerPositiveIntegerSchema.nullable(),
    originalStartLine: providerPositiveIntegerSchema.nullable(),
    side: providerCommentSideSchema.nullable(),
    startSide: providerCommentSideSchema.nullable(),
    createdAt: providerDateSchema,
    updatedAt: providerDateSchema,
  })
  .strict();
export const providerPullCommentsPageSchema = z
  .object({
    comments: z.array(providerPullCommentSchema).max(100),
    nextPage: providerRepositoryPageNumberSchema.nullable(),
    limited: z.boolean(),
  })
  .strict();
export type ProviderPullComment = z.infer<typeof providerPullCommentSchema>;
export type ProviderPullCommentsPage = z.infer<typeof providerPullCommentsPageSchema>;
export const providerCommentTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('line'),
      path: z.string().min(1).max(4096),
      line: providerPositiveIntegerSchema,
      side: providerCommentSideSchema,
    })
    .strict(),
  z.object({ kind: z.literal('reply'), commentId: providerPositiveIntegerSchema }).strict(),
]);
export const providerCreateCommentSchema = providerPullOptionsSchema
  .extend({
    revision: providerPullRevisionSchema,
    body: z
      .string()
      .max(65536)
      .refine((body) => !!body.trim(), 'Enter comment text'),
    target: providerCommentTargetSchema,
  })
  .strict();
export type ProviderCommentTarget = z.infer<typeof providerCommentTargetSchema>;
export type ProviderCreateComment = z.infer<typeof providerCreateCommentSchema>;

export const providerBranchNameSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (name) =>
      name !== '@' &&
      name !== 'HEAD' &&
      !name.startsWith('-') &&
      !name.endsWith('.') &&
      ![...name].some(
        (char) =>
          char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || '~^:?*[\\'.includes(char),
      ) &&
      !name.includes('..') &&
      !name.includes('@{') &&
      name.split('/').every((part) => !!part && !part.startsWith('.') && !part.endsWith('.lock')),
    'Enter a branch name',
  );
export const providerPullSourceSchema = z
  .object({
    repository: providerRepositoryTargetSchema,
    source: providerRepositoryTargetSchema,
    head: providerBranchNameSchema,
    base: providerBranchNameSchema,
  })
  .strict();
export const providerCreatePullSchema = providerPullSourceSchema
  .extend({
    revision: providerPullRevisionSchema,
    title: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !!value.trim() && !/[\r\n]/.test(value), 'Enter a single-line title'),
    body: z.string().max(65536),
    draft: z.boolean(),
    maintainerCanModify: z.boolean(),
  })
  .strict();
export type ProviderPullSource = z.infer<typeof providerPullSourceSchema>;
export type ProviderCreatePull = z.infer<typeof providerCreatePullSchema>;
export type ProviderPullRevision = z.infer<typeof providerPullRevisionSchema>;
export const providerPullTemplatesOptionsSchema = z
  .object({ repository: providerRepositoryTargetSchema })
  .strict();
const providerTemplatePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(
    /^(?:(?:\.github|docs)\/)?(?:pull_request_template(?:\.(?:md|txt))?|pull_request_template\/[^/\\]+)$/i,
  )
  .refine(
    (path) =>
      ![...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
      path.split('/').every((part) => part !== '.' && part !== '..'),
  );
export const providerPullTemplatesSchema = z
  .object({
    defaultBranch: providerBranchNameSchema,
    revision: providerCommitSchema,
    templates: z
      .array(
        z
          .object({
            path: providerTemplatePathSchema,
            sha: providerCommitSchema,
            size: providerCountSchema,
          })
          .strict(),
      )
      .max(50),
    limited: z.boolean(),
  })
  .strict();
export const providerPullTemplateOptionsSchema = providerPullTemplatesOptionsSchema
  .extend({ revision: providerCommitSchema, path: providerTemplatePathSchema })
  .strict();
export const providerPullTemplateSchema = z.object({ body: z.string().max(65536) }).strict();
export type ProviderPullTemplatesOptions = z.infer<typeof providerPullTemplatesOptionsSchema>;
export type ProviderPullTemplateOptions = z.infer<typeof providerPullTemplateOptionsSchema>;
export type ProviderPullTemplates = z.infer<typeof providerPullTemplatesSchema>;
export type ProviderPullTemplate = z.infer<typeof providerPullTemplateSchema>;
