import { commandIds, isCommandId, type CommandId } from './command-catalog.js';

export type Bindings = Partial<Record<CommandId, string | null>>;
export const defaultBindings: Bindings = {
  'app.commands': 'Mod+P',
  'app.keybindings': 'Mod+Alt+K',
  'repository.open': 'Mod+O',
  'repository.refresh': 'F5',
};
export const emptyKeymap = JSON.stringify({ version: 1, bindings: {} }, null, 2);
const storageKey = 'openkraken.keymap.v1';
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
function stroke(value: string, mac: boolean) {
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
    ((ctrl || meta) && !alt && /^Key[ACVXZQWR]$/.test(code)) ||
    ((ctrl || meta) && shift && /^Key[IJ]$/.test(code)) ||
    (alt && code === 'F4') ||
    code === 'F12'
  )
    throw new Error('This shortcut is reserved for editing or a native application action.');
  return { code, ctrl, meta, alt, shift };
}
function signature(value: string, mac: boolean) {
  return JSON.stringify(stroke(value, mac));
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
export function loadKeymap(): { bindings: Bindings; raw: string; error: string } {
  try {
    const raw = localStorage.getItem(storageKey) ?? emptyKeymap;
    try {
      return { bindings: parseKeymap(raw), raw, error: '' };
    } catch {
      return {
        bindings: {},
        raw: raw.slice(0, 32768),
        error:
          'Saved keymap is invalid. Default shortcuts are active; repair the JSON or restore defaults.',
      };
    }
  } catch {
    return {
      bindings: {},
      raw: emptyKeymap,
      error: 'Saved shortcuts could not be read. Default shortcuts are active.',
    };
  }
}
export function saveKeymap(raw: string) {
  const bindings = parseKeymap(raw);
  const formatted = JSON.stringify({ version: 1, bindings }, null, 2);
  localStorage.setItem(storageKey, formatted);
  return { bindings, raw: formatted, error: '' };
}
export function matchesShortcut(event: KeyboardEvent, value: string) {
  const expected = stroke(value, /Mac|iPhone|iPad/.test(navigator.platform));
  return (
    event.code === expected.code &&
    event.ctrlKey === expected.ctrl &&
    event.metaKey === expected.meta &&
    event.altKey === expected.alt &&
    event.shiftKey === expected.shift
  );
}
