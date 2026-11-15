import type { Request, WorkingFileDraft } from '@openkraken/ipc-contract';

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
  open(repoId: string, pathBytes: string) {
    return request({
      id: crypto.randomUUID(),
      method: 'workingDraftOpen',
      session: this.session,
      repoId,
      pathBytes,
    });
  }
  change(draft: WorkingFileDraft | null, notify: (message: string) => void) {
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
        notify(draft ? 'Draft saved locally' : '');
      } catch (error) {
        notify(error instanceof Error ? error.message : 'The local draft could not be saved.');
      }
    };
    this.pending = save;
    this.timer = setTimeout(() => this.flush(), 250);
  }
  private flush() {
    if (this.pending) this.writes = this.writes.then(this.pending);
    this.pending = undefined;
  }
  async close(discard: boolean) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    if (discard) this.pending = undefined;
    else this.flush();
    await this.writes;
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
