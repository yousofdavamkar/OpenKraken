import { createHash } from 'node:crypto';

type Entry = {
  etag: string;
  body: Buffer<ArrayBuffer>;
  contentType: string | null;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};
const lifetime = 5 * 60 * 1000;
const maximumEntries = 64;
const maximumBytes = 16 * 1024 * 1024;

/** Main-process memory only. A hit still requires an authenticated HTTP 304. */
export class ProviderReadCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;

  key(origin: string, token: string, url: string, headers: Headers) {
    const representation = [...headers].filter(([name]) => name !== 'authorization');
    return createHash('sha256')
      .update(JSON.stringify([origin, token, url, representation]))
      .digest('hex');
  }

  get(key: string) {
    if ((this.entries.get(key)?.expiresAt ?? Infinity) <= Date.now()) this.discard(key);
    return this.entries.get(key);
  }

  clear() {
    for (const key of this.entries.keys()) this.discard(key);
  }

  discard(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.bytes -= entry.body.byteLength;
    this.entries.delete(key);
  }

  storageAllowed(headers: Headers) {
    return (
      !headers
        .get('cache-control')
        ?.split(',')
        .some((directive) => directive.trim().split('=')[0]?.toLowerCase() === 'no-store') &&
      !headers
        .get('vary')
        ?.split(',')
        .some((field) => field.trim() === '*')
    );
  }

  set(key: string, headers: Headers, body: Buffer<ArrayBuffer>) {
    this.discard(key);
    const etag = headers.get('etag');
    const contentType = headers.get('content-type');
    if (
      body.byteLength > maximumBytes ||
      !this.storageAllowed(headers) ||
      !etag ||
      etag.length > 1024 ||
      (contentType?.length ?? 0) > 1024 ||
      !/^(W\/)?"[\x21\x23-\x7e]*"$/.test(etag)
    ) {
      return;
    }
    while (this.entries.size >= maximumEntries || this.bytes + body.byteLength > maximumBytes) {
      this.discard(this.entries.keys().next().value!);
    }
    const timer = setTimeout(() => this.discard(key), lifetime);
    timer.unref();
    this.entries.set(key, {
      etag,
      body,
      contentType,
      expiresAt: Date.now() + lifetime,
      timer,
    });
    this.bytes += body.byteLength;
  }
}
