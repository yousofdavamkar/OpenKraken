import { z } from 'zod';
export const appearanceModeSchema = z.enum(['dark', 'light', 'system']);
export const appearanceSettingsSchema = z
  .object({
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    mode: appearanceModeSchema,
  })
  .strict();
export const appearancePreferencesSchema = appearanceSettingsSchema.extend({
  warning: z.enum(['corrupt', 'unreadable']).nullable(),
});
export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>;
export type AppearancePreferences = z.infer<typeof appearancePreferencesSchema>;
