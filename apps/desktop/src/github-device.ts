import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  deviceStartSchema,
  deviceChallengeSchema,
  type DeviceStart,
  type DeviceChallenge,
  type ProviderAccounts,
} from '@openkraken/ipc-contract';
import { ProviderError } from './github-provider.js';

const secret = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);
const seconds = z
  .number()
  .int()
  .positive()
  .max(366 * 86400);
export const githubCredentialSchema = z
  .object({
    accessToken: secret,
    clientId: deviceStartSchema.shape.clientId,
    scope: z
      .string()
      .max(2048)
      .regex(/^[\x20-\x7e]*$/),
    expiresAt: z.number().int().positive().optional(),
    refreshToken: secret.optional(),
    refreshExpiresAt: z.number().int().positive().optional(),
  })
  .strict();
export type GitHubCredential = z.infer<typeof githubCredentialSchema>;
const tokenResponseSchema = z.object({
  access_token: secret,
  token_type: z.literal('bearer'),
  scope: z
    .string()
    .max(2048)
    .regex(/^[\x20-\x7e]*$/)
    .default(''),
  expires_in: seconds.optional(),
  refresh_token: secret.optional(),
  refresh_token_expires_in: seconds.optional(),
});
const startResponseSchema = z.object({
  device_code: secret,
  user_code: deviceChallengeSchema.shape.userCode,
  verification_uri: deviceChallengeSchema.shape.verificationUri,
  expires_in: seconds.max(3600),
  interval: z.number().int().min(1).max(3600).default(5),
});
const errorSchema = z.object({
  error: z.string(),
  interval: z.number().int().min(1).max(3600).optional(),
});
function oauthError(code: string) {
  return new ProviderError(
    code === 'access_denied'
      ? 'DEVICE_DENIED'
      : ['expired_token', 'token_expired'].includes(code)
        ? 'DEVICE_EXPIRED'
        : 'DEVICE_AUTH',
    code === 'access_denied'
      ? 'GitHub authorization was declined. Start again to sign in.'
      : ['expired_token', 'token_expired'].includes(code)
        ? 'The GitHub authorization code expired. Start again to sign in.'
        : code === 'device_flow_disabled'
          ? 'Enable device flow in this GitHub application before signing in.'
          : code === 'incorrect_client_credentials'
            ? 'GitHub did not recognize this application client ID.'
            : code === 'bad_refresh_token'
              ? 'The saved GitHub authorization expired. Sign in again.'
              : 'GitHub authorization failed. Start again to sign in.',
  );
}
/** Fixed GitHub OAuth endpoints; no secrets or provider error bodies enter public errors. */
export class GitHubOAuth {
  constructor(
    private fetcher: typeof fetch = (...args) => fetch(...args),
    private now = Date.now,
  ) {}
  async post(
    endpoint: 'device/code' | 'oauth/access_token',
    parameters: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 20000);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const response = await this.fetcher(`https://github.com/login/${endpoint}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'OpenKraken/0.1.0',
        },
        body: new URLSearchParams(parameters).toString(),
        redirect: 'error',
        credentials: 'omit',
        signal: combined,
      });
      if (response.status >= 300 && response.status < 400) throw new Error('redirect');
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        if (reader)
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.length;
            if (length > 32768) throw new Error('size');
            chunks.push(chunk.value);
          }
      } finally {
        await reader?.cancel().catch(() => {});
      }
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok && !errorSchema.safeParse(result).success) throw new Error('status');
      return result;
    } catch {
      if (signal?.aborted) throw new ProviderError('CANCELLED', 'GitHub authorization cancelled.');
      throw new ProviderError(
        'DEVICE_REQUEST',
        'GitHub authorization could not be reached. Check the connection and try again.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
  credential(value: unknown, clientId: string): GitHubCredential {
    const parsed = tokenResponseSchema.safeParse(value);
    if (!parsed.success)
      throw new ProviderError(
        'DEVICE_RESPONSE',
        'GitHub returned an invalid authorization response.',
      );
    const token = parsed.data;
    return githubCredentialSchema.parse({
      accessToken: token.access_token,
      clientId,
      scope: token.scope,
      ...(token.expires_in ? { expiresAt: this.now() + token.expires_in * 1000 } : {}),
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
      ...(token.refresh_token_expires_in
        ? { refreshExpiresAt: this.now() + token.refresh_token_expires_in * 1000 }
        : {}),
    });
  }
  async refresh(credential: GitHubCredential, signal?: AbortSignal) {
    if (
      !credential.refreshToken ||
      (credential.refreshExpiresAt !== undefined && credential.refreshExpiresAt <= this.now())
    )
      throw oauthError('bad_refresh_token');
    const result = await this.post(
      'oauth/access_token',
      {
        client_id: credential.clientId,
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
      },
      signal,
    );
    const error = errorSchema.safeParse(result);
    if (error.success) throw oauthError(error.data.error);
    return this.credential(result, credential.clientId);
  }
}
type Session = {
  id: string;
  controller: AbortController;
  clientId: string;
  interval: number;
  deviceCode?: string;
  challenge?: DeviceChallenge;
  polling: boolean;
};
export class GitHubDeviceFlow {
  private session?: Session;
  constructor(
    private complete: (
      credential: GitHubCredential,
      signal: AbortSignal,
    ) => Promise<ProviderAccounts>,
    private oauth = new GitHubOAuth(),
    private now = Date.now,
  ) {}
  cancel(id?: string) {
    if (this.session && (id === undefined || this.session.id === id)) {
      this.session.controller.abort();
      this.session = undefined;
    }
  }
  private current(id: string) {
    const session = this.session;
    if (
      !session ||
      session.id !== id ||
      !session.challenge ||
      session.challenge.expiresAt <= this.now()
    ) {
      if (session?.id === id) this.cancel(id);
      throw oauthError('expired_token');
    }
    return session;
  }
  verificationUri(id: string) {
    return this.current(id).challenge!.verificationUri;
  }
  async start(input: DeviceStart, signal?: AbortSignal) {
    const options = deviceStartSchema.parse(input);
    this.cancel();
    const session: Session = {
      id: randomUUID(),
      controller: new AbortController(),
      clientId: options.clientId,
      interval: 5,
      polling: false,
    };
    this.session = session;
    const combined = signal
      ? AbortSignal.any([signal, session.controller.signal])
      : session.controller.signal;
    try {
      combined.throwIfAborted();
      const result = await this.oauth.post(
        'device/code',
        {
          client_id: options.clientId,
          scope: `read:user ${options.privateRepositories ? 'repo' : 'public_repo'}`,
        },
        combined,
      );
      const error = errorSchema.safeParse(result);
      if (error.success) throw oauthError(error.data.error);
      const parsed = startResponseSchema.safeParse(result);
      if (!parsed.success)
        throw new ProviderError(
          'DEVICE_RESPONSE',
          'GitHub returned an invalid authorization response.',
        );
      combined.throwIfAborted();
      if (this.session !== session)
        throw new ProviderError('CANCELLED', 'GitHub authorization cancelled.');
      const data = parsed.data;
      session.interval = data.interval;
      session.deviceCode = data.device_code;
      session.challenge = deviceChallengeSchema.parse({
        id: session.id,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresAt: this.now() + data.expires_in * 1000,
        nextPollAt: this.now() + data.interval * 1000,
      });
      return { ...session.challenge };
    } catch (error) {
      this.cancel(session.id);
      throw error;
    }
  }
  async poll(
    id: string,
    signal?: AbortSignal,
  ): Promise<
    | { kind: 'providerDevice'; challenge: DeviceChallenge }
    | { kind: 'providerAccounts'; state: ProviderAccounts }
  > {
    const session = this.current(id);
    const challenge = session.challenge!;
    if (session.polling || this.now() < challenge.nextPollAt)
      return { kind: 'providerDevice', challenge: { ...challenge } };
    session.polling = true;
    challenge.nextPollAt = this.now() + session.interval * 1000;
    const combined = signal
      ? AbortSignal.any([signal, session.controller.signal])
      : session.controller.signal;
    try {
      const result = await this.oauth.post(
        'oauth/access_token',
        {
          client_id: session.clientId,
          device_code: session.deviceCode!,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        },
        combined,
      );
      combined.throwIfAborted();
      this.current(id);
      const error = errorSchema.safeParse(result);
      if (error.success) {
        if (!['authorization_pending', 'slow_down'].includes(error.data.error))
          throw oauthError(error.data.error);
        if (error.data.error === 'slow_down')
          session.interval = Math.max(session.interval + 5, error.data.interval ?? 0);
        challenge.nextPollAt = this.now() + session.interval * 1000;
        return { kind: 'providerDevice', challenge: { ...challenge } };
      }
      const credential = this.oauth.credential(result, session.clientId);
      const state = await this.complete(credential, combined);
      this.cancel(id);
      return { kind: 'providerAccounts', state };
    } catch (error) {
      this.cancel(id);
      throw error;
    } finally {
      session.polling = false;
    }
  }
}
