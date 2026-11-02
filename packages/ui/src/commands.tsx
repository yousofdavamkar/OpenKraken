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
import { bindingFor, emptyKeymap, parseKeymap } from './keymap.js';
import type { Bindings, CommandPreferences } from '@openkraken/ipc-contract';
const usageKey = 'openkraken.commandUsage.v1';
const halfLife = 14 * 24 * 60 * 60 * 1000;
type Usage = { weight: number; time: number };
class CommandRegistry {
  keymap: { bindings: Bindings; raw: string; error: string } = {
    bindings: {},
    raw: emptyKeymap,
    error: '',
  };
  ready = false;
  nativeReady = false;
  revision = 0;
  private initialization?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  initialize() {
    return (this.initialization ??= this.loadPreferences());
  }
  private accept(state: CommandPreferences) {
    this.revision = state.revision;
    let bindings: Bindings = {};
    let error =
      state.warning === 'unreadable'
        ? 'Saved settings cannot be read. Check the settings file and restart before saving changes.'
        : state.warning
          ? 'Saved settings could not be read. Default shortcuts are active; Apply will preserve a copy of damaged settings before repair.'
          : '';
    try {
      bindings = parseKeymap(state.keymap);
    } catch {
      error =
        'Saved keymap is invalid. Default shortcuts are active; repair the JSON or restore defaults.';
    }
    this.keymap = { bindings, raw: state.keymap, error };
    this.usage = new Map(Object.entries(state.usage) as [CommandId, Usage][]);
    this.changed();
  }
  private async loadPreferences() {
    try {
      let result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'commandPreferences',
      });
      if (result.kind !== 'commandPreferences')
        throw new Error('Command settings could not be read.');
      if (!result.state.initialized) {
        let raw = emptyKeymap;
        try {
          raw = localStorage.getItem('openkraken.keymap.v1')?.slice(0, 32768) ?? raw;
        } catch {
          /* Defaults remain available. */
        }
        result = await window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'commandPreferencesMigrate',
          keymap: raw,
          usage: Object.fromEntries(this.usage),
        });
        if (result.kind !== 'commandPreferences')
          throw new Error('Command settings could not be migrated.');
        try {
          localStorage.removeItem('openkraken.keymap.v1');
          localStorage.removeItem(usageKey);
        } catch {
          /* Main settings remain authoritative. */
        }
      }
      this.accept(result.state);
    } catch {
      this.keymap.error =
        'Command settings could not be loaded. Default shortcuts are active; restart to retry.';
    } finally {
      this.ready = true;
      this.changed();
    }
  }
  connectNative() {
    let alive = true;
    let inFlight = false;
    let sent = '';
    let retry: ReturnType<typeof setTimeout> | undefined;
    const context = () => ({
      revision: this.revision,
      available:
        this.ready && !document.querySelector('dialog[open]')
          ? commandIds.filter(
              (id) =>
                this.available(id) ||
                ((id === 'app.commands' || id === 'app.keybindings') &&
                  this.buttons.get(id)?.isConnected),
            )
          : [],
    });
    const sync = async () => {
      if (!alive || !this.ready || inFlight) return;
      const state = context();
      const serialized = JSON.stringify(state);
      if (serialized === sent) return;
      inFlight = true;
      try {
        const result = await window.openkraken.request({
          id: crypto.randomUUID(),
          method: 'commandContext',
          ...state,
        });
        if (result.kind !== 'commandContext') throw new Error('Menu context unavailable.');
        sent = serialized;
        if (alive && !this.nativeReady) {
          this.nativeReady = true;
          this.changed();
        }
      } catch {
        if (alive)
          retry = setTimeout(() => {
            void sync();
          }, 250);
        return;
      } finally {
        inFlight = false;
      }
      if (alive && JSON.stringify(context()) !== sent) void sync();
    };
    const schedule = () =>
      queueMicrotask(() => {
        void sync();
      });
    const unsubscribe = this.subscribe(schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open', 'disabled'],
    });
    const unsubscribeEvents = window.openkraken.subscribe((event) => {
      if (event.type !== 'commandExecute' || event.revision !== this.revision) return;
      const target = document.activeElement;
      const typing =
        target instanceof Element &&
        !!target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor, .xterm',
        );
      if (
        event.source === 'accelerator' &&
        typing &&
        event.command !== 'app.commands' &&
        event.command !== 'history.search'
      )
        return;
      this.execute(event.command);
    });
    schedule();
    return () => {
      alive = false;
      clearTimeout(retry);
      observer.disconnect();
      unsubscribe();
      unsubscribeEvents();
    };
  }
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
  shortcut(id: CommandId) {
    return bindingFor(this.keymap.bindings, id);
  }
  async refresh() {
    await this.writes;
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'commandPreferences',
      });
      if (result.kind !== 'commandPreferences') throw new Error('Settings unavailable.');
      this.accept(result.state);
    } catch {
      this.keymap.error = 'Command settings could not be read. Restart to retry.';
      this.changed();
    }
  }
  async saveBindings(raw: string) {
    parseKeymap(raw);
    await this.writes;
    const result = await window.openkraken.request({
      id: crypto.randomUUID(),
      method: 'commandKeymapSave',
      keymap: raw,
      revision: this.revision,
    });
    if (result.kind !== 'commandPreferences')
      throw new Error(
        result.kind === 'error' ? result.message : 'Command settings could not be saved.',
      );
    this.accept(result.state);
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
    if (this.ready) {
      this.writes = this.writes
        .catch(() => {})
        .then(async () => {
          const result = await window.openkraken.request({
            id: crypto.randomUUID(),
            method: 'commandInvoked',
            command: id,
          });
          if (result.kind === 'error') throw new Error(result.message);
        })
        .catch(() => {
          this.keymap.error =
            'Command usage could not be saved. This session still keeps its usage history.';
          this.changed();
        });
    }
    this.changed();
  }
  execute(id: CommandId) {
    if (!this.ready || document.querySelector('dialog[open]') || !this.available(id)) return false;
    const button = this.buttons.get(id)!;
    button.focus();
    button.click();
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
  useEffect(() => {
    const disconnect = registry.connectNative();
    void registry.initialize();
    return disconnect;
  }, [registry]);
  return <Context.Provider value={registry}>{children}</Context.Provider>;
}
export function CommandButton({
  command,
  disabled,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { command: CommandId }) {
  const registry = useCommands();
  useSyncExternalStore(registry.subscribe, registry.snapshot);
  const button = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (button.current) return registry.register(command, button.current);
  }, [registry, command, disabled]);
  return (
    <button
      {...props}
      ref={button}
      disabled={
        disabled ||
        ((!registry.ready || !registry.nativeReady) &&
          (command === 'app.commands' || command === 'app.keybindings'))
      }
      title={props.title ?? registry.shortcut(command) ?? undefined}
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
  const restoreFocus = useRef(true);
  useEffect(() => {
    dialog.current?.showModal();
    input.current?.focus();
    return () => {
      if (
        restoreFocus.current &&
        previous.current instanceof HTMLElement &&
        previous.current.isConnected
      )
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
    restoreFocus.current = false;
    if (registry.execute(id)) close();
    else {
      restoreFocus.current = true;
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
            if (event.nativeEvent.isComposing || (event.key === 'Enter' && event.repeat)) return;
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
              {registry.shortcut(command.id) ? ` · ${registry.shortcut(command.id)}` : ''}
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
function KeymapEditor({ close }: { close: () => void }) {
  const registry = useCommands();
  useSyncExternalStore(registry.subscribe, registry.snapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const previous = useRef(document.activeElement);
  const [draft, setDraft] = useState(registry.keymap.raw);
  const [error, setError] = useState(registry.keymap.error);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    input.current?.focus();
    return () => {
      if (previous.current instanceof HTMLElement && previous.current.isConnected)
        previous.current.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="command-dialog"
      aria-label="Keyboard shortcuts"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <h2>Keyboard shortcuts</h2>
      <p>
        Map command IDs to shortcuts. Mod means Command on macOS and Control elsewhere. Missing
        entries inherit defaults; null disables a shortcut. Conflicts are checked on both platforms.
      </p>
      <p>
        Use native shortcut keys: letters A–Z, digits, F1–F24, or named punctuation (for example
        Comma). Shortcuts pause in dialogs. Other action shortcuts also pause while editing text.
      </p>
      <label>
        Keymap JSON
        <textarea
          ref={input}
          value={draft}
          maxLength={32768}
          rows={12}
          disabled={saving}
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value);
            setError('');
            setNotice('');
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          try {
            await registry.saveBindings(draft);
            setDraft(registry.keymap.raw);
            setError('');
            setNotice('Keyboard shortcuts saved.');
          } catch (reason) {
            setError(
              reason instanceof Error ? reason.message : 'Keyboard shortcuts could not be saved.',
            );
            setNotice('');
          } finally {
            setSaving(false);
          }
        }}
      >
        Apply
      </button>
      <button
        disabled={saving}
        onClick={() => {
          setDraft(emptyKeymap);
          setError('');
          setNotice('Apply to restore the default shortcuts.');
        }}
      >
        Restore defaults
      </button>
      <button onClick={close}>Close</button>
      <table>
        <caption>Active shortcuts</caption>
        <thead>
          <tr>
            <th>Command</th>
            <th>ID</th>
            <th>Shortcut</th>
          </tr>
        </thead>
        <tbody>
          {commandIds.map((id) => (
            <tr key={id}>
              <td>{commandCatalog[id].label}</td>
              <td>
                <code>{id}</code>
              </td>
              <td>{registry.shortcut(id) ?? 'Unbound'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </dialog>
  );
}
export function CommandControls() {
  const registry = useCommands();
  const [opened, setOpened] = useState(false);
  const [editing, setEditing] = useState(false);
  return (
    <>
      <CommandButton command="app.commands" onClick={() => setOpened(true)}>
        Commands
      </CommandButton>
      <CommandButton
        command="app.keybindings"
        onClick={async () => {
          await registry.refresh();
          if (!document.querySelector('dialog[open]')) setEditing(true);
        }}
      >
        Keybindings
      </CommandButton>
      {opened && <Palette close={() => setOpened(false)} />}
      {editing && <KeymapEditor close={() => setEditing(false)} />}
    </>
  );
}
