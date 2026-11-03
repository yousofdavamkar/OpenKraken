import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getTheme, subscribeTheme } from './theme.js';
import '@xterm/xterm/css/xterm.css';

export interface TerminalSession {
  id: string;
  repoId: string;
  path: string;
}
export interface TerminalHandle {
  focus: () => void;
}
interface ShellProgress {
  phase: 'unavailable' | 'prompt' | 'ready' | 'running' | 'finished';
  exitCode?: number;
}
function describeProgress({ phase, exitCode }: ShellProgress): string {
  if (phase === 'prompt') return 'Prompt';
  if (phase === 'running') return 'Command running';
  if (phase === 'ready')
    return `Ready for command${exitCode === undefined ? '' : ` · last exit ${exitCode}`}`;
  if (phase === 'finished')
    return `Command finished${exitCode === undefined ? '' : ` · exit ${exitCode}`}`;
  return 'Shell integration unavailable';
}
export default function TerminalPanel({
  ref,
  session,
  hidden,
  onHide,
  onClose,
}: {
  ref?: Ref<TerminalHandle>;
  session: TerminalSession;
  hidden: boolean;
  onHide: () => void;
  onClose: () => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const view = useRef<Terminal>(undefined);
  useImperativeHandle(ref, () => ({ focus: () => view.current?.focus() }), []);
  const fit = useRef<() => void>(undefined);
  const hideButton = useRef<HTMLButtonElement>(null);
  const confirmation = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState('Starting…');
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const [progress, setProgress] = useState<ShellProgress>({ phase: 'unavailable' });
  const request = (method: 'terminalClose') =>
    window.openkraken.request({ id: crypto.randomUUID(), method, sessionId: session.id });
  useEffect(() => {
    let alive = true;
    let exited = false;
    let inputQueue = Promise.resolve();
    let queuedCharacters = 0;
    const theme = () => {
      const colors = getTheme().colors;
      return {
        background: colors.editorBackground,
        foreground: colors.editorText,
        cursor: colors.text,
        selectionBackground: colors.selectedBackground,
      };
    };
    const terminal = new Terminal({
      theme: theme(),
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 5000,
      screenReaderMode: true,
      disableStdin: true,
    });
    // Shell output is untrusted. These markers describe display state only;
    // native process exit remains the authority for session lifecycle.
    const markers = terminal.parser.registerOscHandler(133, (data) => {
      if (!alive || exited) return true;
      if (data === 'A' || data === 'B' || data === 'C') {
        const phase = data === 'A' ? 'prompt' : data === 'B' ? 'ready' : 'running';
        setProgress((previous) => ({ ...previous, phase }));
        return true;
      }
      if (data === 'D') {
        setProgress({ phase: 'finished' });
        return true;
      }
      if (/^D;-?\d{1,10}$/.test(data)) {
        const exitCode = Number(data.slice(2));
        if (exitCode >= -2147483648 && exitCode <= 2147483647) {
          setProgress({ phase: 'finished', exitCode });
          return true;
        }
      }
      return false;
    });
    const sizing = new FitAddon();
    terminal.loadAddon(sizing);
    terminal.open(element.current!);
    terminal.textarea!.setAttribute('aria-label', 'Terminal input');
    terminal.textarea!.setAttribute('aria-description', 'Press F6 to focus terminal controls.');
    view.current = terminal;
    const resize = () => {
      if (!element.current?.clientWidth || !element.current.clientHeight) return;
      const size = sizing.proposeDimensions();
      if (size)
        terminal.resize(
          Math.max(2, Math.min(500, size.cols)),
          Math.max(1, Math.min(500, size.rows)),
        );
    };
    fit.current = resize;
    resize();
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.key === 'F6') {
        if (event.type === 'keydown') hideButton.current?.focus();
        return false;
      }
      return true;
    });
    const unsubscribe = window.openkraken.subscribe((event) => {
      if (
        (event.type !== 'terminalData' && event.type !== 'terminalExit') ||
        event.id !== session.id ||
        !alive
      )
        return;
      if (event.type === 'terminalData') {
        terminal.write(event.data, () => {
          if (alive)
            void window.openkraken.request({
              id: crypto.randomUUID(),
              method: 'terminalAck',
              sessionId: session.id,
              sequence: event.sequence,
            });
        });
      } else {
        exited = true;
        terminal.options.disableStdin = true;
        setEnded(true);
        setProgress({ phase: 'unavailable' });
        setStatus(
          event.exitCode === null ? 'Terminal stopped' : `Exited with code ${event.exitCode}`,
        );
      }
    });
    const input = terminal.onData((data) => {
      if (queuedCharacters + data.length > 1048576) {
        setError('Terminal input is too large. Paste a smaller block.');
        return;
      }
      queuedCharacters += data.length;
      inputQueue = inputQueue
        .then(async () => {
          let remaining = data;
          while (alive && remaining.length) {
            let length = Math.min(8192, remaining.length);
            if (length < remaining.length && /[\uD800-\uDBFF]/.test(remaining[length - 1]!))
              length--;
            const result = await window.openkraken.request({
              id: crypto.randomUUID(),
              method: 'terminalInput',
              sessionId: session.id,
              data: remaining.slice(0, length),
            });
            if (result.kind === 'error') throw new Error(result.message);
            remaining = remaining.slice(length);
          }
        })
        .catch((reason) => {
          if (alive) setError(reason instanceof Error ? reason.message : 'Terminal input failed.');
        })
        .finally(() => {
          queuedCharacters -= data.length;
        });
    });
    const dimensions = terminal.onResize(({ cols, rows }) => {
      if (!terminal.options.disableStdin)
        void window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'terminalResize',
          sessionId: session.id,
          cols,
          rows,
        });
    });
    const observer = new ResizeObserver(resize);
    observer.observe(element.current!);
    const unsubscribeTheme = subscribeTheme(() => {
      terminal.options.theme = theme();
    });
    void window.openkraken
      .request({
        id: crypto.randomUUID(),
        method: 'terminalOpen',
        sessionId: session.id,
        repoId: session.repoId,
        cols: terminal.cols,
        rows: terminal.rows,
      })
      .then((result) => {
        if (!alive) return;
        if (result.kind !== 'terminalOpened')
          throw new Error(result.kind === 'error' ? result.message : 'Terminal could not start.');
        if (exited) return;
        setStatus(`Running · ${result.shell}`);
        terminal.options.disableStdin = false;
        resize();
        terminal.focus();
      })
      .catch((reason) => {
        if (!alive) return;
        setEnded(true);
        setStatus('Terminal unavailable');
        setError(reason instanceof Error ? reason.message : 'Terminal could not start.');
      });
    return () => {
      alive = false;
      unsubscribe();
      unsubscribeTheme();
      observer.disconnect();
      input.dispose();
      dimensions.dispose();
      markers.dispose();
      terminal.dispose();
      view.current = undefined;
      fit.current = undefined;
      void window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'terminalClose',
        sessionId: session.id,
      });
    };
  }, [session]);
  useEffect(() => {
    if (hidden) return;
    fit.current?.();
    view.current?.focus();
  }, [hidden]);
  useEffect(() => {
    if (ended) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [ended]);
  const close = async () => {
    setClosing(true);
    try {
      const result = await request('terminalClose');
      if (result.kind === 'error') throw new Error(result.message);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Terminal could not close.');
      setClosing(false);
    }
  };
  return (
    <section className="terminal-panel" aria-label="Terminal" hidden={hidden}>
      <div className="terminal-toolbar">
        <strong>Terminal</strong>
        <span className="terminal-path" title={session.path}>
          {session.path}
        </span>
        <span role="status">{status}</span>
        <span aria-label="Shell integration" aria-live="polite">
          {describeProgress(progress)}
        </span>
        <button ref={hideButton} onClick={onHide}>
          Hide terminal
        </button>
        <button onClick={() => (ended ? onClose() : confirmation.current?.showModal())}>
          Close terminal
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <div ref={element} className="terminal-screen" />
      <dialog
        ref={confirmation}
        className="reference-dialog"
        aria-label="Close terminal?"
        onCancel={(event) => {
          if (closing) event.preventDefault();
        }}
      >
        <h2>Close terminal?</h2>
        <p>This ends the shell and may stop commands running in it.</p>
        <div className="dialog-actions">
          <button
            disabled={closing}
            onClick={() => {
              confirmation.current?.close();
              view.current?.focus();
            }}
          >
            Keep open
          </button>
          <button disabled={closing} onClick={() => void close()}>
            End session
          </button>
        </div>
      </dialog>
    </section>
  );
}
