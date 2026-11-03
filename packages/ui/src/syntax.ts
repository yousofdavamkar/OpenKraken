import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';
export const codeHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: 'var(--syntaxKeyword)' },
    { tag: [tags.string, tags.regexp], color: 'var(--syntaxString)' },
    { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntaxNumber)' },
    { tag: tags.comment, color: 'var(--syntaxComment)', fontStyle: 'italic' },
    { tag: [tags.typeName, tags.function(tags.variableName)], color: 'var(--syntaxType)' },
  ]),
);
export async function languageForPath(path: string) {
  const filename = path.split('/').at(-1) ?? path;
  return (await LanguageDescription.matchFilename(languages, filename)?.load()) ?? [];
}
