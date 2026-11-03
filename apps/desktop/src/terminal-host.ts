import { utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  terminalEventSchema,
  terminalReadySchema,
  type Result,
  type TerminalEvent,
  type TerminalRequest,
} from '@openkraken/ipc-contract';

interface Session {
  id: string;
  child: UtilityProcess;
  stopped: Promise<void>;
  ended?: boolean;
}
export class TerminalHost {
  private active?: Session;
  constructor(private emit: (event: TerminalEvent) => void) {}
  async request(
    request: TerminalRequest,
    repository?: { id: string; path: string },
  ): Promise<Result> {
    if (request.method === 'terminalOpen') {
      if (!repository || repository.id !== request.repoId)
        return {
          kind: 'error',
          code: 'TERMINAL_REPOSITORY',
          message: 'Open this repository before starting a terminal.',
        };
      if (this.active)
        return {
          kind: 'error',
          code: 'TERMINAL_BUSY',
          message: 'Close the existing terminal before opening another.',
        };
      return this.open(request, repository.path);
    }
    if (request.method === 'terminalClose') {
      if (this.active?.id === request.sessionId) await this.close();
      return { kind: 'terminalAck' };
    }
    if (!this.active || this.active.ended || this.active.id !== request.sessionId)
      return {
        kind: 'error',
        code: 'TERMINAL_CLOSED',
        message: 'This terminal session has ended.',
      };
    this.active.child.postMessage(request);
    return { kind: 'terminalAck' };
  }
  private open(
    request: Extract<TerminalRequest, { method: 'terminalOpen' }>,
    cwd: string,
  ): Promise<Result> {
    const child = utilityProcess.fork(join(__dirname, 'terminal-service.cjs'), [], {
      serviceName: 'OpenKraken Terminal',
      stdio: 'ignore',
    });
    const session: Session = {
      id: request.sessionId,
      child,
      stopped: new Promise((resolve) => child.once('exit', () => resolve())),
    };
    this.active = session;
    return new Promise((resolve) => {
      let settled = false;
      let exited = false;
      const finish = (result: Result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        finish({
          kind: 'error',
          code: 'TERMINAL_START',
          message: 'The terminal did not start. Check your default shell and try again.',
        });
        void this.close();
      }, 10000);
      child.on('message', (message) => {
        if (this.active !== session) return;
        const ready = terminalReadySchema.safeParse(message);
        if (ready.success && ready.data.id === session.id) {
          finish({ kind: 'terminalOpened', sessionId: session.id, shell: ready.data.shell });
          return;
        }
        const event = terminalEventSchema.safeParse(message);
        if (!event.success || event.data.id !== session.id) return;
        if (event.data.type === 'terminalExit') {
          exited = true;
          session.ended = true;
        }
        this.emit(event.data);
      });
      child.once('exit', () => {
        if (this.active === session) {
          this.active = undefined;
          if (!exited)
            this.emit({ type: 'terminalExit', id: session.id, exitCode: null, signal: null });
        }
        finish({
          kind: 'error',
          code: 'TERMINAL_START',
          message: 'The terminal could not start. Check your default shell and try again.',
        });
      });
      child.postMessage({
        type: 'start',
        sessionId: session.id,
        cwd,
        cols: request.cols,
        rows: request.rows,
      });
    });
  }
  async close() {
    const session = this.active;
    if (!session) return;
    session.child.postMessage({ id: randomUUID(), method: 'terminalClose', sessionId: session.id });
    const deadline = setTimeout(() => session.child.kill(), 1000);
    await session.stopped;
    clearTimeout(deadline);
  }
}
