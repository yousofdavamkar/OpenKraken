import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import {
  gitlabStartSchema,
  gitlabChallengeSchema,
  gitlabRedirectSchema,
  providerOriginSchema,
  type GitLabStart,
  type GitLabChallenge,
  type ProviderAccounts,
} from '@openkraken/ipc-contract';
import { ProviderError } from './provider-error.js';

const secret = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);
export const gitlabCredentialSchema = z
  .object({
    accessToken: secret,
    refreshToken: secret,
    clientId: gitlabStartSchema.shape.clientId,
    redirectUri: gitlabRedirectSchema,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type GitLabCredential = z.infer<typeof gitlabCredentialSchema>;

export class GitLabOAuth {
  constructor(
    private fetcher: typeof fetch = (...args) => fetch(...args),
    private now = Date.now,
  ) {}
  private async token(origin: string, parameters: Record<string, string>, signal?: AbortSignal) {
    const host = providerOriginSchema.parse(origin);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      combined.throwIfAborted();
      const response = await this.fetcher(`${host}/oauth/token`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'OpenKraken/0.1.0',
        },
        body: new URLSearchParams(parameters).toString(),
        credentials: 'omit',
        redirect: 'error',
        signal: combined,
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        if (!response.ok) throw new Error('status');
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
      const token = z
        .object({
          access_token: secret,
          refresh_token: secret,
          token_type: z.literal('bearer'),
          expires_in: z
            .number()
            .int()
            .positive()
            .max(366 * 86400),
          created_at: z
            .number()
            .int()
            .nonnegative()
            .max(Math.floor(this.now() / 1000) + 300)
            .optional(),
        })
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      combined.throwIfAborted();
      const credential = gitlabCredentialSchema.parse({
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        clientId: parameters.client_id,
        redirectUri: parameters.redirect_uri,
        expiresAt:
          Math.min(this.now(), (token.created_at ?? this.now() / 1000) * 1000) +
          token.expires_in * 1000,
      });
      if (credential.expiresAt <= this.now()) throw new Error('expired');
      return credential;
    } catch {
      if (signal?.aborted) throw new ProviderError('CANCELLED', 'GitLab authorization cancelled.');
      throw new ProviderError(
        'GITLAB_AUTH',
        'GitLab authorization failed. Check the application settings and sign in again.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
  exchange(
    origin: string,
    clientId: string,
    redirectUri: string,
    code: string,
    verifier: string,
    signal: AbortSignal,
  ) {
    return this.token(
      origin,
      {
        client_id: clientId,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
      },
      signal,
    );
  }
  refresh(origin: string, credential: GitLabCredential, signal?: AbortSignal) {
    return this.token(
      origin,
      {
        client_id: credential.clientId,
        redirect_uri: credential.redirectUri,
        grant_type: 'refresh_token',
        refresh_token: credential.refreshToken,
      },
      signal,
    );
  }
}

type Session = {
  challenge: GitLabChallenge;
  clientId: string;
  state: string;
  verifier: string;
  controller: AbortController;
  listener: Server;
  timer: ReturnType<typeof setTimeout>;
  code?: string;
  denied?: boolean;
  polling: boolean;
};
export class GitLabFlow {
  private session?: Session;
  constructor(
    private complete: (
      origin: string,
      credential: GitLabCredential,
      signal: AbortSignal,
    ) => Promise<ProviderAccounts>,
    private oauth = new GitLabOAuth(),
    private now = Date.now,
  ) {}
  cancel(id?: string) {
    const session = this.session;
    if (!session || (id !== undefined && id !== session.challenge.id)) return;
    this.session = undefined;
    clearTimeout(session.timer);
    session.controller.abort();
    session.listener.close();
    session.listener.closeAllConnections();
  }
  private current(id: string) {
    const session = this.session;
    if (!session || session.challenge.id !== id || session.challenge.expiresAt <= this.now()) {
      if (session?.challenge.id === id) this.cancel(id);
      throw new ProviderError(
        'GITLAB_AUTH_EXPIRED',
        'GitLab sign-in expired or was cancelled. Start again to sign in.',
      );
    }
    return session;
  }
  authorizationUri(id: string) {
    const session = this.current(id);
    const url = new URL('/oauth/authorize', session.challenge.origin);
    url.search = new URLSearchParams({
      client_id: session.clientId,
      redirect_uri: session.challenge.redirectUri,
      response_type: 'code',
      scope: 'api',
      state: session.state,
      code_challenge: createHash('sha256').update(session.verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return url.href;
  }
  async start(input: GitLabStart, signal?: AbortSignal) {
    const options = gitlabStartSchema.parse(input);
    signal?.throwIfAborted();
    this.cancel();
    const id = randomUUID();
    const challenge = gitlabChallengeSchema.parse({
      id,
      origin: options.origin,
      redirectUri: `http://127.0.0.1:${options.callbackPort}/callback`,
      expiresAt: this.now() + 600000,
    });
    const listener = createServer(
      { maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 },
      (request, response) => {
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        response.setHeader('Connection', 'close');
        const reject = () => {
          response.writeHead(400);
          response.end('Invalid sign-in callback.');
        };
        try {
          const session = this.current(id);
          if (
            request.method !== 'GET' ||
            request.headers.host !== `127.0.0.1:${options.callbackPort}` ||
            !request.url?.startsWith('/callback?') ||
            session.code ||
            session.denied
          )
            return reject();
          const url = new URL(request.url, challenge.redirectUri);
          const parameters = url.searchParams;
          if (
            url.pathname !== '/callback' ||
            parameters.getAll('state').length !== 1 ||
            parameters.getAll('code').length > 1 ||
            parameters.getAll('error').length > 1
          )
            return reject();
          const state = Buffer.from(parameters.get('state') ?? '');
          const expected = Buffer.from(session.state);
          if (state.length !== expected.length || !timingSafeEqual(state, expected))
            return reject();
          const code = parameters.get('code');
          const error = parameters.get('error');
          if ((!code && !error) || (code && error) || (code && !secret.safeParse(code).success))
            return reject();
          if (error) session.denied = true;
          else session.code = code!;
          listener.close();
          response.end('Return to OpenKraken to complete sign-in. You can close this tab.');
        } catch {
          reject();
        }
      },
    );
    listener.maxConnections = 8;
    const session: Session = {
      challenge,
      clientId: options.clientId,
      state: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'),
      controller: new AbortController(),
      listener,
      timer: setTimeout(() => this.cancel(id), 600000),
      polling: false,
    };
    session.timer.unref();
    this.session = session;
    const abort = () => this.cancel(id);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const cancelled = () => reject(new Error('cancelled'));
        session.controller.signal.addEventListener('abort', cancelled, { once: true });
        listener.once('error', reject);
        listener.listen(
          { port: options.callbackPort, host: '127.0.0.1', signal: session.controller.signal },
          () => {
            session.controller.signal.removeEventListener('abort', cancelled);
            resolve();
          },
        );
      });
      listener.unref();
      signal?.throwIfAborted();
      this.current(id);
      return { ...challenge };
    } catch {
      const cancelled = signal?.aborted || session.controller.signal.aborted;
      this.cancel(id);
      if (cancelled) throw new ProviderError('CANCELLED', 'GitLab authorization cancelled.');
      throw new ProviderError(
        'GITLAB_CALLBACK',
        'The local sign-in port is unavailable. Choose another port and register its callback URL in GitLab.',
      );
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  async poll(
    id: string,
    signal?: AbortSignal,
  ): Promise<
    | { kind: 'providerGitLab'; challenge: GitLabChallenge }
    | { kind: 'providerAccounts'; state: ProviderAccounts }
  > {
    const session = this.current(id);
    if (session.polling || (!session.code && !session.denied))
      return { kind: 'providerGitLab', challenge: { ...session.challenge } };
    session.polling = true;
    const combined = signal
      ? AbortSignal.any([signal, session.controller.signal])
      : session.controller.signal;
    try {
      if (session.denied)
        throw new ProviderError(
          'GITLAB_AUTH_DENIED',
          'GitLab authorization was declined. Start again to sign in.',
        );
      const credential = await this.oauth.exchange(
        session.challenge.origin,
        session.clientId,
        session.challenge.redirectUri,
        session.code!,
        session.verifier,
        combined,
      );
      combined.throwIfAborted();
      this.current(id);
      const state = await this.complete(session.challenge.origin, credential, combined);
      return { kind: 'providerAccounts', state };
    } finally {
      this.cancel(id);
    }
  }
}
