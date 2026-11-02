import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import {
  bindingFor,
  commandCatalog,
  commandIds,
  emptyKeymap,
  EVENT_CHANNEL,
  parseKeymap,
  shortcutStroke,
  type Bindings,
  type CommandId,
} from '@openkraken/ipc-contract';
const punctuation: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};
function accelerator(value: string) {
  const stroke = shortcutStroke(value, process.platform === 'darwin');
  const key = /^(Key|Digit)/.test(stroke.code)
    ? stroke.code.replace(/^(Key|Digit)/, '')
    : (punctuation[stroke.code] ?? stroke.code);
  return [
    stroke.ctrl ? 'Control' : '',
    stroke.alt ? 'Alt' : '',
    stroke.shift ? 'Shift' : '',
    stroke.meta ? 'Super' : '',
    key,
  ]
    .filter(Boolean)
    .join('+');
}
export class CommandMenu {
  private menu: Menu;
  private keymap = '';
  private revision = 0;
  private available = new Set<CommandId>();
  private contextRevision = -1;
  private altGraph = false;
  constructor(private window: BrowserWindow) {
    this.menu = Menu.buildFromTemplate([]);
    this.configure(emptyKeymap, 0);
    window.webContents.on('before-input-event', (_event, input) => {
      if (input.key === 'AltGraph') this.altGraph = input.type === 'keyDown';
      window.webContents.setIgnoreMenuShortcuts(
        input.isAutoRepeat ||
          input.isComposing ||
          this.altGraph ||
          input.modifiers.some((modifier) => /^(altgr|altgraph)$/i.test(modifier)),
      );
    });
    window.webContents.on('did-start-navigation', (details) => {
      if (details.isMainFrame) this.clear();
    });
    window.webContents.on('render-process-gone', () => this.clear());
    window.webContents.on('blur', () => {
      this.altGraph = false;
    });
    window.on('closed', () => this.clear());
  }
  private clear() {
    this.altGraph = false;
    this.available.clear();
    this.contextRevision = -1;
    this.updateEnabled();
  }
  configure(raw: string, revision: number) {
    if (raw === this.keymap && revision === this.revision) return;
    let bindings: Bindings = {};
    try {
      bindings = parseKeymap(raw);
    } catch {
      /* Invalid saved mappings use defaults until repair. */
    }
    this.keymap = raw;
    this.revision = revision;
    const commandItems: MenuItemConstructorOptions[] = [
      ...new Set(commandIds.map((id) => commandCatalog[id].category)),
    ].map((category) => ({
      label: category,
      submenu: commandIds
        .filter((id) => commandCatalog[id].category === category)
        .map((id) => {
          const binding = bindingFor(bindings, id);
          return {
            id: `command.${id}`,
            label: commandCatalog[id].label,
            ...(binding ? { accelerator: accelerator(binding) } : {}),
            enabled: false,
            click: (_item, _window, event) => {
              if (
                this.window.isDestroyed() ||
                !this.available.has(id) ||
                this.contextRevision !== this.revision
              )
                return;
              this.window.webContents.send(EVENT_CHANNEL, {
                type: 'commandExecute',
                command: id,
                revision: this.revision,
                source: event.triggeredByAccelerator ? 'accelerator' : 'menu',
              });
            },
          };
        }),
    }));
    this.menu = Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { label: 'Commands', submenu: commandItems },
      { role: 'editMenu' },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'close' },
          ...(process.platform === 'darwin' ? [] : [{ role: 'quit' as const }]),
        ],
      },
    ]);
    Menu.setApplicationMenu(this.menu);
    this.updateEnabled();
  }
  context(revision: number, available: CommandId[]) {
    this.contextRevision = revision;
    this.available = new Set(available);
    this.updateEnabled();
  }
  private updateEnabled() {
    for (const id of commandIds) {
      const item = this.menu.getMenuItemById(`command.${id}`);
      if (item) item.enabled = this.contextRevision === this.revision && this.available.has(id);
    }
  }
}
