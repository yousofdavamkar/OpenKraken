import {
  workingFileOptionsSchema,
  workingFileDraftSchema,
  type Repository,
  type WorkingFileDraft,
} from '@openkraken/ipc-contract';
import { LocalDraftFiles } from './local-draft-files.js';

// A window has one working-file editor. Serialize its open, edit and close messages,
// including a native discard admitted while a renderer write is still in flight.
export class WorkingFileDrafts {
  private files;
  private active?: {
    session: string;
    identity: readonly [checkout: string, gitDir: string, pathBytes: string];
    preview: boolean;
    revision: string | null;
  };
  private queue: Promise<void> = Promise.resolve();
  constructor(profile: string) {
    this.files = new LocalDraftFiles(
      profile,
      'working-file-drafts',
      workingFileDraftSchema.extend({
        pathBytes: workingFileOptionsSchema.shape.pathBytes.optional(),
      }),
      13 * 1024 * 1024,
    );
  }
  private run<T>(operation: () => Promise<T>) {
    const next = this.queue.then(operation);
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  open(
    repository: Pick<Repository, 'path' | 'gitDir'>,
    pathBytes: string,
    session: string,
    preview = false,
  ) {
    return this.run(async () => {
      this.active = undefined;
      const identity = [repository.path, repository.gitDir, pathBytes] as const;
      const { draft, revision } = await this.files.read(identity);
      this.active = { session, identity, revision, preview };
      return draft ? { token: draft.token, text: draft.text, newline: draft.newline } : null;
    });
  }
  write(session: string, draft: WorkingFileDraft | null) {
    return this.run(async () => {
      const active = this.active;
      if (active?.session !== session || active.preview) throw new Error('Editor session changed');
      const state = await this.files.save(
        active.identity,
        active.revision,
        draft && { ...draft, pathBytes: active.identity[2] },
      );
      active.revision = state.revision;
    });
  }
  async list(repository: Pick<Repository, 'path' | 'gitDir'>) {
    await this.idle();
    const entries = [];
    let unreadable = false;
    for await (const { name, draft } of this.files.entries()) {
      if (!draft) {
        unreadable = true;
        continue;
      }
      if (
        !draft.pathBytes ||
        LocalDraftFiles.name([repository.path, repository.gitDir, draft.pathBytes]) !== name
      )
        continue;
      entries.push({
        pathBytes: draft.pathBytes,
        path: Buffer.from(draft.pathBytes, 'base64').toString('utf8'),
      });
    }
    return { entries: entries.sort((a, b) => a.path.localeCompare(b.path)), unreadable };
  }
  close(session: string | undefined, discard: boolean) {
    return this.run(async () => {
      const active = this.active;
      if (!active || (session !== undefined && active.session !== session)) return;
      if (discard && (session !== undefined || !active.preview) && active.revision !== null)
        await this.files.save(active.identity, active.revision, null);
      this.active = undefined;
    });
  }
  idle() {
    return this.queue;
  }
}
