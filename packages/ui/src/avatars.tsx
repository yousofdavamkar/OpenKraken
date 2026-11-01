import { useEffect } from 'react';
import { create } from 'zustand';
interface AvatarState {
  enabled: boolean;
  ready: boolean;
  saving: boolean;
  error?: string;
  images: Record<string, string | null>;
  appearance: (enabled?: boolean) => Promise<void>;
  load: (emails: string[]) => Promise<void>;
}
const normalize = (email: string) => email.trim().toLowerCase();
let generation = 0;
const pending = new Set<string>();
export const useAvatars = create<AvatarState>((set, get) => ({
  enabled: false,
  ready: false,
  saving: false,
  images: {},
  appearance: async (enabled) => {
    if (get().saving) return;
    set({ saving: true, error: undefined });
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'appearance',
        remoteAvatars: enabled,
      });
      if (result.kind === 'error') throw new Error(result.message);
      if (result.kind === 'appearance') {
        generation++;
        pending.clear();
        set({ enabled: result.remoteAvatars, ready: true, images: {} });
      }
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ saving: false });
    }
  },
  load: async (input) => {
    if (!get().enabled) return;
    const emails = [...new Set(input.map(normalize))]
      .filter((e) => e && !(e in get().images) && !pending.has(e))
      .slice(0, 100);
    if (!emails.length) return;
    const current = generation;
    emails.forEach((e) => pending.add(e));
    try {
      const result = await window.openkraken.request({
        id: crypto.randomUUID(),
        method: 'avatars',
        emails,
      });
      if (current === generation && result.kind === 'avatars')
        set((state) => ({ images: { ...state.images, ...result.images } }));
    } catch {
      /* Keep local initials when IPC or the provider is unavailable. */
    } finally {
      if (current === generation) emails.forEach((e) => pending.delete(e));
    }
  },
}));
export function AvatarSettings() {
  const { enabled, ready, saving, error, appearance } = useAvatars();
  useEffect(() => {
    void appearance();
  }, [appearance]);
  return (
    <label
      className="avatar-setting"
      title={
        error ??
        'When enabled, hashed author email addresses are sent to Gravatar. Photos are cached locally.'
      }
    >
      <input
        type="checkbox"
        checked={enabled}
        disabled={!ready || saving}
        onChange={(e) => void appearance(e.target.checked)}
      />{' '}
      Author photos
      {error && <span role="status">Could not save setting</span>}
    </label>
  );
}
export function AuthorAvatar({ name, email }: { name: string; email: string }) {
  const image = useAvatars((state) => (state.enabled ? state.images[normalize(email)] : undefined));
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => Array.from(part)[0] ?? '')
      .join('')
      .toUpperCase() || '?';
  return image ? (
    <img
      className="author-avatar"
      src={image}
      alt=""
      width={18}
      height={18}
      onError={() =>
        useAvatars.setState((state) => ({ images: { ...state.images, [normalize(email)]: null } }))
      }
    />
  ) : (
    <span className="author-avatar initials" aria-hidden="true">
      {initials}
    </span>
  );
}
export function useVisibleAvatars(emails: string[]) {
  const enabled = useAvatars((s) => s.enabled),
    load = useAvatars((s) => s.load);
  const key = [...new Set(emails)].sort().join('\n');
  useEffect(() => {
    if (enabled) void load(key.split('\n'));
  }, [key, enabled, load]);
}
