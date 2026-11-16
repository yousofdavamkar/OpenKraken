import { join } from 'node:path';
import { z } from 'zod';
import { LocalDraftFiles } from './local-draft-files.js';
import type { SecretProtection } from './provider-vault.js';

export class DraftEncryptionUnavailable extends Error {}

export class ProtectedDraftFiles<T extends { scope: { accountId: string } }> {
  private files: LocalDraftFiles<string>;
  constructor(
    profile: string,
    folder: string,
    private accountId: string,
    private protection: SecretProtection,
    private schema: z.ZodType<T>,
    private identity: (record: T) => string[],
  ) {
    this.files = new LocalDraftFiles(
      profile,
      join(folder, accountId),
      z.string().base64(),
      1024 * 1024,
    );
  }
  private async decode(encoded: string, name: string) {
    const { result } = await this.protection.decrypt(Buffer.from(encoded, 'base64'));
    const record = this.schema.parse(JSON.parse(result));
    if (
      record.scope.accountId !== this.accountId ||
      LocalDraftFiles.name(this.identity(record)) !== name
    )
      throw new Error('Draft identity changed');
    return record;
  }
  async read(id: string[]) {
    const { draft, revision } = await this.files.read(id);
    return {
      record: draft === null ? null : await this.decode(draft, LocalDraftFiles.name(id)),
      revision,
    };
  }
  async *entries() {
    for await (const entry of this.files.entries()) {
      let record: T | null = null;
      try {
        if (entry.draft !== null) record = await this.decode(entry.draft, entry.name);
      } catch {
        // Keep damaged or inaccessible records on disk and report them to the inventory.
      }
      yield record;
    }
  }
  async save(id: string[], revision: string | null, record: T | null) {
    let value: string | null = null;
    if (record !== null) {
      try {
        value = (await this.protection.encrypt(JSON.stringify(record))).toString('base64');
      } catch {
        // Bypassing protection must never bypass a revision conflict.
        if ((await this.files.read(id)).revision !== revision) throw new Error('Draft changed');
        throw new DraftEncryptionUnavailable('Could not protect the draft on this device.');
      }
    }
    return (await this.files.save(id, revision, value)).revision;
  }
}
