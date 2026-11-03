import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  commandUsageSchema,
  appearanceSettingsSchema,
  type AppearanceSettings,
  emptyKeymap,
  parseKeymap,
  type CommandId,
  type CommandPreferences,
  type CommandUsage,
} from '@openkraken/ipc-contract';
const diskSchema = z
  .object({
    version: z.literal(1),
    commands: z
      .object({
        revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        keymap: z.string().max(32768),
        usage: commandUsageSchema,
      })
      .strict()
      .optional(),
    appearance: appearanceSettingsSchema.optional(),
  })
  .strict();
const halfLife = 14 * 24 * 60 * 60 * 1000;
// A legacy keymap may expand to six JSON bytes per UTF-16 code unit.
const maxSettingsBytes = 256 * 1024;
export class AppSettings {
  private appearance: AppearanceSettings = { revision: 0, mode: 'dark' };
  private file: string;
  private source: string | null = null;
  private state: CommandPreferences = {
    revision: 0,
    keymap: emptyKeymap,
    usage: {},
    initialized: false,
    warning: null,
  };
  private ready: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {
    this.file = join(directory, 'settings.json');
    this.ready = this.load();
  }
  private async readSource() {
    try {
      const info = await stat(this.file);
      if (!info.isFile() || info.size > maxSettingsBytes)
        throw new Error('Unsupported settings file.');
      return await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private async load() {
    try {
      this.source = await this.readSource();
      if (this.source === null) return;
      this.state.initialized = true;
      try {
        const disk = diskSchema.parse(JSON.parse(this.source));
        for (const id of Object.keys(disk.commands?.usage ?? {}) as CommandId[])
          if (disk.commands!.usage[id]!.time > Date.now() + 300000) delete disk.commands!.usage[id];
        this.appearance = disk.appearance ?? this.appearance;
        this.state = {
          ...this.state,
          ...disk.commands,
          initialized: !!disk.commands,
          warning: null,
        };
      } catch {
        this.state.warning = 'corrupt';
      }
    } catch {
      this.state = { ...this.state, initialized: true, warning: 'unreadable' };
    }
  }
  private enqueue<T>(work: () => Promise<T>) {
    const next = this.writes
      .catch(() => {})
      .then(async () => {
        await this.ready;
        return work();
      });
    this.writes = next;
    return next;
  }
  async read() {
    await this.ready;
    await this.writes.catch(() => {});
    return structuredClone(this.state);
  }
  async readAppearance() {
    await this.read();
    return { ...this.appearance, warning: this.state.warning };
  }
  saveAppearance(mode: AppearanceSettings['mode'], revision: number) {
    return this.enqueue(async () => {
      if (revision !== this.appearance.revision)
        throw new Error('Appearance changed. Reopen the dialog before saving.');
      const appearance = appearanceSettingsSchema.parse({ mode, revision: revision + 1 });
      await this.persist(this.state, { appearance, repair: true, initializeCommands: false });
      return { ...this.appearance, warning: this.state.warning };
    });
  }
  idle() {
    return this.writes.catch(() => {});
  }
  private async persist(
    next: CommandPreferences,
    { repair = false, appearance = this.appearance, initializeCommands = true } = {},
  ) {
    const initialized = initializeCommands || next.initialized;
    if (this.state.warning === 'unreadable' || (this.state.warning === 'corrupt' && !repair))
      throw new Error('Settings could not be read. Repair the settings before saving changes.');
    if ((await this.readSource()) !== this.source)
      throw new Error('Settings changed on disk. Restart OpenKraken before saving changes.');
    const raw = JSON.stringify(
      diskSchema.parse({
        version: 1,
        commands: initialized
          ? { revision: next.revision, keymap: next.keymap, usage: next.usage }
          : undefined,
        appearance,
      }),
      null,
      2,
    );
    if (Buffer.byteLength(raw, 'utf8') > maxSettingsBytes)
      throw new Error('Settings exceed the supported file size.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.state.warning === 'corrupt' && this.source !== null)
      await writeFile(join(this.directory, `settings.corrupt-${randomUUID()}.json`), this.source, {
        flag: 'wx',
        mode: 0o600,
      });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(raw);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.file);
      this.source = raw;
      this.state = { ...next, initialized, warning: null };
      this.appearance = appearance;
    } finally {
      await rm(temporary, { force: true });
    }
    return structuredClone(this.state);
  }
  migrate(keymap: string, usage: CommandUsage) {
    return this.enqueue(async () => {
      if (this.state.initialized) return structuredClone(this.state);
      // Preserve an invalid legacy keymap for repair; it never becomes an effective binding.
      const clean = commandUsageSchema.parse(usage);
      for (const id of Object.keys(clean) as CommandId[])
        if (clean[id]!.time > Date.now() + 300000) delete clean[id];
      return this.persist({ ...this.state, keymap, usage: clean });
    });
  }
  save(keymap: string, revision: number) {
    return this.enqueue(async () => {
      if (revision !== this.state.revision)
        throw new Error('Keyboard shortcuts changed. Reopen this dialog before saving.');
      const bindings = parseKeymap(keymap);
      return this.persist(
        {
          ...this.state,
          revision: revision + 1,
          keymap: JSON.stringify({ version: 1, bindings }, null, 2),
        },
        { repair: true },
      );
    });
  }
  record(id: CommandId) {
    return this.enqueue(async () => {
      if (this.state.warning) return structuredClone(this.state);
      const now = Date.now();
      const prior = this.state.usage[id];
      const weight =
        prior && prior.time <= now + 300000
          ? prior.weight * 2 ** (-Math.max(0, now - prior.time) / halfLife)
          : 0;
      return this.persist({
        ...this.state,
        usage: { ...this.state.usage, [id]: { weight: Math.min(1000, weight + 1), time: now } },
      });
    });
  }
}
