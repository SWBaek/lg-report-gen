import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: 0,
  outputDir: 'artifacts/playwright',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  reporter: [['list'], ['html', { outputFolder: 'artifacts/e2e-report', open: 'never' }]],
});
