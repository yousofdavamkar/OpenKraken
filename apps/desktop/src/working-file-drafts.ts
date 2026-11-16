import {
  conflictDraftSchema,
  workingFileOptionsSchema,
  workingFileDraftSchema,
  type Repository,
  type FileEditorDraft,
} from '@openkraken/ipc-contract';
import { LocalDraftFiles } from './local-draft-files.js';

type StoredDraft = FileEditorDraft & { pathBytes?: string };
type DraftFiles = LocalDraftFiles<StoredDraft>;

// A window has one active file or conflict editor. Serialize its open, edit and close messages,
// including a native discard admitted while a renderer write is still in flight.
export class WorkingFileDrafts {
  private files: DraftFiles;
  private conflicts: DraftFiles;
  private active?: {
    session: string;
    identity: readonly string[];
    pathBytes: string;
    files: DraftFiles;
    preview: boolean;
    revision: string | null;
  };
  private queue: Promise<void> = Promise.resolve();
  constructor(profile: string) {
    const path = { pathBytes: workingFileOptionsSchema.shape.pathBytes.optional() };
    this.files = new LocalDraftFiles<StoredDraft>(
      profile,
      'working-file-drafts',
      workingFileDraftSchema.extend(path),
      13 * 1024 * 1024,
    );
    this.conflicts = new LocalDraftFiles<StoredDraft>(
      profile,
      'conflict-drafts',
      conflictDraftSchema.extend(path),
      40 * 1024 * 1024,
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
    editor?: 'conflict',
  ) {
    return this.run(async () => {
      this.active = undefined;
      const identity = [repository.path, repository.gitDir, pathBytes];
      const files = editor === 'conflict' ? this.conflicts : this.files;
      const { draft, revision } = await files.read(identity);
      this.active = { session, identity, revision, preview, files, pathBytes };
      if (!draft) return null;
      const { pathBytes: _path, ...contents } = draft;
      return contents;
    });
  }
  write(session: string, draft: FileEditorDraft | null) {
    return this.run(async () => {
      const active = this.active;
      if (active?.session !== session || active.preview) throw new Error('Editor session changed');
      const state = await active.files.save(
        active.identity,
        active.revision,
        draft && { ...draft, pathBytes: active.pathBytes },
      );
      active.revision = state.revision;
    });
  }
  async list(repository: Pick<Repository, 'path' | 'gitDir'>) {
    await this.idle();
    const entries = [];
    let unreadable = false;
    for (const files of [this.files, this.conflicts]) {
      for await (const { name, draft } of files.entries()) {
        if (!draft) {
          unreadable = true;
          continue;
        }
        if (!draft.pathBytes) continue;
        const identity = [repository.path, repository.gitDir, draft.pathBytes];
        if (LocalDraftFiles.name(identity) !== name) continue;
        entries.push({
          ...('editor' in draft ? { editor: draft.editor } : {}),
          pathBytes: draft.pathBytes,
          path: Buffer.from(draft.pathBytes, 'base64').toString('utf8'),
        });
      }
    }
    return { entries: entries.sort((a, b) => a.path.localeCompare(b.path)), unreadable };
  }
  close(session: string | undefined, discard: boolean) {
    return this.run(async () => {
      const active = this.active;
      if (!active || (session !== undefined && active.session !== session)) return;
      if (discard && (session !== undefined || !active.preview) && active.revision !== null)
        await active.files.save(active.identity, active.revision, null);
      this.active = undefined;
    });
  }
  idle() {
    return this.queue;
  }
}
