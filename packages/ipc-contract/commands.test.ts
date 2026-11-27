import { expect, test } from 'vitest';
import {
  bindingFor,
  defaultBindings,
  emptyKeymap,
  parseKeymap,
  shortcutStroke,
} from './src/commands.js';

test('Tab shortcuts need Ctrl or Meta and never Alt', () => {
  expect(shortcutStroke('Ctrl+Tab', false)).toMatchObject({ code: 'Tab', ctrl: true });
  expect(shortcutStroke('Ctrl+Shift+Tab', true)).toMatchObject({ code: 'Tab', shift: true });
  expect(shortcutStroke('Meta+Tab', true)).toMatchObject({ code: 'Tab', meta: true });
  expect(() => shortcutStroke('Tab', false)).toThrow(/modifier/);
  expect(() => shortcutStroke('Shift+Tab', false)).toThrow(/modifier/);
  expect(() => shortcutStroke('Alt+Tab', false)).toThrow(/reserved/);
  expect(() => shortcutStroke('Ctrl+Alt+Tab', false)).toThrow(/reserved/);
});

test('default tab shortcuts are valid on both platforms and avoid the native close', () => {
  expect(parseKeymap(emptyKeymap)).toEqual({});
  for (const mac of [false, true])
    for (const value of Object.values(defaultBindings))
      expect(() => shortcutStroke(value!, mac)).not.toThrow();
  expect(bindingFor({}, 'tabs.close')).toBe('Ctrl+F4');
  expect(() => shortcutStroke('Mod+W', false)).toThrow(/reserved/);
  // Reassigning a default to another tab command is reported as a conflict.
  expect(() =>
    parseKeymap(JSON.stringify({ version: 1, bindings: { 'tabs.reopen': 'Ctrl+Tab' } })),
  ).toThrow(/conflict/);
});
