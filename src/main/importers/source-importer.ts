import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import type { SourceManifestEntry } from '../../shared/types/index.js';
import { atomicWrite, contentHash, safeFilename } from '../services/files.js';
import type { WorkspacePaths } from '../workspace/manager.js';

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const SUPPORTED = new Set(Object.keys(MIME));

export class SourceImporter {
  constructor(private paths: WorkspacePaths) {}
  async import(reportId: string, inputPaths: string[]): Promise<SourceManifestEntry[]> {
    const reportRoot = path.join(this.paths.reports, reportId);
    const originals = path.join(reportRoot, 'source-originals');
    const extracted = path.join(reportRoot, 'source-extracted');
    await Promise.all([
      mkdir(originals, { recursive: true }),
      mkdir(extracted, { recursive: true }),
    ]);
    const results: SourceManifestEntry[] = [];
    for (const input of inputPaths) results.push(await this.importOne(input, originals, extracted));
    await atomicWrite(
      path.join(reportRoot, 'source-manifest.json'),
      JSON.stringify({ version: 1, sources: results }, null, 2),
    );
    return results;
  }
  private async importOne(
    input: string,
    originals: string,
    extracted: string,
  ): Promise<SourceManifestEntry> {
    const ext = path.extname(input).toLowerCase();
    if (!SUPPORTED.has(ext)) throw new Error('SOURCE_UNSUPPORTED');
    const sourceId = randomUUID();
    const info = await stat(input);
    const safe = `${sourceId}-${safeFilename(path.basename(input), 'source')}`;
    const stored = path.join(originals, safe);
    await copyFile(input, stored);
    const bytes = await readFile(stored);
    const entry: SourceManifestEntry = {
      sourceId,
      originalName: path.basename(input),
      storedPath: stored,
      mimeType: MIME[ext] ?? 'application/octet-stream',
      size: info.size,
      sha256: contentHash(bytes),
      extractionStatus: 'extracting',
      extractedPath: null,
      metadata: {},
      warnings: [],
      createdAt: new Date().toISOString(),
    };
    try {
      const result = await extractByType(ext, stored, bytes);
      const output = path.join(extracted, `${sourceId}.json`);
      await atomicWrite(output, JSON.stringify(result, null, 2));
      const snapshotDirectory = path.join(path.dirname(originals), 'agent-work', 'sources');
      await mkdir(snapshotDirectory, { recursive: true });
      const extractedSnapshot = `${sourceId}.json`;
      const originalSnapshot = `${sourceId}${ext}`;
      await copyFile(output, path.join(snapshotDirectory, extractedSnapshot));
      await copyFile(stored, path.join(snapshotDirectory, originalSnapshot));
      entry.extractedPath = output;
      entry.metadata = {
        ...result.metadata,
        agentWorkExtracted: `sources/${extractedSnapshot}`,
        agentWorkOriginal: `sources/${originalSnapshot}`,
      };
      entry.warnings = result.warnings;
      entry.extractionStatus = result.warnings.length ? 'partial' : 'ready';
      if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp') {
        const assetName = `${sourceId}${ext}`;
        await mkdir(path.join(path.dirname(originals), 'assets'), { recursive: true });
        await copyFile(stored, path.join(path.dirname(originals), 'assets', assetName));
        entry.metadata = { ...entry.metadata, editorSrc: `assets/${assetName}` };
      }
    } catch (error) {
      entry.extractionStatus = 'failed';
      entry.warnings = [error instanceof Error ? error.message : '추출에 실패했습니다.'];
    }
    return entry;
  }
}

interface ExtractResult {
  content: unknown;
  metadata: Record<string, unknown>;
  warnings: string[];
}
async function extractByType(ext: string, filePath: string, bytes: Buffer): Promise<ExtractResult> {
  if (ext === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    const pages = [];
    let total = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const text = await page.getTextContent();
      const value = text.items.map((item) => ('str' in item ? item.str : '')).join(' ');
      total += value.trim().length;
      pages.push({ locator: `page ${i}`, text: value });
    }
    const warnings =
      total < Math.max(50, pdf.numPages * 20)
        ? ['텍스트 추출 부족: 스캔 중심 PDF일 수 있습니다. OCR은 수행하지 않았습니다.']
        : [];
    return { content: pages, metadata: { pageCount: pdf.numPages }, warnings };
  }
  if (ext === '.docx') {
    const result = await mammoth.convertToHtml({ path: filePath });
    const text = result.value
      .replace(
        /<h([1-6])[^>]*>(.*?)<\/h\1>/gi,
        (_, level, heading) => `\n[heading ${level}] ${stripTags(heading)}\n`,
      )
      .replace(/<tr/gi, '\n<tr')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ');
    return {
      content: text,
      metadata: { hasImages: /<img/i.test(result.value) },
      warnings: result.messages.map((m) => m.message),
    };
  }
  if (ext === '.pptx') {
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const files = Object.keys(zip.files);
    if (files.length > 10000) throw new Error('압축 항목 수 제한을 초과했습니다.');
    const slides = files
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort(numericName);
    const content = [];
    for (const name of slides) {
      const xml = (await zip.file(name)?.async('string')) ?? '';
      if (xml.length > 20_000_000) throw new Error('슬라이드 압축 해제 크기 제한을 초과했습니다.');
      content.push({ locator: `slide ${numberIn(name)}`, text: extractOpenXmlText(xml) });
    }
    const notes = files.filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name));
    return {
      content,
      metadata: { slideCount: slides.length, noteCount: notes.length },
      warnings: [],
    };
  }
  if (ext === '.xlsx') {
    await validateZipArchive(bytes);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
    const warnings: string[] = [];
    const sheets = workbook.worksheets.slice(0, 100).map((sheet) => {
      const cells = sheet.rowCount * sheet.columnCount;
      if (cells > 1_000_000)
        warnings.push(`${sheet.name}: 1,000,000 셀 제한으로 일부만 처리했습니다.`);
      const maxRows = Math.min(sheet.rowCount, 10_000);
      const maxColumns = Math.min(sheet.columnCount, 100);
      const rows: string[][] = [];
      const formulas: { cell: string; formula: string }[] = [];
      for (let rowIndex = 1; rowIndex <= maxRows; rowIndex += 1) {
        const row: string[] = [];
        for (let columnIndex = 1; columnIndex <= maxColumns; columnIndex += 1) {
          const cell = sheet.getCell(rowIndex, columnIndex);
          row.push(cell.text);
          if (
            formulas.length < 10_000 &&
            typeof cell.value === 'object' &&
            cell.value !== null &&
            'formula' in cell.value
          )
            formulas.push({ cell: cell.address, formula: String(cell.value.formula) });
        }
        rows.push(row);
      }
      return {
        name: sheet.name,
        hidden: sheet.state !== 'visible',
        range: maxRows && maxColumns ? `A1:${sheet.getCell(maxRows, maxColumns).address}` : null,
        rows,
        formulas,
      };
    });
    return { content: sheets, metadata: { sheetCount: workbook.worksheets.length }, warnings };
  }
  if (ext === '.csv' || ext === '.txt' || ext === '.md') {
    if (bytes.includes(0)) throw new Error('Binary 파일로 판단되어 텍스트 추출을 중단했습니다.');
    const text = decodeText(bytes);
    if (ext === '.csv') {
      const delimiter = detectDelimiter(text);
      const rows = parseCsv(text, {
        bom: true,
        delimiter,
        relaxColumnCount: true,
        skipEmptyLines: false,
        to: 100_000,
      }) as string[][];
      return { content: rows, metadata: { rowCount: rows.length }, warnings: [] };
    }
    return { content: text, metadata: { characterCount: text.length }, warnings: [] };
  }
  return {
    content: null,
    metadata: { image: true },
    warnings: [
      '이미지 분석은 선택한 Codex 모델의 이미지 입력 지원 여부에 따라 AI 작업 시 수행됩니다.',
    ],
  };
}
function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function extractOpenXmlText(xml: string): string {
  return [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)]
    .map((match) => decodeEntities(match[1] ?? ''))
    .join('\n');
}
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
function numberIn(name: string): number {
  return Number(name.match(/(\d+)/)?.[1] ?? 0);
}
function numericName(a: string, b: string): number {
  return numberIn(a) - numberIn(b);
}
function decodeText(bytes: Buffer): string {
  const utf8 = bytes.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) ?? []).length;
  if (bad > Math.max(2, utf8.length * 0.01))
    throw new Error(
      '텍스트 인코딩을 UTF-8로 해석할 수 없습니다. UTF-8로 저장 후 다시 시도하십시오.',
    );
  return utf8.replace(/^\uFEFF/, '');
}
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  return (
    [',', '\t', ';', '|']
      .map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length - 1 }))
      .sort((left, right) => right.count - left.count)[0]?.delimiter ?? ','
  );
}
async function validateZipArchive(bytes: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  if (files.length > 20_000) throw new Error('압축 항목 수 제한을 초과했습니다.');
  let expanded = 0;
  for (const entry of files) {
    expanded += (await entry.async('uint8array')).byteLength;
    if (expanded > 200_000_000) throw new Error('압축 해제 크기 제한을 초과했습니다.');
  }
}
