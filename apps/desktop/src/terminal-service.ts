import { basename, isAbsolute } from 'node:path';
import { userInfo } from 'node:os';
import { spawn, type IPty } from 'node-pty';
import { terminalRequestSchema, terminalStartSchema } from '@openkraken/ipc-contract';

const parent = process.parentPort;
if (!parent) throw new Error('Terminal requires a parent port');
let terminal: IPty | undefined;
let sessionId: string | undefined;
let sequence = 0;
let acknowledged = 0;
let pendingCharacters = 0;
const pending = new Map<number, number>();
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  terminal?.resume();
  terminal?.kill();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', close);
process.on('disconnect', close);
parent.on('message', ({ data }) => {
  if (!sessionId) {
    const parsed = terminalStartSchema.safeParse(data);
    if (!parsed.success) return;
    sessionId = parsed.data.sessionId;
    const preferred =
      process.platform === 'win32' ? process.env.ComSpec : process.env.SHELL || userInfo().shell;
    const shell =
      preferred && isAbsolute(preferred)
        ? preferred
        : process.platform === 'win32'
          ? 'C:\\Windows\\System32\\cmd.exe'
          : '/bin/sh';
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'OpenKraken',
    };
    for (const name of Object.keys(env))
      if (
        /^(?:ELECTRON_|NODE_OPTIONS$|NODE_CHANNEL_FD$|NODE_CHANNEL_SERIALIZATION_MODE$|OPENKRAKEN_)/.test(
          name,
        )
      )
        delete env[name];
    try {
      terminal = spawn(shell, [], {
        name: 'xterm-256color',
        cols: parsed.data.cols,
        rows: parsed.data.rows,
        cwd: parsed.data.cwd,
        env,
      });
      terminal.onData((data) => {
        while (data.length) {
          let length = Math.min(16384, data.length);
          if (length < data.length && /[\uD800-\uDBFF]/.test(data[length - 1]!)) length--;
          const part = data.slice(0, length);
          data = data.slice(length);
          pending.set(++sequence, part.length);
          pendingCharacters += part.length;
          parent.postMessage({ type: 'terminalData', id: sessionId, sequence, data: part });
        }
        if (pendingCharacters >= 262144 || pending.size >= 256) terminal?.pause();
      });
      terminal.onExit(({ exitCode, signal }) => {
        parent.postMessage({
          type: 'terminalExit',
          id: sessionId,
          exitCode,
          signal: signal ?? null,
        });
        setImmediate(() => process.exit(0));
      });
      parent.postMessage({ type: 'ready', id: sessionId, shell: basename(shell) });
    } catch {
      parent.postMessage({ type: 'terminalExit', id: sessionId, exitCode: null, signal: null });
      setImmediate(() => process.exit(1));
    }
    return;
  }
  const parsed = terminalRequestSchema.safeParse(data);
  if (!parsed.success || parsed.data.sessionId !== sessionId || closing) return;
  const request = parsed.data;
  if (request.method === 'terminalClose') close();
  if (request.method === 'terminalInput') terminal?.write(request.data);
  if (request.method === 'terminalResize') terminal?.resize(request.cols, request.rows);
  if (
    request.method === 'terminalAck' &&
    request.sequence > acknowledged &&
    request.sequence <= sequence
  ) {
    acknowledged = request.sequence;
    for (const [number, length] of pending) {
      if (number > acknowledged) break;
      pendingCharacters -= length;
      pending.delete(number);
    }
    if (pendingCharacters < 131072 && pending.size < 128) terminal?.resume();
  }
});
