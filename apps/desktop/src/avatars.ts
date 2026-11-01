import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RepositoryQueue } from '@openkraken/git-core';
const DAY = 86400000;
interface Entry {
  fetchedAt: number;
  image: string | null;
  retryAfter?: number;
}
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
export function avatarHash(email: string) {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex');
}
function validPng(data: Buffer) {
  return (
    data.length >= 24 &&
    data.length <= 65536 &&
    data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    data.readUInt32BE(16) > 0 &&
    data.readUInt32BE(16) <= 128 &&
    data.readUInt32BE(20) > 0 &&
    data.readUInt32BE(20) <= 128
  );
}
async function atomicJson(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
/** Opt-in, bounded profile cache. Only hashes, normalized PNGs and timestamps reach disk. */
export class AvatarCache {
  private enabled = false;
  private ready: Promise<void>;
  private writes = Promise.resolve();
  private pool = new RepositoryQueue(4);
  private pending = new Map<string, Promise<string | null>>();
  private controllers = new Set<AbortController>();
  private memory = new Map<string, Entry>();
  constructor(
    private directory: string,
    private fetchImage: (hash: string, signal: AbortSignal) => Promise<Buffer | null>,
    private now = Date.now,
    private limit = 256,
  ) {
    this.ready = this.initialize();
  }
  private async initialize() {
    await mkdir(join(this.directory, 'avatars'), { recursive: true, mode: 0o700 });
    try {
      const value: unknown = JSON.parse(
        await readFile(join(this.directory, 'appearance.json'), 'utf8'),
      );
      this.enabled =
        !!value &&
        typeof value === 'object' &&
        'remoteAvatars' in value &&
        value.remoteAvatars === true;
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
    }
    await this.trim();
  }
  async appearance(remoteAvatars?: boolean) {
    await this.ready;
    if (remoteAvatars !== undefined) {
      this.writes = this.writes
        .catch(() => {})
        .then(async () => {
          await atomicJson(join(this.directory, 'appearance.json'), { remoteAvatars });
          this.enabled = remoteAvatars;
          if (!remoteAvatars) {
            for (const controller of this.controllers) controller.abort();
            this.memory.clear();
          }
        });
    }
    await this.writes;
    return this.enabled;
  }
  private async trim() {
    const directory = join(this.directory, 'avatars');
    const files = (await readdir(directory)).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
    if (files.length <= this.limit) return;
    const dated = await Promise.all(
      files.map(async (name) => ({
        name,
        time: await stat(join(directory, name))
          .then((s) => s.mtimeMs)
          .catch(() => 0),
      })),
    );
    dated.sort((a, b) => a.time - b.time);
    await Promise.all(
      dated
        .slice(0, files.length - this.limit)
        .map((f) => rm(join(directory, f.name), { force: true })),
    );
  }
  private remember(hash: string, entry: Entry) {
    this.memory.delete(hash);
    this.memory.set(hash, entry);
    while (this.memory.size > this.limit) this.memory.delete(this.memory.keys().next().value!);
  }
  private async load(hash: string): Promise<string | null> {
    if (!this.enabled) return null;
    const path = join(this.directory, 'avatars', `${hash}.json`);
    let entry = this.memory.get(hash);
    if (!entry)
      try {
        if ((await stat(path)).size < 100000) {
          const value = JSON.parse(await readFile(path, 'utf8')) as Entry;
          if (
            Number.isFinite(value.fetchedAt) &&
            (value.image === null ||
              (typeof value.image === 'string' &&
                value.image.startsWith('data:image/png;base64,') &&
                validPng(Buffer.from(value.image.slice(22), 'base64'))))
          )
            entry = value;
        }
      } catch {
        /* Missing/damaged cache entries fall back to the provider or initials. */
      }
    const now = this.now();
    if (
      entry &&
      (entry.fetchedAt + (entry.image ? 7 * DAY : DAY) > now || (entry.retryAfter ?? 0) > now)
    ) {
      this.remember(hash, entry);
      return entry.image;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const data = await this.fetchImage(hash, controller.signal);
      if (!this.enabled || controller.signal.aborted) return null;
      if (data && !validPng(data)) throw new Error('Invalid avatar image');
      const fresh = {
        fetchedAt: now,
        image: data ? `data:image/png;base64,${data.toString('base64')}` : null,
      };
      await atomicJson(path, fresh);
      this.remember(hash, fresh);
      await this.trim();
      return fresh.image;
    } catch {
      if (!this.enabled || controller.signal.aborted) return null;
      const fallback = {
        fetchedAt: 0,
        ...entry,
        image: entry?.image ?? null,
        retryAfter: now + 60000,
      };
      this.remember(hash, fallback);
      return fallback.image;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }
  async images(emails: string[]) {
    await this.ready;
    const unique = [...new Set(emails.map(normalizeEmail))];
    return Object.fromEntries(
      await Promise.all(
        unique.map(async (email) => {
          if (!this.enabled || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return [email, null];
          const hash = avatarHash(email);
          let pending = this.pending.get(hash);
          if (!pending) {
            pending = this.pool
              .run(false, () => this.load(hash))
              .finally(() => this.pending.delete(hash));
            this.pending.set(hash, pending);
          }
          return [email, await pending];
        }),
      ),
    );
  }
  close() {
    this.enabled = false;
    for (const controller of this.controllers) controller.abort();
  }
}
