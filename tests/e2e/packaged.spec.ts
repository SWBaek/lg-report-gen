import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const packagedAppPath = process.env.PACKAGED_APP_PATH;
test.skip(!packagedAppPath, 'PACKAGED_APP_PATH가 지정된 패키지 Smoke Test 전용');
test('packaged app opens its native database and preload bridge', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lg-report-packaged-'));
  const userData = path.join(root, 'user-data');
  const workspace = path.join(root, 'workspace');
  const wrapper = path.join(root, 'codex.cmd');
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(workspace, { recursive: true })]);
  await writeFile(
    wrapper,
    `@echo off\r\n"${process.execPath}" "${path.resolve('tests/fixtures/mock-codex.cjs')}" %*\r\n`,
  );
  await writeFile(
    path.join(userData, 'bootstrap.json'),
    JSON.stringify({
      workspacePath: workspace,
      consentAccepted: true,
      codexExecutablePath: wrapper,
      windowBounds: { width: 1180, height: 720 },
      sandboxMode: 'workspace-write',
    }),
  );
  const application = await electron.launch({
    executablePath: packagedAppPath ?? '',
    env: { ...process.env, LG_REPORT_AGENT_E2E_USER_DATA: userData },
  });
  try {
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1180, height: 720 });
    await expect(page.getByRole('button', { name: /새 보고서/ }).first()).toBeVisible();
    await page.getByRole('button', { name: '설정' }).click();
    await page.getByRole('button', { name: '새로고침' }).click();
    await expect(page.getByText('준비됨')).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: 'artifacts/screenshots/06-packaged-ready.png', fullPage: true });
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
