import type { Request, FileEditorDraft } from '@openkraken/ipc-contract';

async function request(
  input: Extract<
    Request,
    { method: 'workingDraftOpen' | 'workingDraftWrite' | 'workingDraftClose' }
  >,
) {
  const result = await window.openkraken.request(input);
  if (result.kind !== 'workingDraft')
    throw new Error(
      result.kind === 'error' ? result.message : 'The local draft was not confirmed.',
    );
  return result.draft;
}

export class WorkingFileDraftSession {
  private session = crypto.randomUUID();
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: () => Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private writeError?: Error;
  async open(repoId: string, pathBytes: string, preview?: true) {
    const draft = await this.openDraft(repoId, pathBytes, preview);
    if (draft && 'editor' in draft) throw new Error('Unexpected conflict draft.');
    return draft;
  }
  async openConflict(repoId: string, pathBytes: string, preview?: true) {
    const draft = await this.openDraft(repoId, pathBytes, preview, 'conflict');
    if (draft && !('editor' in draft)) throw new Error('Unexpected working-file draft.');
    return draft;
  }
  private openDraft(repoId: string, pathBytes: string, preview?: true, editor?: 'conflict') {
    return request({
      id: crypto.randomUUID(),
      method: 'workingDraftOpen',
      editor,
      preview,
      session: this.session,
      repoId,
      pathBytes,
    });
  }
  change(draft: FileEditorDraft | null, notify: (message: string) => void) {
    if (this.closed) return;
    clearTimeout(this.timer);
    const save = async () => {
      try {
        await request({
          id: crypto.randomUUID(),
          method: 'workingDraftWrite',
          session: this.session,
          draft,
        });
        this.writeError = undefined;
        notify(draft ? 'Draft saved locally' : '');
      } catch (error) {
        this.writeError =
          error instanceof Error ? error : new Error('The local draft could not be saved.');
        notify(this.writeError.message);
      }
    };
    this.pending = save;
    if (draft === null) this.flush();
    else this.timer = setTimeout(() => this.flush(), 250);
  }
  private flush() {
    if (this.pending) this.writes = this.writes.then(this.pending);
    this.pending = undefined;
  }
  async close(discard: boolean, requireSaved = false) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    if (discard) this.pending = undefined;
    else {
      this.flush();
      await this.writes;
      if (requireSaved && this.writeError) {
        this.closed = false;
        throw this.writeError;
      }
    }
    // Main serializes already-admitted writes and rejects later writes for a closed session.
    // Admit a confirmed discard before a window close can tear down this renderer.
    try {
      await request({
        id: crypto.randomUUID(),
        method: 'workingDraftClose',
        session: this.session,
        discard,
      });
    } catch (error) {
      this.closed = false;
      throw error;
    }
  }
}
