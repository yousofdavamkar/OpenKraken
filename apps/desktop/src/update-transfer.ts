import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { UpdateState } from '@openkraken/ipc-contract';
import type { UpdateArtifact } from './update-protocol.js';

export async function syncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

export class UpdateFailure extends Error {
  readonly code: NonNullable<UpdateState['error']>;
  constructor(code: NonNullable<UpdateState['error']>) {
    super(code);
    this.code = code;
  }
}

export async function requestUpdateFile(
  send: typeof fetch,
  url: string,
  signal: AbortSignal,
  expectedSize?: number,
) {
  const response = await send(url, {
    signal,
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: { 'Accept-Encoding': 'identity' },
  });
  if (
    response.status !== 200 ||
    !response.body ||
    ![null, 'identity'].includes(response.headers.get('content-encoding'))
  ) {
    await response.body?.cancel();
    throw new UpdateFailure('network');
  }
  const length = response.headers.get('content-length');
  if (
    expectedSize !== undefined &&
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) !== expectedSize)
  ) {
    await response.body.cancel();
    throw new UpdateFailure('integrity');
  }
  return response.body;
}

export async function readUpdateEnvelope(
  body: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal,
) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    signal.throwIfAborted();
    size += chunk.byteLength;
    if (size > limit) throw new UpdateFailure('invalid-release');
    chunks.push(chunk);
  }
  signal.throwIfAborted();
  return Buffer.concat(chunks).toString('utf8');
}

export async function verifyUpdateArtifact(
  body: AsyncIterable<Uint8Array>,
  artifact: UpdateArtifact,
  signal: AbortSignal,
  onChunk?: (chunk: Uint8Array) => Promise<void> | void,
) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of body) {
    signal.throwIfAborted();
    size += chunk.byteLength;
    if (size > artifact.size) throw new UpdateFailure('integrity');
    if (onChunk) await onChunk(chunk);
    hash.update(chunk);
  }
  signal.throwIfAborted();
  if (size !== artifact.size || hash.digest('hex') !== artifact.sha256)
    throw new UpdateFailure('integrity');
}
