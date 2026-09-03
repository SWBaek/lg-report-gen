import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const packagedAppPath = process.env.PACKAGED_APP_PATH;
test.skip(!packagedAppPath, 'PACKAGED_APP_PATH가 지정된 패키지 Smoke Test 전용');
test('packaged app opens its native database and preload bridge', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lg-report-packaged-'));
  const userData = path.join(root, 'user-data');
  const workspace = path.join(root, 'workspace');
  const wrapper = path.join(root, 'codex.cmd');
  const sourcePath = path.join(root, 'evidence.pdf');
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(workspace, { recursive: true })]);
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf
    .addPage()
    .drawText('Packaged PDF extraction evidence confirms the optimized runtime works correctly.', {
      x: 50,
      y: 700,
      font,
    });
  await writeFile(sourcePath, await pdf.save());
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
    args: [`--user-data-dir=${userData}`],
  });
  try {
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1180, height: 720 });
    await expect(page.getByRole('button', { name: /새 보고서/ }).first()).toBeVisible();
    await page.getByRole('button', { name: '설정' }).click();
    await page.getByRole('button', { name: '새로고침' }).click();
    // Production packaged runs do not trust the unsigned Codex test shim. Verify that
    // untrusted-provider state is surfaced, then exercise the Codex-independent wizard path.
    await expect(page.getByText('미설치', { exact: true })).toBeVisible({ timeout: 15_000 });
    await application.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
    }, sourcePath);
    await page
      .getByRole('button', { name: /새 보고서/ })
      .first()
      .click();
    await page
      .getByPlaceholder('보고 대상, 배경, 필요한 결정이나 결과를 적으세요')
      .fill('패키지의 PDF 추출과 HTML 내보내기를 확인한다.');
    await page.getByRole('button', { name: '다음' }).click();
    await page.getByRole('button', { name: '다음' }).click();
    await page.getByRole('button', { name: '파일 선택' }).click();
    await expect(page.getByText('evidence.pdf')).toBeVisible();
    await page.getByRole('button', { name: '다음' }).click();
    await page.getByText('빈 Report 생성').click();
    await page.getByRole('button', { name: '다음' }).click();
    await page.getByRole('button', { name: '생성 시작' }).click();
    await expect(page.getByLabel('보고서 편집기')).toBeVisible({ timeout: 30_000 });
    const reportDirectories = await import('node:fs/promises').then((fs) =>
      fs.readdir(path.join(workspace, 'reports')),
    );
    const manifest = JSON.parse(
      await readFile(
        path.join(workspace, 'reports', reportDirectories[0]!, 'source-manifest.json'),
        'utf8',
      ),
    ) as {
      sources: {
        extractedPath: string;
        extractionStatus: string;
        metadata: { pageCount?: number };
        warnings: string[];
      }[];
    };
    expect(['ready', 'partial'], manifest.sources[0]?.warnings.join('\n')).toContain(
      manifest.sources[0]?.extractionStatus,
    );
    expect(manifest.sources[0]?.metadata.pageCount).toBe(1);
    const reportRoot = path.join(workspace, 'reports', reportDirectories[0]!);
    const extractedPath = path.isAbsolute(manifest.sources[0]!.extractedPath)
      ? manifest.sources[0]!.extractedPath
      : path.resolve(reportRoot, manifest.sources[0]!.extractedPath);
    const extractedPdf = JSON.parse(await readFile(extractedPath, 'utf8')) as {
      content: { text: string }[];
    };
    expect(extractedPdf.content[0]?.text).toContain('Packaged PDF extraction evidence');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'HTML 내보내기' }).click();
    await expect
      .poll(async () => (await import('node:fs/promises')).readdir(path.join(workspace, 'exports')))
      .toContain('제목 없는 보고서.html');
    const exportedHtml = await readFile(
      path.join(workspace, 'exports', '제목 없는 보고서.html'),
      'utf8',
    );
    expect(exportedHtml).toContain('data:font/woff2;base64,');
    await page.screenshot({ path: 'artifacts/screenshots/06-packaged-ready.png', fullPage: true });
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('packaged app discovers the installed signed Codex CLI', async () => {
  test.skip(
    process.env.PACKAGED_REAL_CODEX !== '1',
    '로컬의 실제 서명된 Codex CLI를 사용하는 opt-in smoke test',
  );
  const root = await mkdtemp(path.join(os.tmpdir(), 'lg-report-packaged-real-codex-'));
  const userData = path.join(root, 'user-data');
  const workspace = path.join(root, 'workspace');
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(workspace, { recursive: true })]);
  await writeFile(
    path.join(userData, 'bootstrap.json'),
    JSON.stringify({
      workspacePath: workspace,
      consentAccepted: true,
      codexExecutablePath: null,
      windowBounds: { width: 1180, height: 720 },
      sandboxMode: 'workspace-write',
    }),
  );
  const application = await electron.launch({
    executablePath: packagedAppPath ?? '',
    args: [`--user-data-dir=${userData}`],
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole('button', { name: '설정' }).click();
    await page.getByRole('button', { name: '새로고침' }).click();
    await expect(page.getByText('준비됨', { exact: true })).toBeVisible({ timeout: 20_000 });
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
