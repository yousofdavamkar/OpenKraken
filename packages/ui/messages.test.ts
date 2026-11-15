import { expect, test } from 'vitest';
import { messagesFor } from './src/messages.js';

test.each([
  [['es-MX', 'en-US'], 'es', 'Abrir un repositorio'],
  [['en-GB', 'es'], 'en', 'Open a repository'],
  [['bad_tag', 'fr-CA', 'es-ES'], 'es', 'Abrir un repositorio'],
  [['ja-JP'], 'en', 'Open a repository'],
  [[], 'en', 'Open a repository'],
])('selects a bundled welcome catalog for %j', (languages, language, action) => {
  const result = messagesFor(languages as string[]);
  expect(result.language).toBe(language);
  expect(result.messages.openRepository).toBe(action);
});
