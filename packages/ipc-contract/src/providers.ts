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
