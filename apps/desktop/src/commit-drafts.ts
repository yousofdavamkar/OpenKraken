import { commitDraftSchema, type CommitDraft, type Repository } from '@openkraken/ipc-contract';
import { LocalDraftFiles } from './local-draft-files.js';

export class CommitDrafts {
  private files;
  constructor(profile: string) {
    this.files = new LocalDraftFiles(profile, 'commit-drafts', commitDraftSchema, 1024 * 1024);
  }
  read(repository: Repository) {
    return this.files.read([repository.path, repository.gitDir]);
  }
  save(repository: Repository, revision: string | null, draft: CommitDraft) {
    return this.files.save([repository.path, repository.gitDir], revision, draft);
  }
  idle() {
    return this.files.idle();
  }
}
