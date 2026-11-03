import { useSyncExternalStore } from 'react';
import {
  darkColors,
  lightColors,
  type AppearancePreferences,
  type ThemeColors,
} from '@openkraken/ipc-contract';
const media = matchMedia('(prefers-color-scheme: dark)');
let preferences: AppearancePreferences = { revision: 0, mode: 'dark', warning: null };
let current: { scheme: 'dark' | 'light'; colors: ThemeColors } = {
  scheme: 'dark',
  colors: darkColors,
};
const listeners = new Set<() => void>();
function apply() {
  document.documentElement.style.colorScheme = current.scheme;
  for (const [name, color] of Object.entries(current.colors))
    document.documentElement.style.setProperty(`--${name}`, color);
}
function refresh() {
  const scheme =
    preferences.mode === 'system' ? (media.matches ? 'dark' : 'light') : preferences.mode;
  if (scheme === current.scheme) return;
  current = { scheme, colors: scheme === 'dark' ? darkColors : lightColors };
  apply();
  for (const listener of listeners) listener();
}
export function acceptAppearance(state: AppearancePreferences) {
  if (state.revision < preferences.revision) return;
  preferences = state;
  refresh();
}
export const getTheme = () => current;
export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const useTheme = () => useSyncExternalStore(subscribeTheme, getTheme);
apply();
media.addEventListener('change', refresh);
window.openkraken.subscribe((event) => {
  if (event.type === 'appearanceChanged') acceptAppearance(event.state);
});
void window.openkraken
  .request({ id: crypto.randomUUID(), method: 'appearancePreferences' })
  .then((result) => {
    if (result.kind === 'appearancePreferences') acceptAppearance(result.state);
  })
  .catch(() => {
    /* The Appearance dialog provides a retry; the default stays usable. */
  });
