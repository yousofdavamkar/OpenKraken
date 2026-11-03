import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

test.skipIf(process.platform === 'win32')(
  'lifecycle CLI refuses a non-Windows host before reading missing artifacts',
  async () => {
    await expect(
      promisify(execFile)(
        process.execPath,
        ['scripts/check-msi-lifecycle.mjs', 'missing-current.json', 'missing-next.json'],
        {
          env: {
            ...process.env,
            OPENKRAKEN_DISPOSABLE_INSTALL_TEST: '1',
            GITHUB_ACTIONS: 'true',
            RUNNER_OS: 'Windows',
            RUNNER_ENVIRONMENT: 'github-hosted',
          },
          timeout: 15000,
        },
      ),
    ).rejects.toThrow(
      'MSI lifecycle requires an explicitly enabled disposable hosted Windows x64 runner',
    );
  },
);
