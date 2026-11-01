import { createHash } from 'node:crypto';
import {
  stashStateSchema,
  oidSchema,
  type StashActionOptions,
  type StashState,
} from '@openkraken/ipc-contract';
import { GitError, type runGit, type RunOptions } from './runner.js';
export class StashStore {
  constructor(private run: (args: string[], options?: RunOptions) => ReturnType<typeof runGit>) {}
  async selected(options: StashActionOptions, signal?: AbortSignal) {
    const list = await this.list(signal);
    if (
      list.token !== options.token ||
      !list.entries.some(
        (entry) => entry.selector === options.selector && entry.oid === options.oid,
      )
    )
      throw new GitError(
        'STALE_STASH_LIST',
        'The stash list changed. Reload before choosing this action.',
      );
    return list;
  }
  async drop(options: StashActionOptions, signal?: AbortSignal) {
    await this.selected(options, signal);
    await this.run(['stash', 'drop', '--', options.selector], { signal, readOnly: false });
  }
  async rename(options: Extract<StashActionOptions, { action: 'rename' }>, signal?: AbortSignal) {
    const before = await this.selected(options, signal);
    if (
      before.entries.find((entry) => entry.selector === options.selector)?.subject ===
      options.message
    )
      return undefined;
    const metadata = (
      await this.run(['show', '--no-patch', '--format=%T%x00%P', options.oid], { signal })
    ).stdout
      .toString()
      .trim()
      .split('\0');
    const tree = oidSchema.parse(metadata[0]);
    const parents = metadata[1]!.split(' ').map((oid) => oidSchema.parse(oid));
    const copy = async (message: string) =>
      oidSchema.parse(
        (
          await this.run(
            [
              '-c',
              'commit.gpgSign=false',
              'commit-tree',
              tree,
              ...parents.flatMap((oid) => ['-p', oid]),
              '-F',
              '-',
            ],
            { signal, readOnly: false, stdin: message },
          )
        ).stdout
          .toString()
          .trim(),
      );
    let renamed = await copy(options.message + '\n');
    if (renamed === before.entries[0]?.oid) renamed = await copy(options.message + '\n\n');
    await this.run(['stash', 'store', '--message', options.message, renamed], {
      signal,
      readOnly: false,
    });
    const after = await this.list();
    if (
      after.entries.length !== before.entries.length + 1 ||
      after.entries[0]?.oid !== renamed ||
      before.entries.some(
        (entry, i) =>
          after.entries[i + 1]?.oid !== entry.oid ||
          after.entries[i + 1]?.subject !== entry.subject,
      )
    )
      return 'Saved the new message, but kept the old entry because the stash list changed.';
    const selector = `stash@{${Number(options.selector.slice(7, -1)) + 1}}`;
    try {
      await this.drop({ action: 'drop', selector, oid: options.oid, token: after.token }, signal);
    } catch (error) {
      return `Saved the new message, but kept the old entry: ${error instanceof Error ? error.message : String(error)}`;
    }
    return undefined;
  }
  async list(signal?: AbortSignal): Promise<StashState> {
    const result = await this.run(['stash', 'list', '-z', '--format=%H%x00%gd%x00%gs'], {
      signal,
      maxBytes: 2 * 1024 * 1024,
    });
    const fields = result.stdout.toString().split('\0');
    if (fields.at(-1) === '') fields.pop();
    if (fields.length % 3)
      throw new GitError('INVALID_STASH_LIST', 'Git returned an incomplete stash list');
    const entries = [];
    for (let i = 0; i < fields.length; i += 3)
      entries.push({ oid: fields[i], selector: fields[i + 1], subject: fields[i + 2] });
    return stashStateSchema.parse({
      token: createHash('sha256').update(result.stdout).digest('hex'),
      entries,
    });
  }
}
