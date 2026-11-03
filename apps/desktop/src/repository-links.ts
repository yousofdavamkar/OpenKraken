import { randomUUID } from 'node:crypto';

/** Parse before URL normalization: dot segments and duplicate fields must remain rejectable. */
function repositoryPath(raw: string, platform: NodeJS.Platform): string | null {
  if (raw.length > 65536) return null;
  const match = /^openkraken:\/\/repo\?path=([^&#]+)$/.exec(raw);
  if (!match) return null;
  let path: string;
  try {
    path = decodeURIComponent(match[1]!.replaceAll('+', ' '));
  } catch {
    return null;
  }
  if (
    path.length > 16384 ||
    /[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(path) ||
    /%[a-f0-9]{2}/i.test(path)
  )
    return null;
  let segments: string[];
  if (platform === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(path) || /[:<>"|?*]/.test(path.slice(2))) return null;
    segments = path.slice(3).split(/[\\/]/);
    if (
      segments.some(
        (part) =>
          /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
      )
    )
      return null;
  } else {
    if (!path.startsWith('/') || path.includes('\\')) return null;
    segments = path.slice(1).split('/');
  }
  if (segments.at(-1) === '') segments.pop();
  if (segments.some((part) => !part || part === '.' || part === '..')) return null;
  return path;
}

/** One in-memory proposal. External links never perform Git or filesystem work themselves. */
export class RepositoryLinks {
  private pending: { id: string; path: string } | null = null;
  constructor(
    private platform: NodeJS.Platform,
    private changed: () => void,
  ) {}
  receive(raw: string): boolean {
    if (this.pending) return false;
    const path = repositoryPath(raw, this.platform);
    if (path === null) return false;
    this.pending = { id: randomUUID(), path };
    this.changed();
    return true;
  }
  read() {
    return this.pending ? { ...this.pending } : null;
  }
  accept(id: string): string {
    if (!this.pending || this.pending.id !== id)
      throw new Error('This repository link is no longer available.');
    const path = this.pending.path;
    this.pending = null;
    this.changed();
    return path;
  }
  dismiss(id: string) {
    if (this.pending?.id !== id) return;
    this.pending = null;
    this.changed();
  }
}
