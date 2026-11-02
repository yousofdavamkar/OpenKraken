import { createServer, type Socket } from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { GitError } from './runner.js';
const requestSchema = z
  .object({
    token: z.string().regex(/^[0-9a-f]{64}$/),
    path: z
      .string()
      .min(1)
      .max(16384)
      .refine((path) => !path.includes('\0')),
  })
  .strict();
/** One native Git invocation; callers validate the requested file against its reviewed session. */
export async function openGitEditor(
  helper: string,
  edit: (path: string, signal: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new GitError('CANCELLED', 'Git editor cancelled');
  const token = randomBytes(32);
  const abort = new AbortController();
  const sockets = new Set<Socket>();
  let active = false;
  let directory: string | undefined;
  let closed: Promise<void> | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
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
      let request: z.infer<typeof requestSchema>;
      try {
        if (end !== bytes.length - 1 || active || abort.signal.aborted)
          throw new Error('Invalid editor frame');
        request = requestSchema.parse(JSON.parse(bytes.subarray(0, end).toString('utf8')));
        if (!timingSafeEqual(token, Buffer.from(request.token, 'hex')))
          throw new Error('Invalid editor token');
      } catch {
        socket.destroy();
        return;
      }
      active = true;
      socket.setTimeout(180000, () => socket.destroy());
      void edit(request.path, abort.signal)
        .then(
          () => socket.end(JSON.stringify({ ok: !abort.signal.aborted }) + '\n'),
          () => socket.end('{"ok":false}\n'),
        )
        .finally(() => {
          active = false;
        });
    };
    socket.on('data', read);
  });
  server.maxConnections = 8;
  const close = () =>
    (closed ??= (async () => {
      signal?.removeEventListener('abort', cancel);
      abort.abort();
      token.fill(0);
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (directory) await rm(directory, { recursive: true, force: true });
    })());
  const cancel = () => {
    void close();
  };
  try {
    let path: string;
    if (process.platform === 'win32') path = `\\\\.\\pipe\\openkraken-editor-${randomUUID()}`;
    else {
      directory = await mkdtemp(join(tmpdir(), 'openkraken-editor-'));
      await chmod(directory, 0o700);
      path = join(directory, 'editor.sock');
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    if (process.platform !== 'win32') await chmod(path, 0o600);
    if (signal?.aborted) throw new GitError('CANCELLED', 'Git editor cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    // Git interprets editor settings through its shell, including Git for Windows.
    const command = `'${helper.replaceAll("'", "'\\''")}' --editor`;
    return {
      environment: {
        GIT_EDITOR: command,
        GIT_SEQUENCE_EDITOR: command,
        OPENKRAKEN_EDITOR_SOCKET: path,
        OPENKRAKEN_EDITOR_TOKEN: token.toString('hex'),
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
