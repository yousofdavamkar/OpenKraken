import { createServer, type Socket } from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  providerGitCredentialSchema,
  type ProviderGitCredential,
  type AuthenticationEvent,
} from '@openkraken/ipc-contract';
import { GitError } from './runner.js';
import { redactGitMessage } from './progress.js';
const messageSchema = z
  .object({
    token: z.string().regex(/^[0-9a-f]{64}$/),
    prompt: z.string().max(4096),
    hint: z.enum(['', 'confirm']),
  })
  .strict();
type Scope = {
  id: string;
  token: Buffer;
  context: string;
  credential?: ProviderGitCredential;
  close: () => void;
};
type Pending = {
  scope: Scope;
  kind: 'username' | 'secret' | 'confirm';
  socket: Socket;
  finish: (answer: string | null) => void;
};
/** A private local socket per service, with expiring capabilities per native operation. */
export class AskpassBroker {
  private scopes = new Map<string, Scope>();
  private pending = new Map<string, Pending>();
  private sockets = new Set<Socket>();
  private server = createServer((socket) => this.connect(socket));
  private ready?: Promise<string>;
  private stopped = false;
  private directory?: string;
  constructor(
    private helper: string,
    private emit: (event: AuthenticationEvent) => void,
  ) {
    this.server.maxConnections = 16;
  }
  private start() {
    return (this.ready ??= this.listen());
  }
  private async listen() {
    let path: string;
    if (process.platform === 'win32') path = `\\\\.\\pipe\\openkraken-${randomUUID()}`;
    else {
      this.directory = await mkdtemp(join(tmpdir(), 'openkraken-auth-'));
      await chmod(this.directory, 0o700);
      path = join(this.directory, 'prompt.sock');
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(path, resolve);
    });
    if (process.platform !== 'win32') await chmod(path, 0o600);
    return path;
  }
  async open(
    id: string,
    context: string,
    signal?: AbortSignal,
    credential?: ProviderGitCredential,
  ) {
    if (credential) credential = providerGitCredentialSchema.parse(credential);
    if (this.stopped) throw new GitError('CANCELLED', 'Authentication cancelled');
    const path = await this.start();
    if (this.stopped || signal?.aborted)
      throw new GitError('CANCELLED', 'Authentication cancelled');
    if (this.scopes.has(id) || this.scopes.size >= 8)
      throw new GitError('AUTH_BUSY', 'Too many authentication requests');
    const scope: Scope = {
      id,
      credential,
      token: randomBytes(32),
      context: redactGitMessage(context).slice(0, 1024),
      close: () => {
        if (!this.scopes.delete(id)) return;
        signal?.removeEventListener('abort', scope.close);
        for (const pending of this.pending.values())
          if (pending.scope === scope) pending.finish(null);
        scope.credential = undefined;
        scope.token.fill(0);
      },
    };
    this.scopes.set(id, scope);
    signal?.addEventListener('abort', scope.close, { once: true });
    return {
      environment: {
        GIT_ASKPASS: this.helper,
        SSH_ASKPASS: this.helper,
        SSH_ASKPASS_REQUIRE: 'force',
        OPENKRAKEN_ASKPASS_SOCKET: path,
        OPENKRAKEN_ASKPASS_TOKEN: scope.token.toString('hex'),
      },
      close: scope.close,
    };
  }
  answer(id: string, promptId: string, answer: string | null) {
    const pending = this.pending.get(promptId);
    if (
      !pending ||
      pending.scope.id !== id ||
      (answer !== null &&
        (answer.length > 4096 ||
          /[\r\n]/.test(answer) ||
          answer.includes('\0') ||
          (pending.kind === 'confirm' && !['yes', 'no'].includes(answer))))
    )
      return false;
    pending.finish(answer);
    return true;
  }
  private connect(socket: Socket) {
    this.sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => this.sockets.delete(socket));
    socket.setTimeout(5000, () => socket.destroy());
    let bytes = Buffer.alloc(0);
    const read = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 32768) {
        socket.destroy();
        return;
      }
      const end = bytes.indexOf(10);
      if (end < 0) return;
      socket.off('data', read);
      socket.on('data', () => socket.destroy());
      let input: z.infer<typeof messageSchema>;
      try {
        if (end !== bytes.length - 1) throw new Error('Extra frame');
        input = messageSchema.parse(JSON.parse(bytes.subarray(0, end).toString()));
      } catch {
        socket.destroy();
        return;
      }
      const token = Buffer.from(input.token, 'hex');
      const scope = [...this.scopes.values()].find((scope) => timingSafeEqual(scope.token, token));
      if (!scope || [...this.pending.values()].some((pending) => pending.scope === scope)) {
        socket.destroy();
        return;
      }
      if (scope.credential) {
        // Git runs in the C locale. A saved credential never answers SSH, proxy, or another URL.
        let answer: string | undefined;
        const match = /^(Username|Password) for '([^']+)': ?$/.exec(input.prompt);
        if (match && input.hint === '') {
          try {
            const url = new URL(match[2]!);
            const credential = scope.credential;
            if (
              `${url.origin}${url.pathname}` === credential.url &&
              !url.password &&
              !url.search &&
              !url.hash
            ) {
              if (match[1] === 'Username' && !url.username) answer = credential.username;
              if (
                match[1] === 'Password' &&
                decodeURIComponent(url.username) === credential.username
              )
                answer = credential.password;
            }
          } catch {
            /* Invalid prompt URLs cannot receive credentials. */
          }
        }
        socket.end(
          JSON.stringify(answer === undefined ? { ok: false } : { ok: true, answer }) + '\n',
        );
        return;
      }
      const promptId = randomUUID();
      const kind =
        input.hint === 'confirm' ||
        /\(yes\/no(?:\/\[fingerprint\])?\)|Please type 'yes'.*'no'/i.test(input.prompt)
          ? 'confirm'
          : /^Username\b/i.test(input.prompt)
            ? 'username'
            : 'secret';
      const finish = (answer: string | null) => {
        if (!this.pending.delete(promptId)) return;
        socket.end(JSON.stringify(answer === null ? { ok: false } : { ok: true, answer }) + '\n');
        this.emit({ type: 'authenticationClosed', id: scope.id, promptId });
      };
      this.pending.set(promptId, { scope, kind, socket, finish });
      socket.setTimeout(180000, () => finish(null));
      socket.once('close', () => finish(null));
      this.emit({
        type: 'authenticationPrompt',
        id: scope.id,
        promptId,
        context: scope.context,
        message: redactGitMessage(input.prompt).slice(0, 4096),
        kind,
      });
    };
    socket.on('data', read);
  }
  async close() {
    this.stopped = true;
    for (const scope of this.scopes.values()) scope.close();
    for (const socket of this.sockets) socket.destroy();
    if (this.ready) await this.ready.catch(() => {});
    if (this.server.listening)
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
