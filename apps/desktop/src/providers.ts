import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import {
  providerPullChecksOptionsSchema,
  type ProviderPullChecksOptions,
  providerIssueOptionsSchema,
  providerIssueCommentsOptionsSchema,
  type ProviderIssueOptions,
  type ProviderIssueCommentsOptions,
  providerWriteIssueSchema,
  type ProviderWriteIssue,
  providerIssueListOptionsSchema,
  type ProviderIssueListOptions,
  providerMergePullSchema,
  type ProviderMergePull,
  providerPullTemplatesOptionsSchema,
  providerPullTemplateOptionsSchema,
  type ProviderPullTemplatesOptions,
  type ProviderPullTemplateOptions,
  providerPullSourceSchema,
  providerCreatePullSchema,
  type ProviderPullSource,
  type ProviderCreatePull,
  providerCreateCommentSchema,
  type ProviderCreateComment,
  providerPullReviewsOptionsSchema,
  providerSubmitReviewSchema,
  type ProviderPullReviewsOptions,
  type ProviderSubmitReview,
  providerPullFilesOptionsSchema,
  type ProviderPullFilesOptions,
  providerPullListOptionsSchema,
  providerPullOptionsSchema,
  type ProviderPullListOptions,
  type ProviderPullOptions,
  providerAccountSchema,
  providerCloneUrlSchema,
  providerGitCredentialSchema,
  providerRepositoryPageNumberSchema,
  providerAccountsSchema,
  providerConnectSchema,
  type ProviderAccount,
  type ProviderConnect,
  type DeviceStart,
} from '@openkraken/ipc-contract';
import { GitHubProvider, ProviderError, type ProviderDriver } from './github-provider.js';
import { ProviderCredentialError, ProviderVault } from './provider-vault.js';
import {
  GitHubDeviceFlow,
  GitHubOAuth,
  githubCredentialSchema,
  type GitHubCredential,
} from './github-device.js';

function scope(account: Pick<ProviderAccount, 'provider' | 'origin' | 'providerUserId'>) {
  return JSON.stringify([account.provider, account.origin, account.providerUserId]);
}
function idFor(account: Pick<ProviderAccount, 'provider' | 'origin' | 'providerUserId'>) {
  return createHash('sha256').update(scope(account)).digest('hex');
}
/** Provider network and credentials remain in main; public results contain account metadata only. */
export class ProviderService {
  private queue: Promise<void> = Promise.resolve();
  private manifest: string;
  private device: GitHubDeviceFlow;
  constructor(
    private directory: string,
    private vault: ProviderVault,
    private github: ProviderDriver = new GitHubProvider(),
    private oauth = new GitHubOAuth(),
    private now = Date.now,
  ) {
    this.manifest = join(directory, 'provider-accounts.json');
    this.device = new GitHubDeviceFlow(
      (credential, signal) =>
        this.connectCredential(
          { provider: 'github', origin: 'https://github.com', token: credential.accessToken },
          signal,
          credential,
        ),
      oauth,
      now,
    );
  }
  private run<T>(work: () => Promise<T>) {
    const pending = this.queue.then(work, work);
    // Keep only completion in the queue, never a returned plaintext credential.
    this.queue = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }
  async idle() {
    await this.queue;
  }
  private async load(): Promise<ProviderAccount[]> {
    let file;
    try {
      file = await open(this.manifest, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new ProviderError('PROVIDER_SETTINGS', 'Provider account settings could not be read.');
    }
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 256 * 1024) throw new Error('size');
      const buffer = Buffer.alloc(256 * 1024 + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = await file.read(buffer, bytes, buffer.length - bytes, null);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
      }
      if (bytes > 256 * 1024) throw new Error('size');
      const accounts = providerAccountsSchema.parse({
        keychainAvailable: false,
        accounts: JSON.parse(buffer.subarray(0, bytes).toString()),
      }).accounts;
      if (
        new Set(accounts.map((account) => account.id)).size !== accounts.length ||
        accounts.some((account) => idFor(account) !== account.id)
      )
        throw new Error('identity');
      return accounts;
    } catch {
      throw new ProviderError(
        'PROVIDER_SETTINGS',
        'Provider account settings are damaged. Restore them before reconnecting.',
      );
    } finally {
      await file.close();
    }
  }
  private async save(accounts: ProviderAccount[]) {
    const temporary = `${this.manifest}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(accounts), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.manifest);
    } catch {
      throw new ProviderError('PROVIDER_SETTINGS', 'Provider account settings could not be saved.');
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  accounts() {
    return this.run(async () => ({
      keychainAvailable: await this.vault.available(),
      accounts: await this.load(),
    }));
  }
  connect(input: ProviderConnect, signal?: AbortSignal) {
    return this.connectCredential(input, signal);
  }
  async deviceStart(options: DeviceStart, signal?: AbortSignal) {
    if (!(await this.vault.available())) throw new ProviderCredentialError('KEYCHAIN_UNAVAILABLE');
    return this.device.start(options, signal);
  }
  devicePoll(id: string, signal?: AbortSignal) {
    return this.device.poll(id, signal);
  }
  deviceCancel(id?: string) {
    this.device.cancel(id);
  }
  deviceVerificationUri(id: string) {
    return this.device.verificationUri(id);
  }
  private connectCredential(
    input: ProviderConnect,
    signal?: AbortSignal,
    credential?: GitHubCredential,
  ) {
    return this.run(async () => {
      const options = providerConnectSchema.parse(input);
      if (!(await this.vault.available()))
        throw new ProviderCredentialError('KEYCHAIN_UNAVAILABLE');
      signal?.throwIfAborted();
      const accounts = await this.load();
      const identity = await this.github.identity(options.origin, options.token, signal);
      const fields = {
        provider: options.provider,
        origin: options.origin,
        providerUserId: identity.id,
        login: identity.login,
      };
      const account = providerAccountSchema.parse({
        ...fields,
        id: idFor(fields),
        ...(credential ? { authentication: 'device', expiresAt: credential.expiresAt } : {}),
      });
      const existing = accounts.findIndex((item) => item.id === account.id);
      if (existing < 0 && accounts.length >= 50)
        throw new ProviderError('PROVIDER_LIMIT', 'Remove an account before connecting another.');
      signal?.throwIfAborted();
      await this.vault.write(
        scope(account),
        credential ? JSON.stringify(credential) : options.token,
      );
      if (existing < 0) accounts.push(account);
      else accounts[existing] = account;
      try {
        await this.save(accounts);
      } catch (error) {
        if (existing < 0) await this.vault.remove(scope(account)).catch(() => {});
        throw error;
      }
      return { keychainAvailable: true, accounts };
    });
  }
  verify(id: string, signal?: AbortSignal) {
    return this.run(async () => {
      const { accounts } = await this.authorize(id, signal);
      return { keychainAvailable: true, accounts };
    });
  }
  repositories(id: string, page: number, signal?: AbortSignal) {
    return this.run(async () => {
      providerRepositoryPageNumberSchema.parse(page);
      const { account, token } = await this.authorize(id, signal);
      return this.github.repositories(account.origin, token, page, signal);
    });
  }
  pullTemplates(id: string, input: ProviderPullTemplatesOptions, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerPullTemplatesOptionsSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.pullTemplates(account.origin, token, options, signal);
    });
  }
  pullTemplate(id: string, input: ProviderPullTemplateOptions, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerPullTemplateOptionsSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.pullTemplate(account.origin, token, options, signal);
    });
  }
  previewMerge(id: string, input: ProviderPullOptions, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerPullOptionsSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.previewMerge(account.origin, token, options, signal);
    });
  }
  mergePull(id: string, input: ProviderMergePull, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerMergePullSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.mergePull(account.origin, token, options, signal);
    });
  }
  previewPull(id: string, input: ProviderPullSource, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerPullSourceSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.previewPull(account.origin, token, options, signal);
    });
  }
  createPull(id: string, input: ProviderCreatePull, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerCreatePullSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.createPull(account.origin, token, options, signal);
    });
  }
  pullRequests(id: string, input: ProviderPullListOptions, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerPullListOptionsSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.pullRequests(account.origin, token, options, signal);
    });
  }
  pullRequest(id: string, input: ProviderPullOptions, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerPullOptionsSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.pullRequest(account.origin, token, options, signal);
    });
  }
  issues(id: string, input: ProviderIssueListOptions, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerIssueListOptionsSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.issues(account.origin, token, options, signal);
    });
  }
  issue(id: string, input: ProviderIssueOptions, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerIssueOptionsSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.issue(account.origin, token, options, signal);
    });
  }
  issueComments(id: string, input: ProviderIssueCommentsOptions, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerIssueCommentsOptionsSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.issueComments(account.origin, token, options, signal);
    });
  }
  writeIssue(id: string, input: ProviderWriteIssue, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerWriteIssueSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.writeIssue(account.origin, token, options, signal);
    });
  }
  previewIssueAction(id: string, input: ProviderIssueOptions, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerIssueOptionsSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.previewIssueAction(account.origin, token, options, signal);
    });
  }
  pullChecks(id: string, input: ProviderPullChecksOptions, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerPullChecksOptionsSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.pullChecks(account.origin, token, options, signal);
    });
  }
  pullFiles(id: string, input: ProviderPullFilesOptions, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerPullFilesOptionsSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.pullFiles(account.origin, token, options, signal);
    });
  }
  createComment(id: string, input: ProviderCreateComment, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerCreateCommentSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.createComment(account.origin, token, options, signal);
    });
  }
  pullComments(id: string, input: ProviderPullReviewsOptions, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerPullReviewsOptionsSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.pullComments(account.origin, token, options, signal);
    });
  }
  pullReviews(id: string, input: ProviderPullReviewsOptions, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerPullReviewsOptionsSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.pullReviews(account.origin, token, options, signal);
    });
  }
  submitReview(id: string, input: ProviderSubmitReview, signal?: AbortSignal) {
    return this.run(async () => {
      const options = providerSubmitReviewSchema.parse(input);
      const { account, token } = await this.authorize(id, signal);
      return this.github.submitReview(account.origin, token, options, signal);
    });
  }
  /** Internal main-process API; the result must never be returned to the renderer. */
  gitCredential(id: string, url: string, signal?: AbortSignal) {
    return this.run(async () => {
      const parsed = providerCloneUrlSchema.safeParse(url);
      if (!parsed.success)
        throw new ProviderError(
          'PROVIDER_CLONE_URL',
          'Choose a canonical HTTPS repository URL for this provider account.',
        );
      const { account, token } = await this.authorize(id, signal, new URL(parsed.data).origin);
      const credential = providerGitCredentialSchema.safeParse({
        url: parsed.data,
        username: account.login,
        password: token,
      });
      if (!credential.success) throw new ProviderCredentialError('CREDENTIAL_INVALID');
      signal?.throwIfAborted();
      return credential.data;
    });
  }
  private async authorize(id: string, signal?: AbortSignal, origin?: string) {
    signal?.throwIfAborted();
    const accounts = await this.load();
    const index = accounts.findIndex((account) => account.id === id);
    const account = accounts[index];
    if (!account)
      throw new ProviderError('PROVIDER_ACCOUNT', 'This provider account is no longer connected.');
    if (origin !== undefined && origin !== account.origin)
      throw new ProviderError(
        'PROVIDER_CLONE_URL',
        'The repository URL does not match this provider account.',
      );
    const saved = await this.vault.read(scope(account));
    if (!saved) throw new ProviderCredentialError('CREDENTIAL_INVALID');
    let credential: GitHubCredential | undefined;
    if (account.authentication === 'device') {
      try {
        credential = githubCredentialSchema.parse(JSON.parse(saved));
      } catch {
        throw new ProviderCredentialError('CREDENTIAL_INVALID');
      }
    }
    let rotated = false;
    if (credential?.expiresAt !== undefined && credential.expiresAt <= this.now() + 60000) {
      credential = await this.oauth.refresh(credential, signal);
      rotated = true;
    }
    const identity = await this.github.identity(
      account.origin,
      credential?.accessToken ?? saved,
      signal,
    );
    if (identity.id !== account.providerUserId)
      throw new ProviderError(
        'PROVIDER_ACCOUNT',
        'The authorization now identifies another account. Sign in again.',
      );
    signal?.throwIfAborted();
    if (rotated) await this.vault.write(scope(account), JSON.stringify(credential));
    const { expiresAt: _expiresAt, ...metadata } = account;
    accounts[index] = providerAccountSchema.parse({
      ...metadata,
      login: identity.login,
      ...(credential?.expiresAt ? { expiresAt: credential.expiresAt } : {}),
    });
    await this.save(accounts);
    return { accounts, account: accounts[index]!, token: credential?.accessToken ?? saved };
  }
  disconnect(id: string) {
    return this.run(async () => {
      const accounts = await this.load();
      const account = accounts.find((item) => item.id === id);
      if (!account)
        throw new ProviderError(
          'PROVIDER_ACCOUNT',
          'This provider account is no longer connected.',
        );
      await this.vault.remove(scope(account));
      const remaining = accounts.filter((item) => item.id !== id);
      await this.save(remaining);
      return { keychainAvailable: await this.vault.available(), accounts: remaining };
    });
  }
}
