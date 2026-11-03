import { Compartment } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { getTheme, subscribeTheme } from './theme.js';
export function editorTheme(height: string) {
  const compartment = new Compartment();
  const extension = () =>
    EditorView.theme(
      {
        '&': { height, backgroundColor: 'var(--editorBackground)', color: 'var(--editorText)' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'monospace' },
        '.cm-gutters': {
          backgroundColor: 'var(--editorGutter)',
          color: 'var(--editorMuted)',
          borderColor: 'var(--editorBorder)',
        },
        '.cm-cursor': { borderLeftColor: 'var(--text)' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
          backgroundColor: 'var(--selectedBackground)',
        },
        '.cm-insertedLine': { backgroundColor: 'var(--comparisonAdd)' },
        '.cm-deletedLine': { backgroundColor: 'var(--comparisonDelete)' },
        '.cm-tooltip': {
          backgroundColor: 'var(--surface)',
          color: 'var(--text)',
          borderColor: 'var(--border)',
        },
      },
      { dark: getTheme().scheme === 'dark' },
    );
  return [
    compartment.of(extension()),
    ViewPlugin.define((view) => {
      const unsubscribe = subscribeTheme(() =>
        view.dispatch({ effects: compartment.reconfigure(extension()) }),
      );
      return { destroy: unsubscribe };
    }),
  ];
}
