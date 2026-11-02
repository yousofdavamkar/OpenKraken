import { createHash } from 'node:crypto';
import iconv from 'iconv-lite';
import {
  workingFileSchema,
  textEncodingSchema,
  type TextEncoding,
  type WorkingFile,
} from '@openkraken/ipc-contract';
import { FileBackups } from './file-backups.js';
import { decodeText } from './text-encoding.js';
import { GitError, type RunOptions, type runGit } from './runner.js';
type Run = (args: string[], options?: RunOptions) => ReturnType<typeof runGit>;
const MAX_BYTES = 2 * 1024 * 1024;
function checkText(text: string) {
  const lines = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
  if (text.includes('\0') || lines > 50000)
    throw new GitError(
      'EDITOR_LIMIT',
      'The editor supports text without NUL bytes, up to 50,000 lines',
    );
}
export async function readWorkingFile(
  backups: FileBackups,
  run: Run,
  pathBytes: string,
  revision: string,
  signal?: AbortSignal,
) {
  const { image, bytes } = await backups.read(pathBytes, MAX_BYTES, signal);
  if (image.kind !== 'file')
    throw new GitError('EDITOR_UNSUPPORTED', 'The editor requires an existing regular file');
  if (!bytes) throw new GitError('EDITOR_LIMIT', 'The editor supports files up to 2 MiB');
  const fields = (
    await run(['check-attr', '-z', '--stdin', 'working-tree-encoding'], {
      signal,
      stdin: Buffer.concat([Buffer.from(pathBytes, 'base64'), Buffer.from([0])]),
      maxBytes: 128 * 1024,
    })
  ).stdout
    .toString('utf8')
    .split('\0');
  if (fields.length !== 4 || fields[1] !== 'working-tree-encoding')
    throw new GitError('INVALID_ATTRIBUTE', 'Git returned invalid encoding attributes');
  const attribute = fields[2]!;
  const encoding = ['unspecified', 'unset'].includes(attribute)
    ? undefined
    : attributeEncoding(attribute, bytes);
  const decoded = decodeText(bytes, encoding);
  if (!decoded)
    throw new GitError(
      'EDITOR_UNSUPPORTED',
      'The editor could not decode this file as supported text',
    );
  const bom =
    (decoded.encoding === 'UTF-8' &&
      bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) ||
    (decoded.encoding === 'UTF-16LE' && bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (decoded.encoding === 'UTF-16BE' && bytes[0] === 0xfe && bytes[1] === 0xff);
  const text = bom ? decoded.text.replace(/^\ufeff/, '') : decoded.text;
  checkText(text);
  const crlf = text.includes('\r\n'),
    lf = /(?<!\r)\n/.test(text);
  const preview = workingFileSchema.parse({
    path: Buffer.from(pathBytes, 'base64').toString('utf8'),
    pathBytes,
    text,
    encoding: decoded.encoding,
    bom,
    newline: crlf && lf ? 'mixed' : crlf ? 'crlf' : 'lf',
    token: createHash('sha256')
      .update(revision + JSON.stringify(image) + attribute + decoded.encoding)
      .digest('hex'),
  });
  if (!encodeWorkingFile(text, preview).equals(bytes))
    throw new GitError(
      'EDITOR_ENCODING',
      'This encoding cannot round-trip the original bytes safely',
    );
  return { preview, image };
}
export function encodeWorkingFile(text: string, preview: WorkingFile) {
  checkText(text);
  const bytes = iconv.encode(text, preview.encoding, { addBOM: preview.bom });
  if (bytes.length > MAX_BYTES) throw new GitError('EDITOR_LIMIT', 'The saved file exceeds 2 MiB');
  if (iconv.decode(bytes, preview.encoding) !== text)
    throw new GitError('EDITOR_ENCODING', 'The text cannot be saved without losing characters');
  return bytes;
}

function attributeEncoding(value: string, bytes: Buffer): TextEncoding {
  const normalized = value.toUpperCase().replace(/[-_]/g, '');
  if (normalized === 'UTF16') {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'UTF-16LE';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'UTF-16BE';
    throw new GitError(
      'EDITOR_ENCODING',
      'UTF-16 working-tree-encoding requires a byte-order mark',
    );
  }
  const match = textEncodingSchema.options.find(
    (encoding) => encoding.toUpperCase().replace(/[-_]/g, '') === normalized.replace(/BOM$/, ''),
  );
  if (!match) throw new GitError('EDITOR_ENCODING', `Unsupported working-tree-encoding: ${value}`);
  return match;
}
