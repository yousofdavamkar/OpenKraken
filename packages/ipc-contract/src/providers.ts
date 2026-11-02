import { z } from 'zod';

export const providerOriginSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const url = new URL(value);
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
