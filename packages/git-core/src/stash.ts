import { createHash } from 'node:crypto';
import { stashStateSchema, type StashState } from '@openkraken/ipc-contract';
import { GitError, type runGit, type RunOptions } from './runner.js';
export class StashStore {
  constructor(private run: (args: string[], options?: RunOptions) => ReturnType<typeof runGit>) {}
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
