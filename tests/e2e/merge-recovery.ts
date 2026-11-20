import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Locator,
} from '@playwright/test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export async function verifyMergeRecovery(
  provider: 'github' | 'enterprise' | 'gitlab',
  configure: (app: ElectronApplication) => Promise<void>,
  open: (app: ElectronApplication) => Promise<Locator>,
) {
  const lab = provider === 'gitlab';
  const root = mkdtempSync(join(tmpdir(), 'ok-merge-recovery-'));
  const args = [resolve('apps/desktop'), '--user-data-dir=' + join(root, 'profile')];
  let app = await electron.launch({ args });
  try {
    await configure(app);
    let dialog = await open(app);
    if (lab) {
      await dialog.getByLabel('Squash commits', { exact: true }).check();
      await dialog.getByLabel('Remove source branch after merge').check();
    } else await dialog.getByLabel('Merge method').selectOption('squash');
    await dialog
      .getByLabel(lab ? 'Use GitLab commit messages' : 'Use provider default commit message')
      .uncheck();
    const message = 'Keep my merge message\nSecond line';
    await dialog.getByRole('textbox', { name: 'Merge commit message', exact: true }).fill(message);
    await dialog
      .getByLabel(lab ? 'Squash commit message' : 'Merge commit title', { exact: true })
      .fill('Custom subject');
    await expect(dialog.getByText('Draft saved locally', { exact: true })).toBeVisible();
    for (const pending of [false, true]) {
      const exited = once(app.process(), 'exit');
      expect(app.process().kill('SIGKILL')).toBe(true);
      await exited;
      app = await electron.launch({ args });
      await configure(app);
      // Inventory access is local. Count provider traffic and stall exactly one remote write.
      await app.evaluate(({ session }) => {
        const traffic = { reads: 0, writes: 0 };
        Object.assign(globalThis, { mergeRecoveryTraffic: traffic });
        const conn = session.fromPartition('openkraken-providers');
        const fetch = conn.fetch.bind(conn);
        conn.fetch = async (input, init) => {
          if (init?.method === 'PUT') {
            traffic.writes++;
            return new Promise<Response>(() => {});
          }
          traffic.reads++;
          return fetch(input, init);
        };
      });
      const traffic = () =>
        app.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                mergeRecoveryTraffic: { reads: number; writes: number };
              }
            ).mergeRecoveryTraffic,
        );
      const page = await app.firstWindow();
      await page.getByRole('button', { name: 'Provider accounts', exact: true }).click();
      const accounts = page.getByRole('dialog', { name: 'Provider accounts', exact: true });
      await accounts.getByRole('button', { name: 'Saved merge drafts' }).click();
      const list = accounts.getByRole('region', { name: 'Saved merge drafts' });
      await list
        .getByRole('button', { name: lab ? 'group/subgroup/project !7' : 'team/project #1' })
        .click();
      await expect(list.getByLabel('Saved merge message')).toHaveText(message);
      await expect(list.getByLabel(lab ? 'Saved squash message' : 'Saved merge title')).toHaveText(
        'Custom subject',
      );
      expect(await traffic()).toEqual({ reads: 0, writes: 0 });
      await list.getByRole('button', { name: 'Open merge review' }).click();
      dialog = page.getByRole('dialog', {
        name: lab ? 'Merge GitLab request' : 'Merge pull request',
        exact: true,
      });
      await expect(
        dialog.getByRole('textbox', { name: 'Merge commit message', exact: true }),
      ).toHaveValue(message);
      if (lab) {
        await expect(dialog.getByLabel('Squash commits', { exact: true })).toBeChecked();
        await expect(dialog.getByLabel('Remove source branch after merge')).toBeChecked();
      } else await expect(dialog.getByLabel('Merge method')).toHaveValue('squash');
      const review = dialog.getByRole('button', {
        name: lab ? 'Review merge options' : 'Review selected merge',
        exact: true,
      });
      const submit = dialog.getByRole('button', {
        name: lab ? 'Confirm GitLab merge' : 'Merge confirmed PR',
        exact: true,
      });
      await expect(submit).toHaveCount(0);
      if (!pending) {
        await review.click();
        await submit.click();
        await expect.poll(async () => (await traffic()).writes).toBe(1);
      } else {
        await expect(review).toHaveCount(0);
        await dialog
          .getByRole('button', {
            name: lab ? 'Check current merge status' : 'Check merge status',
            exact: true,
          })
          .click();
        await dialog.getByRole('button', { name: /I checked/ }).click();
        await expect(review).toBeEnabled();
        expect((await traffic()).writes).toBe(0);
        await dialog.getByRole('button', { name: 'Close merge', exact: true }).click();
        if (lab) {
          await dialog.getByRole('button', { name: 'Discard draft', exact: true }).click();
        } else {
          await dialog.getByRole('button', { name: 'Save and close', exact: true }).click();
          await list.getByRole('button', { name: 'team/project #1' }).click();
          await expect(list.getByLabel('Saved merge message')).toHaveText(message);
          await expect(list.getByText(/may have received this merge/)).toHaveCount(0);
          const beforeDiscard = await traffic();
          await list.getByRole('button', { name: 'Discard saved merge draft' }).click();
          await list.getByRole('button', { name: 'Confirm discard' }).click();
          expect(await traffic()).toEqual(beforeDiscard);
        }
        await expect(list.getByText('No saved merge drafts for this account.')).toBeVisible();
      }
    }
  } finally {
    if (app.process().exitCode === null && app.process().signalCode === null) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}
