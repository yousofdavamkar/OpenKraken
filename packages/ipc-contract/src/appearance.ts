import { z } from 'zod';
import { darkColors, lightColors, type ThemeColor, type ThemeColors } from './theme-colors.js';
export const themeColorNames = Object.keys(darkColors) as ThemeColor[];
export const userThemeSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(80),
    base: z.enum(['dark', 'light']),
    colors: z.partialRecord(
      z.enum(themeColorNames),
      z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/),
    ),
  })
  .strict();
export type UserTheme = z.infer<typeof userThemeSchema>;
export function parseUserTheme(raw: string): UserTheme {
  if (raw.length > 32768) throw new Error('Custom theme JSON must be at most 32,768 characters.');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Enter valid JSON for the custom theme.');
  }
  const parsed = userThemeSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      'Use version 1, a name, a light/dark base, and known color tokens with hex values.',
    );
  return parsed.data;
}
export const appearanceModeSchema = z.enum(['dark', 'light', 'system', 'custom']);
const settings = z
  .object({
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    mode: appearanceModeSchema,
    custom: userThemeSchema.nullable().default(null),
  })
  .strict();
const hasCustom = (value: z.infer<typeof settings>) =>
  value.mode !== 'custom' || value.custom !== null;
export const appearanceSettingsSchema = settings.refine(hasCustom, 'Custom mode requires a theme.');
export const appearancePreferencesSchema = settings
  .extend({
    warning: z.enum(['corrupt', 'unreadable']).nullable(),
  })
  .refine(hasCustom, 'Custom mode requires a theme.');
export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>;
export type AppearancePreferences = z.infer<typeof appearancePreferencesSchema>;
export function nativeAppearanceMode(value: AppearanceSettings) {
  return value.mode === 'custom' ? (value.custom?.base ?? 'dark') : value.mode;
}
export function resolveAppearance(
  value: AppearanceSettings,
  systemDark: boolean,
): { scheme: 'light' | 'dark'; colors: ThemeColors } {
  const mode = nativeAppearanceMode(value);
  const scheme = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
  const base = scheme === 'dark' ? darkColors : lightColors;
  return {
    scheme,
    colors: value.mode === 'custom' && value.custom ? { ...base, ...value.custom.colors } : base,
  };
}
