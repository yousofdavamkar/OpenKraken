import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',
  timeout: 30000,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]],
  use: { trace: 'retain-on-failure' },
});
