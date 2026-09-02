import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let root: string;
let workspace: string;
let wrapper: string;
let app: ElectronApplication;
let page: Page;
test.beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'lg-report-e2e-'));
  workspace = path.join(root, '한국어 Workspace');
  await mkdir(workspace, { recursive: true });
  wrapper = path.join(root, 'codex.cmd');
  await writeFile(
    wrapper,
    `@echo off\r\n"${process.execPath}" "${path.resolve('tests/fixtures/mock-codex.cjs')}" %*\r\n`,
  );
});
test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});
async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      LG_REPORT_AGENT_E2E_USER_DATA: path.join(root, 'user-data'),
    },
    timeout: 30_000,
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1180, height: 720 });
}
test('first run, local report workflow, restart, chat, and export', async () => {
  await launch();
  await expect(page.getByRole('heading', { name: 'LG Report Agent' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/screenshots/01-consent.png', fullPage: true });
  await page.getByRole('button', { name: '확인하고 계속' }).click();
  await expect(page.getByRole('heading', { name: 'Workspace 선택' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/screenshots/02-workspace.png', fullPage: true });
  const actualUserData = await app.evaluate(({ app }) => app.getPath('userData'));
  await app.close();
  await mkdir(actualUserData, { recursive: true });
  await writeFile(
    path.join(actualUserData, 'bootstrap.json'),
    JSON.stringify({
      workspacePath: workspace,
      consentAccepted: true,
      codexExecutablePath: wrapper,
      windowBounds: { width: 1180, height: 720 },
      sandboxMode: 'workspace-write',
    }),
  );
  await launch();
  await expect(page.getByRole('button', { name: /새 보고서/ }).first()).toBeVisible();
  await page.getByRole('button', { name: /설정/ }).click();
  await page.getByRole('button', { name: '새로고침' }).click();
  await expect(page.getByText('준비됨')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: 'artifacts/screenshots/03-settings-ready.png', fullPage: true });
  await page
    .getByRole('button', { name: /새 보고서/ })
    .first()
    .click();
  await page.getByPlaceholder('비워두면 AI가 제안할 수 있습니다').fill('E2E 검증 보고서');
  await page
    .getByPlaceholder('보고 대상, 배경, 필요한 결정이나 결과를 적으세요')
    .fill('로컬 저장과 HTML 내보내기를 검증한다.');
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByText('고급 설정', { exact: true }).click();
  await page.getByLabel('모델').selectOption('alternate-model');
  await expect(page.getByLabel('Reasoning Effort')).toHaveValue('high');
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByText('즉시 생성').click();
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByText(/Alternate model · Reasoning 높음/)).toBeVisible();
  await page.getByRole('button', { name: '생성 시작' }).click();
  await expect(page.getByText('보고서를 생성하고 있습니다…')).toBeVisible();
  await expect(page.getByText(/"htmlBody"/)).toHaveCount(0);
  await expect(page.getByLabel('보고서 편집기')).toBeVisible();
  await expect(page.getByLabel('보고서 편집기')).toContainText('안전하게 생성된 본문');
  await expect(page.getByLabel('보고서 편집기')).toContainText('alternate-model · high');
  await page.getByLabel('보고서 편집기').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' 수동 편집 내용');
  await expect(page.getByText('저장됨')).toBeVisible({ timeout: 5_000 });
  await page.screenshot({ path: 'artifacts/screenshots/04-editor-a4.png', fullPage: true });
  await page.getByRole('button', { name: 'A4' }).click();
  await expect(page.getByRole('button', { name: 'Web' })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'HTML 내보내기' }).click();
  await page.waitForTimeout(500);
  const exports = path.join(workspace, 'exports');
  const files = await import('node:fs/promises').then((fs) => fs.readdir(exports));
  expect(files.some((name) => name.endsWith('.html'))).toBe(true);
  const html = await readFile(
    path.join(
      exports,
      files.find((name) => name.endsWith('.html'))!,
    ),
    'utf8',
  );
  expect(html).not.toMatch(/<script|onclick=/i);
  expect(html).toContain('@page');
  await app.close();
  await launch();
  await page.getByRole('button', { name: 'E2E 검증 보고서', exact: true }).click();
  await expect(page.getByLabel('보고서 편집기')).toContainText('수동 편집 내용');
  await page.getByRole('button', { name: '새 Chat' }).click();
  await page.getByLabel('Chat 메시지').fill('짧게 답해줘');
  await page.getByRole('button', { name: '전송' }).click();
  await expect(page.getByText('안전한 응답')).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: 'artifacts/screenshots/05-chat.png', fullPage: true });
});
