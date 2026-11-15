import {
  workingFileDraftSchema,
  type Repository,
  type WorkingFileDraft,
} from '@openkraken/ipc-contract';
import { LocalDraftFiles } from './local-draft-files.js';

// A window has one working-file editor. Serialize its open, edit and close messages,
// including a native discard admitted while a renderer write is still in flight.
export class WorkingFileDrafts {
  private files;
  private active?: { session: string; identity: string[]; revision: string | null };
  private queue: Promise<void> = Promise.resolve();
  constructor(profile: string) {
    this.files = new LocalDraftFiles(
      profile,
      'working-file-drafts',
      workingFileDraftSchema,
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
  open(repository: Repository, pathBytes: string, session: string) {
    return this.run(async () => {
      this.active = undefined;
      const identity = [repository.path, repository.gitDir, pathBytes];
      const { draft, revision } = await this.files.read(identity);
      this.active = { session, identity, revision };
      return draft;
    });
  }
  write(session: string, draft: WorkingFileDraft | null) {
    return this.run(async () => {
      const active = this.active;
      if (active?.session !== session) throw new Error('Editor session changed');
      const state = await this.files.save(active.identity, active.revision, draft);
      active.revision = state.revision;
    });
  }
  close(session: string | undefined, discard: boolean) {
    return this.run(async () => {
      const active = this.active;
      if (!active || (session !== undefined && active.session !== session)) return;
      if (discard && active.revision !== null)
        await this.files.save(active.identity, active.revision, null);
      this.active = undefined;
    });
  }
  idle() {
    return this.queue;
  }
}
