import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';
export const codeHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: '#c792ea' },
    { tag: [tags.string, tags.regexp], color: '#c3e88d' },
    { tag: [tags.number, tags.bool, tags.null], color: '#f78c6c' },
    { tag: tags.comment, color: '#a4b2c1', fontStyle: 'italic' },
    { tag: [tags.typeName, tags.function(tags.variableName)], color: '#82aaff' },
  ]),
);
export async function languageForPath(path: string) {
  const filename = path.split('/').at(-1) ?? path;
  return (await LanguageDescription.matchFilename(languages, filename)?.load()) ?? [];
}
