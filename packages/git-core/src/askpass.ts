import { createServer, type Socket } from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AuthenticationEvent } from '@openkraken/ipc-contract';
import { GitError } from './runner.js';
import { redactGitMessage } from './progress.js';
const messageSchema = z
  .object({
    token: z.string().regex(/^[0-9a-f]{64}$/),
    prompt: z.string().max(4096),
    hint: z.enum(['', 'confirm']),
  })
  .strict();
type Scope = { id: string; token: Buffer; context: string; close: () => void };
type Pending = {
  scope: Scope;
  kind: 'username' | 'secret' | 'confirm';
  socket: Socket;
  finish: (answer: string | null) => void;
};
/** One loopback listener per service, with expiring random credentials per native operation. */
export class AskpassBroker {
  private scopes = new Map<string, Scope>();
  private pending = new Map<string, Pending>();
  private sockets = new Set<Socket>();
  private server = createServer((socket) => this.connect(socket));
  private ready?: Promise<string>;
  private stopped = false;
  constructor(
    private helper: string,
    private emit: (event: AuthenticationEvent) => void,
  ) {
    this.server.maxConnections = 16;
  }
  private start() {
    return (this.ready ??= new Promise<string>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Invalid helper listener'));
          return;
        }
        resolve(`127.0.0.1:${address.port}`);
      });
    }));
  }
  async open(id: string, context: string, signal?: AbortSignal) {
    if (this.stopped) throw new GitError('CANCELLED', 'Authentication cancelled');
    const address = await this.start();
    if (this.stopped || signal?.aborted)
      throw new GitError('CANCELLED', 'Authentication cancelled');
    if (this.scopes.has(id) || this.scopes.size >= 8)
      throw new GitError('AUTH_BUSY', 'Too many authentication requests');
    const scope: Scope = {
      id,
      token: randomBytes(32),
      context: redactGitMessage(context).slice(0, 1024),
      close: () => {
        if (!this.scopes.delete(id)) return;
        signal?.removeEventListener('abort', scope.close);
        for (const pending of this.pending.values())
          if (pending.scope === scope) pending.finish(null);
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
        OPENKRAKEN_ASKPASS_ADDRESS: address,
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
      const promptId = randomUUID();
      const kind =
        input.hint === 'confirm'
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
  }
}
