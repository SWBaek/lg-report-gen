import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { Report } from '../../shared/types/index.js';
import { atomicWrite, safeFilename, sanitizeReportHtml } from '../services/files.js';
import { buildReportDocument } from './report-theme.js';

export async function exportReportHtml(report: Report, targetDirectory: string): Promise<string> {
  const fontPath = app.isPackaged
    ? path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        'pretendard',
        'dist',
        'web',
        'variable',
        'woff2',
        'PretendardVariable.woff2',
      )
    : path.join(
        app.getAppPath(),
        'node_modules',
        'pretendard',
        'dist',
        'web',
        'variable',
        'woff2',
        'PretendardVariable.woff2',
      );
  const font = await readFile(fontPath);
  const base = safeFilename(report.title);
  let target = path.join(targetDirectory, `${base}.html`);
  for (let index = 2; index < 1000; index++) {
    try {
      await readFile(target);
      target = path.join(targetDirectory, `${base} (${index}).html`);
    } catch {
      break;
    }
  }
  const body = await embedLocalImages(
    sanitizeReportHtml(report.html),
    path.dirname(report.contentPath),
  );
  const a4 = report.layoutMode === 'a4';
  const document = buildReportDocument({
    title: report.title,
    body,
    fontBase64: font.toString('base64'),
    a4,
  });
  await atomicWrite(target, document);
  return target;
}
async function embedLocalImages(html: string, reportDir: string): Promise<string> {
  const matches = [...html.matchAll(/<img([^>]*?)src="([^"]+)"([^>]*)>/gi)];
  let result = html;
  for (const match of matches) {
    const src = match[2];
    if (!src || src.startsWith('data:')) continue;
    if (src.startsWith('http:') || src.startsWith('https:')) {
      result = result.replace(match[0], '');
      continue;
    }
    const absolute = path.resolve(reportDir, src);
    if (!absolute.startsWith(path.resolve(reportDir) + path.sep)) {
      result = result.replace(match[0], '');
      continue;
    }
    try {
      const bytes = await readFile(absolute);
      const ext = path.extname(absolute).slice(1).replace('jpg', 'jpeg');
      result = result.replace(
        match[0],
        `<img${match[1] ?? ''}src="data:image/${ext};base64,${bytes.toString('base64')}"${match[3] ?? ''}>`,
      );
    } catch {
      result = result.replace(match[0], '');
    }
  }
  return result;
}
