import { analyse } from 'chardet';
import iconv from 'iconv-lite';
import { textEncodingSchema, type TextEncoding } from '@openkraken/ipc-contract';
/** Detection is a display hint, never authority to rewrite a repository file. */
export function decodeText(
  content: Buffer,
  selected?: TextEncoding,
): { text: string; encoding: TextEncoding } | undefined {
  let encoding = selected;
  if (!encoding) {
    if (content[0] === 0xff && content[1] === 0xfe) encoding = 'UTF-16LE';
    else if (content[0] === 0xfe && content[1] === 0xff) encoding = 'UTF-16BE';
    else {
      if (content.includes(0)) return;
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
        if (isText(text)) return { text, encoding: 'UTF-8' };
        return;
      } catch {
        /* Try a bounded legacy-encoding sample. */
      }
      const match = analyse(content.subarray(0, 65536))[0];
      if (!match || match.confidence < 50) return;
      const supported = textEncodingSchema.safeParse(match.name);
      if (!supported.success) return;
      encoding = supported.data;
    }
  }
  if (!iconv.encodingExists(encoding)) return;
  const text = iconv.decode(content, encoding);
  if (text.includes('\ufffd') || !isText(text)) return;
  return { text, encoding };
}
function isText(text: string) {
  // Exclude control data, while permitting common text whitespace and escape
  // sequences as literal text. The renderer never executes those sequences.
  for (let index = 0; index < text.length; index++) {
    const value = text.charCodeAt(index);
    if (value < 32 && ![9, 10, 12, 13, 27].includes(value)) return false;
  }
  return true;
}
