import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { Report } from '../../shared/types/index.js';
import { atomicWrite, safeFilename, sanitizeReportHtml } from '../services/files.js';

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
  const document = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeText(report.title)}</title><style>@font-face{font-family:Pretendard;src:url(data:font/woff2;base64,${font.toString('base64')}) format('woff2');font-weight:45 920}*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#252124;font-family:Pretendard,sans-serif;line-height:1.65}main{${a4 ? 'width:210mm;min-height:297mm;padding:20mm;margin:0 auto;' : 'max-width:960px;padding:48px;margin:0 auto;'}}h1,h2,h3,h4{line-height:1.3;break-after:avoid}h1{color:#8d002d;border-bottom:2px solid #a50034;padding-bottom:12px}table{width:100%;border-collapse:collapse;break-inside:avoid}th,td{border:1px solid #cfc9ca;padding:8px;text-align:left}th{background:#f4f0f1}img{max-width:100%}.page-break{break-before:page}@page{size:${a4 ? 'A4 portrait' : 'auto'};margin:${a4 ? '20mm' : '12mm'}}@media print{main{width:auto;max-width:none;padding:0;margin:0}}</style></head><body><main>${body}</main></body></html>`;
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
function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
