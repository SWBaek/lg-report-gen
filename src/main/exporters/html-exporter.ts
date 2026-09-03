import { readdir, readFile, stat, open, rm, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, session } from 'electron';
import { parseDocument } from 'htmlparser2';
import type { AnyNode, Element } from 'domhandler';
import * as DomUtils from 'domutils';
import type { Report } from '../../shared/types/index.js';
import type { ExportFormat, ExportPreflight, ExportWarning } from '../../shared/contracts/api.js';
import {
  atomicWrite,
  safeFilename,
  sanitizeReportHtml,
  resolveWithinRealpath,
} from '../services/files.js';
import { buildReportDocument, type ExportMetadata } from './report-theme.js';

export interface ExportOptions {
  format?: ExportFormat;
  metadata?: ExportMetadata;
}

const MAX_EMBEDDED_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_EMBEDDED_TOTAL_BYTES = 40 * 1024 * 1024;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Parse image references with an HTML parser and return a stable asset registry. */
export function listImageSources(html: string): string[] {
  const document = parseDocument(html);
  return DomUtils.findAll(
    (node: AnyNode) => node.type === 'tag' && node.name === 'img',
    document.children,
  )
    .map((node: AnyNode) => (node as Element).attribs.src ?? '')
    .filter(Boolean);
}

export async function preflightReportExport(
  report: Report,
  options: ExportOptions = {},
): Promise<Omit<ExportPreflight, 'reservationToken' | 'expiresAt'>> {
  const format = options.format ?? 'html';
  const warnings = await inspectAssets(report.html, path.dirname(report.contentPath));
  if (/<table\b/i.test(report.html) || /(?:width|height)\s*=\s*["']?\d{4,}/i.test(report.html))
    warnings.push({
      code: 'PAGE_OVERFLOW_POSSIBLE',
      message: '표 또는 큰 요소가 A4 페이지 너비를 넘어갈 수 있습니다.',
    });
  return { reportId: report.id, format, warnings, canExport: true };
}

export async function exportReport(
  report: Report,
  targetDirectory: string,
  options: ExportOptions = {},
): Promise<string> {
  const format = options.format ?? 'html';
  const document = await buildExportDocument(report, options.metadata);
  const reservation = await reserveOutput(targetDirectory, safeFilename(report.title), format);
  try {
    await atomicWrite(reservation.target, format === 'html' ? document : await renderPdf(document));
    return reservation.target;
  } finally {
    await reservation.release();
  }
}

export async function exportReportPdf(
  report: Report,
  targetDirectory: string,
  metadata?: ExportMetadata,
): Promise<string> {
  return exportReport(report, targetDirectory, {
    format: 'pdf',
    ...(metadata ? { metadata } : {}),
  });
}

/** Compatibility entry point retained for existing integrations. */
export async function exportReportHtml(report: Report, targetDirectory: string): Promise<string> {
  return exportReport(report, targetDirectory, { format: 'html' });
}

async function buildExportDocument(report: Report, metadata?: ExportMetadata): Promise<string> {
  const body = await embedAssets(sanitizeReportHtml(report.html), path.dirname(report.contentPath));
  const font = await readFile(await resolvePretendardPath());
  const defaults: ExportMetadata = {
    lang: report.outputOptions.language,
    date: report.updatedAt.slice(0, 10),
    revision: report.currentRevisionId ?? '',
    footer: 'LG Report Agent',
    pageNumber: true,
  };
  return buildReportDocument({
    title: report.title,
    body,
    fontBase64: font.toString('base64'),
    a4: report.layoutMode === 'a4',
    metadata: { ...defaults, ...metadata },
  });
}

async function inspectAssets(html: string, reportDir: string): Promise<ExportWarning[]> {
  const warnings: ExportWarning[] = [];
  let total = 0;
  for (const src of listImageSources(html)) {
    if (/^(?:https?:)?\/\//i.test(src)) {
      warnings.push({ code: 'EXTERNAL_ASSET', message: '외부 이미지가 차단됩니다.', asset: src });
      continue;
    }
    if (src.startsWith('data:')) {
      const parsed = parseDataImage(src);
      if (!parsed || !IMAGE_MIMES.has(parsed.mime))
        warnings.push({
          code: 'UNSUPPORTED_IMAGE',
          message: '지원하지 않는 내장 이미지 MIME입니다.',
          asset: src.slice(0, 80),
        });
      else if (detectImageMime(parsed.bytes) !== parsed.mime)
        warnings.push({
          code: 'INVALID_IMAGE_MIME',
          message: '내장 이미지의 실제 MIME이 선언과 다릅니다.',
          asset: 'data:',
        });
      else if (parsed.bytes.length > MAX_EMBEDDED_ASSET_BYTES)
        warnings.push({
          code: 'EMBEDDED_ASSET_TOO_LARGE',
          message: '내장 이미지가 10MB를 초과합니다.',
          asset: 'data:',
        });
      else total += parsed.bytes.length;
      continue;
    }
    if (!/^\.(?:png|jpe?g|webp|gif)$/i.test(path.extname(src))) {
      warnings.push({
        code: 'UNSUPPORTED_IMAGE',
        message: '지원하지 않는 이미지 형식입니다.',
        asset: src,
      });
      continue;
    }
    try {
      const absolute = await resolveWithinRealpath(reportDir, decodeURIComponent(src));
      const bytes = await readFile(absolute);
      const mime = detectImageMime(bytes);
      if (!mime || !IMAGE_MIMES.has(mime))
        warnings.push({
          code: 'INVALID_IMAGE_MIME',
          message: '이미지 파일의 실제 MIME이 유효하지 않습니다.',
          asset: src,
        });
      else if (bytes.length > MAX_EMBEDDED_ASSET_BYTES)
        warnings.push({
          code: 'EMBEDDED_ASSET_TOO_LARGE',
          message: '이미지가 10MB를 초과합니다.',
          asset: src,
        });
      else total += bytes.length;
    } catch {
      warnings.push({
        code: 'MISSING_ASSET',
        message: '이미지 파일을 찾을 수 없거나 경로가 안전하지 않습니다.',
        asset: src,
      });
    }
  }
  if (total > MAX_EMBEDDED_TOTAL_BYTES)
    warnings.push({
      code: 'EMBEDDED_ASSET_TOO_LARGE',
      message: '내장 이미지 전체가 40MB를 초과합니다.',
    });
  return warnings;
}

async function embedAssets(html: string, reportDir: string): Promise<string> {
  const document = parseDocument(html);
  const images = DomUtils.findAll(
    (node: AnyNode) => node.type === 'tag' && node.name === 'img',
    document.children,
  ) as Element[];
  for (const image of images) {
    const src = image.attribs.src;
    if (!src || src.startsWith('data:')) {
      if (src?.startsWith('data:')) {
        const parsed = parseDataImage(src);
        if (
          !parsed ||
          !IMAGE_MIMES.has(parsed.mime) ||
          detectImageMime(parsed.bytes) !== parsed.mime
        )
          delete image.attribs.src;
      }
      continue;
    }
    if (/^(?:https?:)?\/\//i.test(src)) {
      delete image.attribs.src;
      continue;
    }
    try {
      const bytes = await readFile(await resolveWithinRealpath(reportDir, decodeURIComponent(src)));
      const mime = detectImageMime(bytes);
      if (!mime || !IMAGE_MIMES.has(mime) || bytes.length > MAX_EMBEDDED_ASSET_BYTES)
        delete image.attribs.src;
      else image.attribs.src = `data:${mime};base64,${bytes.toString('base64')}`;
    } catch {
      delete image.attribs.src;
    }
  }
  return DomUtils.getInnerHTML(document);
}

function parseDataImage(value: string): { mime: string; bytes: Buffer } | null {
  const comma = value.indexOf(',');
  if (!value.startsWith('data:') || comma < 0) return null;
  const header = value.slice(5, comma);
  const mime = header.split(';')[0]?.toLowerCase();
  if (!mime) return null;
  try {
    return {
      mime,
      bytes: /;base64/i.test(header)
        ? Buffer.from(value.slice(comma + 1), 'base64')
        : Buffer.from(decodeURIComponent(value.slice(comma + 1)), 'utf8'),
    };
  } catch {
    return null;
  }
}

export function detectImageMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  if (
    bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
    bytes.subarray(0, 6).toString('ascii') === 'GIF89a'
  )
    return 'image/gif';
  return null;
}

async function renderPdf(document: string): Promise<Buffer> {
  if (!app.isReady()) throw new Error('EXPORT_ELECTRON_NOT_READY');
  // Keep each print document isolated and non-persistent. A data: URL is not
  // suitable for very large reports (notably the embedded Pretendard font),
  // so Chromium loads a short-lived local file instead.
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'lg-report-export-'));
  const mainDocument = path.join(tempDirectory, 'index.html');
  await writeFile(mainDocument, document, 'utf8');
  const exportPartition = `lg-report-export-${randomUUID()}`;
  const exportSession = session.fromPartition(exportPartition);
  const window = new BrowserWindow({
    show: false,
    width: 794,
    height: 1123,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: exportPartition,
    },
  });
  const filter = { urls: ['http://*/*', 'https://*/*', 'file://*/*'] };
  const blockRequest = (
    details: Electron.OnBeforeRequestListenerDetails,
    callback: (response: Electron.CallbackResponse) => void,
  ) => {
    if (details.url.startsWith('file:')) {
      try {
        callback({ cancel: fileURLToPath(details.url) !== path.resolve(mainDocument) });
      } catch {
        callback({ cancel: true });
      }
      return;
    }
    callback({ cancel: true });
  };
  exportSession.webRequest.onBeforeRequest(filter, blockRequest);
  try {
    await window.loadURL(pathToFileURL(mainDocument).toString());
    await window.webContents.executeJavaScript('document.fonts?.ready');
    return await window.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      preferCSSPageSize: true,
    });
  } finally {
    exportSession.webRequest.onBeforeRequest(filter, null);
    if (!window.isDestroyed()) window.destroy();
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function reserveOutput(
  directory: string,
  base: string,
  format: ExportFormat,
): Promise<{ target: string; release: () => Promise<void> }> {
  const ext = format === 'pdf' ? 'pdf' : 'html';
  for (let index = 1; index < 1000; index += 1) {
    const suffix = index === 1 ? '' : ` (${index})`;
    const target = path.join(directory, `${base}${suffix}.${ext}`);
    const lockPath = `${target}.lock`;
    try {
      const lock = await open(lockPath, 'wx');
      const release = async () => {
        await lock.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
      };
      try {
        await stat(target);
        await release();
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          await release();
          throw error;
        }
      }
      return { target, release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('EXPORT_FILENAME_EXHAUSTED');
}

async function resolvePretendardPath(): Promise<string> {
  if (!app.isPackaged)
    return path.join(
      app.getAppPath(),
      'node_modules',
      'pretendard',
      'dist',
      'web',
      'variable',
      'woff2',
      'PretendardVariable.woff2',
    );
  const assets = path.join(app.getAppPath(), 'out', 'renderer', 'assets');
  const bundledFont = (await readdir(assets)).find((name) =>
    /^PretendardVariable(?:-[A-Za-z0-9_-]+)?\.woff2$/.test(name),
  );
  if (!bundledFont) throw new Error('REPORT_EXPORT_FONT_MISSING');
  return path.join(assets, bundledFont);
}
