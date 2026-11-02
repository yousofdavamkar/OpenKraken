import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import fuzzysort from 'fuzzysort';
import { commandCatalog, commandIds, isCommandId, type CommandId } from './command-catalog.js';
const usageKey = 'openkraken.commandUsage.v1';
const halfLife = 14 * 24 * 60 * 60 * 1000;
type Usage = { weight: number; time: number };
class CommandRegistry {
  buttons = new Map<CommandId, HTMLButtonElement>();
  listeners = new Set<() => void>();
  version = 0;
  usage = new Map<CommandId, Usage>();
  constructor() {
    try {
      const raw = localStorage.getItem(usageKey);
      if (!raw || raw.length > 32768) return;
      const data: unknown = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      for (const [id, value] of Object.entries(data)) {
        if (!isCommandId(id) || !value || typeof value !== 'object') continue;
        if (
          'weight' in value &&
          'time' in value &&
          typeof value.weight === 'number' &&
          Number.isFinite(value.weight) &&
          value.weight >= 0 &&
          value.weight <= 1000 &&
          typeof value.time === 'number' &&
          Number.isFinite(value.time) &&
          value.time >= 0 &&
          value.time <= Date.now() + 300000
        )
          this.usage.set(id, { weight: value.weight, time: value.time });
      }
    } catch {
      /* A damaged usage history does not prevent commands from opening. */
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.version;
  changed = () => {
    this.version++;
    for (const listener of this.listeners) listener();
  };
  register(id: CommandId, button: HTMLButtonElement) {
    this.buttons.set(id, button);
    this.changed();
    return () => {
      if (this.buttons.get(id) === button) {
        this.buttons.delete(id);
        this.changed();
      }
    };
  }
  available(id: CommandId) {
    const button = this.buttons.get(id);
    return !!button?.isConnected && !button.disabled;
  }
  score(id: CommandId) {
    const usage = this.usage.get(id);
    return usage ? usage.weight * 2 ** (-Math.max(0, Date.now() - usage.time) / halfLife) : 0;
  }
  record(id: CommandId) {
    this.usage.set(id, { weight: Math.min(1000, this.score(id) + 1), time: Date.now() });
    try {
      localStorage.setItem(usageKey, JSON.stringify(Object.fromEntries(this.usage)));
    } catch {
      /* Still useful for this session. */
    }
    this.changed();
  }
  execute(id: CommandId) {
    if (document.querySelector('dialog[open]') || !this.available(id)) return false;
    this.buttons.get(id)!.click();
    return true;
  }
}
const Context = createContext<CommandRegistry | null>(null);
function useCommands() {
  const value = useContext(Context);
  if (!value) throw new Error('Command provider missing.');
  return value;
}
export function CommandProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => new CommandRegistry());
  return <Context.Provider value={registry}>{children}</Context.Provider>;
}
export function CommandButton({
  command,
  disabled,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { command: CommandId }) {
  const registry = useCommands();
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (button.current) return registry.register(command, button.current);
  }, [registry, command, disabled]);
  return (
    <button
      {...props}
      ref={button}
      disabled={disabled}
      onClick={(event) => {
        registry.record(command);
        onClick?.(event);
      }}
    />
  );
}
function Palette({ close }: { close: () => void }) {
  const registry = useCommands();
  useSyncExternalStore(registry.subscribe, registry.snapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState('');
  const previous = useRef(document.activeElement);
  useEffect(() => {
    dialog.current?.showModal();
    input.current?.focus();
    return () => {
      if (previous.current instanceof HTMLElement && previous.current.isConnected)
        previous.current.focus();
    };
  }, []);
  const candidates = commandIds
    .filter(
      (id) =>
        id !== 'app.commands' && (category === 'All' || commandCatalog[id].category === category),
    )
    .map((id) => ({ id, ...commandCatalog[id] }));
  const matches = query.trim()
    ? fuzzysort
        .go(query.trim(), candidates, { keys: ['label', 'keywords'], threshold: 0.1, limit: 0 })
        .map((result) => ({ command: result.obj, score: result.score }))
    : candidates.map((command) => ({ command, score: 0 }));
  const results = matches.sort((a, b) => {
    if (query.trim() && Math.floor(a.score * 100) !== Math.floor(b.score * 100))
      return Math.floor(b.score * 100) - Math.floor(a.score * 100);
    return (
      registry.score(b.command.id) - registry.score(a.command.id) ||
      a.command.label.localeCompare(b.command.label)
    );
  });
  const index = Math.max(0, Math.min(active, results.length - 1));
  useEffect(() => {
    dialog.current
      ?.querySelector(`[data-command-index="${index}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [index, query, category]);
  const execute = (id: CommandId) => {
    if (!registry.available(id)) {
      setNotice('This command is unavailable in the current context.');
      return;
    }
    dialog.current?.close();
    if (registry.execute(id)) close();
    else {
      dialog.current?.showModal();
      setNotice('The command is no longer available.');
    }
  };
  return (
    <dialog
      ref={dialog}
      className="command-dialog"
      aria-label="Command palette"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <h2>Command palette</h2>
      <label>
        Search commands
        <input
          ref={input}
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          value={query}
          maxLength={256}
          autoComplete="off"
          aria-controls="command-results"
          aria-activedescendant={
            results[index] ? `command-${results[index]!.command.id}` : undefined
          }
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setNotice('');
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') setActive(Math.min(results.length - 1, index + 1));
            else if (event.key === 'ArrowUp') setActive(Math.max(0, index - 1));
            else if (event.key === 'Home') setActive(0);
            else if (event.key === 'End') setActive(Math.max(0, results.length - 1));
            else if (event.key === 'Enter') {
              if (results[index]) execute(results[index]!.command.id);
            } else return;
            event.preventDefault();
          }}
        />
      </label>
      <label>
        Command category
        <select
          value={category}
          onChange={(event) => {
            setCategory(event.target.value);
            setActive(0);
          }}
        >
          <option>All</option>
          {[...new Set(commandIds.map((id) => commandCatalog[id].category))].map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </label>
      <div role="listbox" aria-label="Commands" id="command-results" className="command-results">
        {results.map(({ command }, i) => (
          <div
            id={`command-${command.id}`}
            key={command.id}
            data-command-index={i}
            role="option"
            aria-label={command.label}
            aria-selected={i === index}
            aria-disabled={!registry.available(command.id)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setActive(i);
              execute(command.id);
            }}
          >
            <strong>{command.label}</strong>
            <span>
              {command.category}
              {!registry.available(command.id) ? ' · Unavailable' : ''}
            </span>
          </div>
        ))}
      </div>
      {!results.length && <p>No commands match.</p>}
      {notice && <p role="status">{notice}</p>}
      <p className="muted">
        Arrow keys choose a command; Enter runs it. Frequently and recently used commands appear
        first when the search is empty.
      </p>
      <button onClick={close}>Close</button>
    </dialog>
  );
}
export function CommandControls() {
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.getModifierState('AltGraph') ||
        document.querySelector('dialog[open]')
      )
        return;
      if (
        event.code === 'KeyP' &&
        !event.shiftKey &&
        !event.altKey &&
        event.ctrlKey !== event.metaKey
      ) {
        event.preventDefault();
        setOpened(true);
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, []);
  return (
    <>
      <CommandButton command="app.commands" onClick={() => setOpened(true)}>
        Commands
      </CommandButton>
      {opened && <Palette close={() => setOpened(false)} />}
    </>
  );
}
