import { z } from 'zod';
export const commandCatalog = {
  'repository.worktrees': {
    label: 'Worktrees',
    category: 'Repository',
    keywords: 'linked checkout folders branches',
  },
  'repository.terminal': {
    label: 'Terminal',
    category: 'Repository',
    keywords: 'shell console command line',
  },
  'app.appearance': {
    label: 'Appearance',
    category: 'Settings',
    keywords: 'theme light dark system colors',
  },
  'app.commands': {
    label: 'Command palette',
    category: 'Settings',
    keywords: 'commands actions fuzzy search',
  },
  'app.keybindings': {
    label: 'Keyboard shortcuts',
    category: 'Settings',
    keywords: 'keymap keybindings customize JSON settings',
  },
  'repository.open': {
    label: 'Open repository',
    category: 'Repository',
    keywords: 'folder browse local',
  },
  'repository.clone': {
    label: 'Clone repository',
    category: 'Repository',
    keywords: 'download remote url',
  },
  'repository.init': {
    label: 'Initialize repository',
    category: 'Repository',
    keywords: 'new git folder init',
  },
  'repository.refresh': {
    label: 'Refresh repository',
    category: 'Repository',
    keywords: 'reload status history',
  },
  'repository.remotes': {
    label: 'Manage remotes',
    category: 'Repository',
    keywords: 'fetch origin remote urls',
  },
  'repository.pull': {
    label: 'Review pull',
    category: 'Repository',
    keywords: 'fetch synchronize upstream merge',
  },
  'repository.push': {
    label: 'Review push',
    category: 'Repository',
    keywords: 'publish upload upstream',
  },
  'references.branch': {
    label: 'Create branch',
    category: 'References',
    keywords: 'new branch selected commit',
  },
  'references.tag': {
    label: 'Create tag',
    category: 'References',
    keywords: 'new annotated signed tag',
  },
  'history.search': {
    label: 'Search commits',
    category: 'History',
    keywords: 'find log commit author message hash',
  },
  'history.integrate': {
    label: 'Integrate commits',
    category: 'History',
    keywords: 'merge rebase cherry pick revert',
  },
  'history.rebase': {
    label: 'Interactive rebase',
    category: 'History',
    keywords: 'reorder squash fixup edit drop',
  },
  'history.reset': {
    label: 'Review reset',
    category: 'History',
    keywords: 'soft mixed hard reset',
  },
  'worktree.stashes': {
    label: 'Manage stashes',
    category: 'Working tree',
    keywords: 'stash save apply pop',
  },
  'worktree.undo': {
    label: 'Undo repository change',
    category: 'Working tree',
    keywords: 'undo restore journal',
  },
  'worktree.redo': {
    label: 'Redo repository change',
    category: 'Working tree',
    keywords: 'redo journal',
  },
  'providers.accounts': {
    label: 'Provider accounts',
    category: 'Integrations',
    keywords: 'github gitlab bitbucket authentication token',
  },
  'providers.pulls': {
    label: 'Browse pull requests',
    category: 'Integrations',
    keywords: 'merge requests review collaboration',
  },
  'providers.issues': {
    label: 'Browse issues',
    category: 'Integrations',
    keywords: 'issue tracker tickets',
  },
} as const;
export type CommandId = keyof typeof commandCatalog;
export const commandIds = Object.keys(commandCatalog) as CommandId[];
export function isCommandId(value: string): value is CommandId {
  return Object.hasOwn(commandCatalog, value);
}

export type Bindings = Partial<Record<CommandId, string | null>>;
export const defaultBindings: Bindings = {
  'app.commands': 'Mod+P',
  'app.keybindings': 'Mod+Alt+K',
  'repository.open': 'Mod+O',
  'repository.refresh': 'F5',
  'history.search': 'Mod+F',
};
export const emptyKeymap = JSON.stringify({ version: 1, bindings: {} }, null, 2);
const modifiers = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'];
const namedKeys = new Set([
  'Comma',
  'Period',
  'Slash',
  'Backslash',
  'BracketLeft',
  'BracketRight',
  'Minus',
  'Equal',
  'Backquote',
]);
export function shortcutStroke(value: string, mac: boolean) {
  const parts = value.split('+');
  const key = parts.pop() ?? '';
  if (
    !key ||
    parts.some((part) => !modifiers.includes(part)) ||
    new Set(parts).size !== parts.length
  )
    throw new Error('Use modifiers Mod, Ctrl, Alt, Shift, Meta followed by one key.');
  if (parts.includes('Mod') && (parts.includes('Ctrl') || parts.includes('Meta')))
    throw new Error('Mod cannot be combined with Ctrl or Meta.');
  const code = /^[A-Z]$/.test(key) ? `Key${key}` : /^\d$/.test(key) ? `Digit${key}` : key;
  if (!/^(Key[A-Z]|Digit\d|F([1-9]|1\d|2[0-4]))$/.test(code) && !namedKeys.has(code))
    throw new Error('Unsupported key. Use a letter, digit, F1–F24, or a named punctuation key.');
  const ctrl = parts.includes('Ctrl') || (parts.includes('Mod') && !mac);
  const meta = parts.includes('Meta') || (parts.includes('Mod') && mac);
  const alt = parts.includes('Alt');
  const shift = parts.includes('Shift');
  if (!/^F\d+$/.test(code) && !ctrl && !meta && !alt)
    throw new Error('Typing keys require a Ctrl, Meta, Mod, or Alt modifier.');
  // Keep editing, window management, reload, and developer tools with their native handlers.
  if (
    ((ctrl || meta) && !alt && /^Key[ACVXZQWRHM]$/.test(code)) ||
    ((ctrl || meta) && shift && /^Key[IJ]$/.test(code)) ||
    (alt && code === 'F4') ||
    code === 'F12'
  )
    throw new Error('This shortcut is reserved for editing or a native application action.');
  return { code, ctrl, meta, alt, shift };
}
function signature(value: string, mac: boolean) {
  return JSON.stringify(shortcutStroke(value, mac));
}
export function bindingFor(bindings: Bindings, id: CommandId) {
  return Object.hasOwn(bindings, id) ? (bindings[id] ?? null) : (defaultBindings[id] ?? null);
}
export function parseKeymap(raw: string): Bindings {
  if (raw.length > 32768) throw new Error('Keymap JSON must be at most 32 KiB.');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('Keymap JSON is not valid JSON.');
  }
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    !('version' in data) ||
    data.version !== 1 ||
    !('bindings' in data) ||
    Object.keys(data).some((key) => key !== 'version' && key !== 'bindings') ||
    !data.bindings ||
    typeof data.bindings !== 'object' ||
    Array.isArray(data.bindings)
  )
    throw new Error('Use an object with version: 1 and a bindings object.');
  const bindings: Bindings = {};
  for (const [id, value] of Object.entries(data.bindings)) {
    if (!isCommandId(id)) throw new Error(`Unknown command: ${id.slice(0, 100)}.`);
    if (value !== null && (typeof value !== 'string' || value.length > 80))
      throw new Error(`Binding for ${id} must be a shortcut string or null.`);
    bindings[id] = value;
  }
  for (const mac of [false, true]) {
    const seen = new Map<string, CommandId>();
    for (const id of commandIds) {
      const value = bindingFor(bindings, id);
      if (value === null) continue;
      const key = signature(value, mac);
      const previous = seen.get(key);
      if (previous)
        throw new Error(
          `Shortcut conflict on ${mac ? 'macOS' : 'Windows/Linux'}: ${previous} and ${id}.`,
        );
      seen.set(key, id);
    }
  }
  return bindings;
}

export const commandIdSchema = z.enum(commandIds);
export const commandUsageSchema = z.partialRecord(
  commandIdSchema,
  z
    .object({
      weight: z.number().finite().min(0).max(1000),
      time: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
);
export type CommandUsage = z.infer<typeof commandUsageSchema>;
export const commandPreferencesSchema = z
  .object({
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    keymap: z.string().max(32768),
    usage: commandUsageSchema,
    initialized: z.boolean(),
    warning: z.enum(['corrupt', 'unreadable']).nullable(),
  })
  .strict();
export type CommandPreferences = z.infer<typeof commandPreferencesSchema>;
