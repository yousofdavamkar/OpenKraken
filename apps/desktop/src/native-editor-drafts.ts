import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import {
  editorTextSchema,
  nativeDraftEntrySchema,
  type NativeDraftEntry,
  type Repository,
} from '@openkraken/ipc-contract';
import { z } from 'zod';
import { LocalDraftFiles } from './local-draft-files.js';

const diskSchema = nativeDraftEntrySchema.extend({
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  text: editorTextSchema,
});
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
type Checkout = Pick<Repository, 'id' | 'path' | 'gitDir'>;
type Prompt = {
  checkout: Checkout;
  requestId: string;
  promptId: string;
  path: string;
  sourceDigest: string;
  revision: string | null;
  savedDigest?: string;
  state: 'editing' | 'submitted' | 'interrupted' | 'dismissing';
};
const identity = (checkout: Checkout, promptId: string) => [
  checkout.path,
  checkout.gitDir,
  promptId,
];

export class NativeEditorDrafts {
  private files;
  private prompts = new Map<string, Prompt>();
  private writes: Promise<void> = Promise.resolve();
  constructor(profile: string) {
    this.files = new LocalDraftFiles(profile, 'native-editor-drafts', diskSchema, 7 * 1024 * 1024);
  }
  register(
    checkout: Checkout,
    requestId: string,
    promptId: string,
    document: string,
    text: string,
  ) {
    const path = relative(checkout.gitDir, document);
    if (
      !isAbsolute(document) ||
      !path ||
      path === '..' ||
      path.startsWith('..' + sep) ||
      isAbsolute(path) ||
      this.prompts.has(promptId)
    )
      return;
    this.prompts.set(promptId, {
      checkout,
      path,
      requestId,
      promptId,
      sourceDigest: digest(text),
      revision: null,
      state: 'editing',
    });
  }
  private prompt(requestId: string, promptId: string) {
    const prompt = this.prompts.get(promptId);
    if (!prompt || prompt.requestId !== requestId) throw new Error('Inactive editor prompt');
    return prompt;
  }
  private enqueue<T>(operation: () => Promise<T>) {
    const next = this.writes.then(operation);
    this.writes = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  write(requestId: string, promptId: string, text: string | null) {
    const prompt = this.prompt(requestId, promptId);
    if (prompt.state !== 'editing' && prompt.state !== 'interrupted')
      throw new Error('Editor prompt is closing');
    return this.enqueue(async () => {
      const record =
        text === null
          ? null
          : {
              editor: 'git' as const,
              promptId,
              path: prompt.path,
              sourceDigest: prompt.sourceDigest,
              text,
              updatedAt: Date.now(),
            };
      const state = await this.files.save(
        identity(prompt.checkout, promptId),
        prompt.revision,
        record,
      );
      prompt.revision = state.revision;
      prompt.savedDigest = text === null ? undefined : digest(text);
    });
  }
  private clear(prompt: Prompt, submittedDigest?: string) {
    return this.enqueue(async () => {
      if (
        prompt.revision !== null &&
        (submittedDigest === undefined || prompt.savedDigest === submittedDigest)
      ) {
        await this.files.save(identity(prompt.checkout, prompt.promptId), prompt.revision, null);
        prompt.revision = null;
      }
    });
  }
  closed(requestId: string, promptId: string, reason: 'submitted' | 'cancelled' | 'aborted') {
    const prompt = this.prompts.get(promptId);
    if (!prompt || prompt.requestId !== requestId || prompt.state === 'interrupted') return;
    if (reason === 'submitted') prompt.state = 'submitted';
    else {
      this.prompts.delete(promptId);
      if (reason === 'cancelled') return this.clear(prompt);
    }
  }
  written(requestId: string, promptId: string, hash: string) {
    const prompt = this.prompts.get(promptId);
    if (!prompt || prompt.requestId !== requestId || prompt.state !== 'submitted') return;
    this.prompts.delete(promptId);
    return this.clear(prompt, hash);
  }
  interrupt(ids: readonly string[]) {
    for (const prompt of this.prompts.values()) {
      if (!ids.includes(prompt.requestId)) continue;
      if (prompt.state === 'submitted') this.prompts.delete(prompt.promptId);
      else prompt.state = 'interrupted';
    }
  }
  finished(requestId: string) {
    for (const prompt of this.prompts.values()) {
      if (prompt.requestId === requestId && prompt.state !== 'interrupted')
        this.prompts.delete(prompt.promptId);
    }
  }
  async dismiss(requestId: string, promptId: string, discard: boolean) {
    const prompt = this.prompt(requestId, promptId);
    if (prompt.state !== 'interrupted') throw new Error('Editor request still active');
    prompt.state = 'dismissing';
    try {
      if (discard) await this.clear(prompt);
      this.prompts.delete(promptId);
    } catch (error) {
      prompt.state = 'interrupted';
      throw error;
    }
  }
  detach(discard: boolean) {
    for (const prompt of this.prompts.values()) {
      if (discard && prompt.state !== 'submitted') void this.clear(prompt).catch(() => {});
    }
    this.prompts.clear();
  }
  private async scan(checkout: Checkout, current?: Prompt) {
    await this.idle();
    const entries = [];
    let unreadable = false;
    for await (const { name, draft, revision } of this.files.entries()) {
      if (!draft) {
        unreadable = true;
        continue;
      }
      if (LocalDraftFiles.name(identity(checkout, draft.promptId)) !== name) continue;
      if (current && (draft.path !== current.path || this.prompts.has(draft.promptId))) continue;
      const { editor, path, promptId, updatedAt } = draft;
      entries.push({
        editor,
        path,
        promptId,
        updatedAt,
        revision,
        sameSource: draft.sourceDigest === current?.sourceDigest,
      });
    }
    return { entries: entries.sort((a, b) => b.updatedAt - a.updatedAt), unreadable };
  }
  async list(checkout: Checkout) {
    const { entries, unreadable } = await this.scan(checkout);
    return {
      entries: entries.map(
        ({ sameSource: _match, revision: _revision, ...entry }): NativeDraftEntry => entry,
      ),
      unreadable,
    };
  }
  async candidates(requestId: string, promptId: string) {
    const prompt = this.prompt(requestId, promptId);
    return { repoId: prompt.checkout.id, ...(await this.scan(prompt.checkout, prompt)) };
  }
  async read(checkout: Checkout, promptId: string) {
    await this.idle();
    const { draft, revision } = await this.files.read(identity(checkout, promptId));
    if (!revision || draft?.promptId !== promptId) throw new Error('Draft no longer available');
    return { text: draft.text, revision };
  }
  remove(checkout: Checkout, promptId: string, revision: string) {
    if (this.prompts.has(promptId)) throw new Error('Draft is open');
    return this.enqueue(() => this.files.save(identity(checkout, promptId), revision, null));
  }
  idle() {
    return this.writes;
  }
}
