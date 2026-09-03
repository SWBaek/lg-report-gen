import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { parse as parseCsv } from 'csv-parse/sync';
import type { SourceManifestEntry } from '../../shared/types/index.js';
import { atomicWrite } from '../services/files.js';
import type { WorkspacePaths } from '../workspace/manager.js';
import { ParserSupervisor, type ParserSupervisorOptions } from './parser-supervisor.js';

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
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const MAX_PDF_PAGES = 500;
const MAX_PDF_TEXT = 10 * 1024 * 1024;
const PDF_OPERATION_TIMEOUT_MS = 15_000;
const MAX_ZIP_ENTRIES = 20_000;
const MAX_ZIP_EXPANDED_BYTES = 200 * 1024 * 1024;
const MAX_ZIP_SINGLE_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_ZIP_RATIO = 1_000;
const MAX_PPTX_XML_CHARS = 20_000_000;
const MAX_CSV_RECORDS = 100_000;
const MAX_CSV_FIELDS = 1_000;
const MAX_CSV_FIELD_CHARS = 1_000_000;
const MAX_TEXT_CHARS = 20_000_000;
const MAX_IMAGE_DIMENSION = 20_000;
const MAX_IMAGE_PIXELS = 100_000_000;

/** Bump this whenever extraction semantics or the output schema changes. */
export const EXTRACTOR_VERSION = '2.0.0';
export const EXTRACTOR_PACKAGE = '@lg-report-agent/source-importer';
const EXTRACTION_SCHEMA = 'lg-report-agent.source-extraction.v2';
const EXTRACTOR_CONFIG = Object.freeze({
  maxSourceBytes: MAX_SOURCE_BYTES,
  maxPdfPages: MAX_PDF_PAGES,
  maxPdfText: MAX_PDF_TEXT,
  maxZipEntries: MAX_ZIP_ENTRIES,
  maxCsvRecords: MAX_CSV_RECORDS,
  maxCsvFields: MAX_CSV_FIELDS,
  maxTextChars: MAX_TEXT_CHARS,
});

interface ExtractResult {
  content: unknown;
  metadata: Record<string, unknown>;
  warnings: string[];
}
interface CopyResult {
  size: number;
  sha256: string;
}

interface Provenance {
  schema: string;
  extractor: string;
  extractorPackage: string;
  version: string;
  extractorVersion: string;
  config: Record<string, number>;
  extractorConfig: Record<string, number>;
  sourceHash: string;
  extractedAt: string;
  time: string;
  partialReasons: string[];
  [key: string]: unknown;
}

async function readManifest(filePath: string): Promise<SourceManifestEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { sources?: unknown }).sources)
    )
      throw new Error('SOURCE_MANIFEST_INVALID');
    return (parsed as { sources: SourceManifestEntry[] }).sources;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function getProvenanceVersion(source: SourceManifestEntry): string | undefined {
  const provenance = source.metadata.provenance;
  if (!provenance || typeof provenance !== 'object') return undefined;
  const value = provenance as { extractorVersion?: unknown; version?: unknown };
  return typeof value.extractorVersion === 'string'
    ? value.extractorVersion
    : typeof value.version === 'string'
      ? value.version
      : undefined;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export class SourceImporter {
  private readonly parser: ParserSupervisor;

  constructor(
    private paths: WorkspacePaths,
    options: { parser?: ParserSupervisorOptions } = {},
  ) {
    this.parser = new ParserSupervisor(options.parser);
  }

  async import(
    reportId: string,
    inputPaths: string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<SourceManifestEntry[]> {
    const reportRoot = path.join(this.paths.reports, reportId);
    const originals = path.join(reportRoot, 'source-originals');
    const extracted = path.join(reportRoot, 'source-extracted');
    const blobs = path.join(originals, 'blobs', 'sha256');
    await Promise.all([
      mkdir(originals, { recursive: true }),
      mkdir(extracted, { recursive: true }),
      mkdir(blobs, { recursive: true }),
    ]);
    const manifestPath = path.join(reportRoot, 'source-manifest.json');
    const existing = await readManifest(manifestPath);
    const results: SourceManifestEntry[] = [];
    for (const input of inputPaths) {
      results.push(
        await this.importOne(
          input,
          originals,
          extracted,
          blobs,
          [...existing, ...results],
          options.signal,
        ),
      );
    }

    const merged = [...existing];
    for (const result of results) {
      const index = merged.findIndex((candidate) => candidate.sourceId === result.sourceId);
      if (index >= 0) merged[index] = result;
      else merged.push(result);
    }
    // Keep the manifest envelope at v1; content-addressing and provenance
    // are additive fields so existing reports/loaders remain readable.
    await atomicWrite(manifestPath, JSON.stringify({ version: 1, sources: merged }, null, 2));
    return results;
  }

  private async importOne(
    input: string,
    originals: string,
    extracted: string,
    blobs: string,
    knownSources: SourceManifestEntry[],
    signal?: AbortSignal,
  ): Promise<SourceManifestEntry> {
    const ext = path.extname(input).toLowerCase();
    if (!SUPPORTED.has(ext)) throw new Error('SOURCE_UNSUPPORTED');
    const info = await stat(input);
    if (!info.isFile()) throw new Error('SOURCE_NOT_A_FILE');
    if (info.size > MAX_SOURCE_BYTES) throw new Error('SOURCE_FILE_TOO_LARGE');
    const sourceId = randomUUID();
    // The blob is addressed by its bytes, not by the source UUID. This lets
    // repeated attachments share both the immutable original and extraction
    // result while each manifest entry retains its own sourceId/name link.
    const copied = await materializeBlob(input, blobs);
    const stored = path.join(blobs, copied.sha256);
    const reusable = knownSources.find(
      (candidate) =>
        candidate.sha256 === copied.sha256 &&
        candidate.mimeType === MIME[ext] &&
        candidate.extractedPath !== null &&
        getProvenanceVersion(candidate) === EXTRACTOR_VERSION,
    );
    if (reusable && (await fileExists(reusable.extractedPath!))) {
      return {
        ...reusable,
        originalName: path.basename(input),
        metadata: { ...reusable.metadata, extractionReused: true },
      };
    }
    const extractedAt = new Date().toISOString();
    const provenance: Provenance = {
      schema: EXTRACTION_SCHEMA,
      extractor: 'source-importer',
      package: EXTRACTOR_PACKAGE,
      extractorPackage: EXTRACTOR_PACKAGE,
      version: EXTRACTOR_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      config: { ...EXTRACTOR_CONFIG },
      extractorConfig: { ...EXTRACTOR_CONFIG },
      sourceHash: copied.sha256,
      extractedAt,
      time: extractedAt,
      partialReasons: [],
    };
    const entry: SourceManifestEntry = {
      sourceId,
      originalName: path.basename(input),
      storedPath: stored,
      mimeType: MIME[ext]!,
      size: copied.size,
      sha256: copied.sha256,
      extractionStatus: 'extracting',
      extractedPath: null,
      metadata: { provenance },
      warnings: [],
      createdAt: new Date().toISOString(),
    };
    try {
      const reportRoot = path.dirname(originals);
      const assets = path.join(reportRoot, 'assets');
      await mkdir(assets, { recursive: true });
      const cache = path.join(extracted, 'cache');
      await mkdir(cache, { recursive: true });
      const cachePath = path.join(
        cache,
        `${copied.sha256}-${EXTRACTOR_VERSION}-${ext.slice(1)}.json`,
      );
      const cached = await readCachedExtraction(cachePath, copied.sha256);
      const cachedNormalization = cached?.metadata.normalization as
        { assetPath?: string } | undefined;
      const cacheUsable =
        !!cached &&
        (!isImage(ext) ||
          !cachedNormalization?.assetPath ||
          (await fileExists(path.join(reportRoot, cachedNormalization.assetPath))));
      if (cacheUsable && cached) {
        const cachedWarnings = cached.warnings;
        const cachedProvenance = cached.metadata.provenance as Provenance | undefined;
        entry.extractedPath = cachePath;
        entry.metadata = {
          ...cached.metadata,
          provenance: cachedProvenance,
          evidenceLocator: `evidence/${path.basename(stored)}`,
          derivedLocator: `derived/${path.basename(cachePath)}`,
          extractionReused: true,
        };
        entry.warnings = cachedWarnings;
        entry.extractionStatus = cachedWarnings.length ? 'partial' : 'ready';
        if (isImage(ext) && cached.metadata.normalization) {
          const normalized = cached.metadata.normalization as { assetPath?: string };
          if (
            normalized.assetPath &&
            (await fileExists(path.join(path.dirname(originals), normalized.assetPath)))
          ) {
            entry.metadata.editorSrc = normalized.assetPath;
            entry.metadata.editorSrcMetadataSafe = true;
          }
        }
        return entry;
      }
      const imageAssetPath = isImage(ext) ? path.join(assets, `${copied.sha256}.png`) : undefined;
      const parserResult = await this.parser.run(stored, ext, reportRoot, imageAssetPath, signal);
      const { imageAssetCreated } = parserResult;
      const result: ExtractResult = {
        content: parserResult.content,
        metadata: parserResult.metadata,
        warnings: parserResult.warnings,
      };
      const resultWithProvenance: ExtractResult = {
        ...result,
        metadata: { ...result.metadata, provenance },
      };
      const output = cachePath;
      if (isImage(ext) && imageAssetPath && imageAssetCreated) {
        const normalizedBytes = await readFile(imageAssetPath);
        const normalizedHash = createHash('sha256').update(normalizedBytes).digest('hex');
        const normalization = {
          original: { sha256: copied.sha256, size: copied.size },
          normalized: { sha256: normalizedHash, size: normalizedBytes.length },
          assetPath: `assets/${path.basename(imageAssetPath)}`,
          transform: 'auto-orient, fit-inside-4096, PNG, metadata-stripped',
        };
        resultWithProvenance.metadata.normalization = normalization;
        provenance.normalization = normalization;
      } else if (isImage(ext) && !imageAssetCreated) {
        resultWithProvenance.warnings = [
          ...resultWithProvenance.warnings,
          '메타데이터 안전 표시본을 생성하지 못해 이미지 미리보기를 생략했습니다.',
        ];
      }
      provenance.partialReasons = [...resultWithProvenance.warnings];
      await atomicWrite(output, JSON.stringify(resultWithProvenance, null, 2));
      entry.extractedPath = output;
      entry.metadata = {
        ...resultWithProvenance.metadata,
        provenance,
        // Keep the on-disk source-originals/source-extracted names for old reports, but
        // expose only logical evidence/derived locators to downstream AI work.  Neither
        // locator is inside the Codex writable agent-output directory.
        evidenceLocator: `evidence/${path.basename(stored)}`,
        derivedLocator: `derived/${path.basename(output)}`,
      };
      entry.warnings = resultWithProvenance.warnings;
      entry.extractionStatus = result.warnings.length ? 'partial' : 'ready';
      if (isImage(ext)) {
        if (imageAssetCreated) {
          entry.metadata = {
            ...entry.metadata,
            editorSrc: `assets/${copied.sha256}.png`,
            editorSrcMetadataSafe: true,
          };
        } else {
          entry.extractionStatus = 'partial';
        }
      }
    } catch (error) {
      entry.extractionStatus = 'failed';
      const reason = error instanceof Error ? error.message : '추출에 실패했습니다.';
      provenance.partialReasons = [reason];
      entry.metadata = { ...entry.metadata, provenance };
      entry.warnings = [reason];
    }
    return entry;
  }
}

export async function extractByType(
  ext: string,
  filePath: string,
  bytes: Buffer,
): Promise<ExtractResult> {
  validateSignature(ext, bytes);
  if (isOoxml(ext)) await preflightOoxml(bytes, ext);
  if (ext === '.pdf') return extractPdf(bytes);
  if (ext === '.docx') {
    const result = await mammoth.convertToHtml({ path: filePath });
    const warnings = result.messages.map((m) => m.message);
    const blocks = extractDocxBlocks(result.value, MAX_TEXT_CHARS, warnings);
    const plainText = blocksToText(blocks);
    if (plainText.length > MAX_TEXT_CHARS) {
      warnings.push('문서 추출 문자 수 제한으로 일부만 처리했습니다.');
    }
    return {
      content: blocks,
      metadata: {
        hasImages: /<img/i.test(result.value),
        blockCount: blocks.length,
        plainText: plainText.slice(0, MAX_TEXT_CHARS),
      },
      warnings: [...new Set(warnings)],
    };
  }
  if (ext === '.pptx') {
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const files = Object.keys(zip.files);
    const slides = files
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort(numericName);
    const warnings: string[] = [];
    const availableSlides = slides.slice(0, MAX_PDF_PAGES);
    if (slides.length > availableSlides.length)
      warnings.push('슬라이드 수 제한으로 일부만 처리했습니다.');
    const content: {
      locator: string;
      text: string;
      shapes: PptxShape[];
      tables: string[][][];
      notes: string;
    }[] = [];
    for (const name of availableSlides) {
      const xml = (await zip.file(name)?.async('string')) ?? '';
      const truncated = xml.length > MAX_PPTX_XML_CHARS;
      if (truncated) warnings.push(`${name}: 슬라이드 XML 크기 제한으로 일부만 처리했습니다.`);
      const slideNumber = numberIn(name);
      const slide = extractPptxSlide(truncated ? xml.slice(0, MAX_PPTX_XML_CHARS) : xml);
      const noteName = `ppt/notesSlides/notesSlide${slideNumber}.xml`;
      const noteXml = (await zip.file(noteName)?.async('string')) ?? '';
      const notesText = extractOpenXmlText(noteXml);
      content.push({
        locator: `slide ${slideNumber}`,
        text: slide.text,
        shapes: slide.shapes,
        tables: slide.tables,
        notes: notesText,
      });
    }
    const notes = files.filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name));
    return {
      content,
      metadata: {
        slideCount: slides.length,
        noteCount: notes.length,
        shapeCount: content.reduce((total, slide) => total + slide.shapes.length, 0),
        tableCount: content.reduce((total, slide) => total + slide.tables.length, 0),
      },
      warnings,
    };
  }
  if (ext === '.xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
    const warnings: string[] = [];
    const sheets = workbook.worksheets.slice(0, 100).map((sheet) => {
      const cells = sheet.rowCount * sheet.columnCount;
      const maxRows = Math.min(sheet.rowCount, 10_000);
      const maxColumns = Math.min(sheet.columnCount, 100);
      if (cells > 1_000_000 || sheet.rowCount > maxRows || sheet.columnCount > maxColumns)
        warnings.push(`${sheet.name}: 행/열 또는 셀 제한으로 일부만 처리했습니다.`);
      const rows: string[][] = [];
      const formulas: { cell: string; formula: string; result: string; cachedResult: unknown }[] =
        [];
      let formulaLimitHit = false;
      const hiddenRows: number[] = [];
      const hiddenColumns: number[] = [];
      for (let rowIndex = 1; rowIndex <= maxRows; rowIndex += 1) {
        if (sheet.getRow(rowIndex).hidden) hiddenRows.push(rowIndex);
        const row: string[] = [];
        for (let columnIndex = 1; columnIndex <= maxColumns; columnIndex += 1) {
          const cell = sheet.getCell(rowIndex, columnIndex);
          row.push(cell.text);
          if (sheet.getColumn(columnIndex).hidden && !hiddenColumns.includes(columnIndex))
            hiddenColumns.push(columnIndex);
          if (isFormulaCell(cell.value)) {
            if (formulas.length < 10_000) {
              const formulaValue = cell.value as { formula: unknown; result?: unknown };
              formulas.push({
                cell: cell.address,
                formula: String(formulaValue.formula),
                result: cell.text,
                cachedResult: formulaValue.result ?? null,
              });
            } else formulaLimitHit = true;
          }
        }
        rows.push(row);
      }
      if (formulaLimitHit) warnings.push(`${sheet.name}: 수식 수 제한으로 일부만 처리했습니다.`);
      const header = rows[0] ?? [];
      const units = header.reduce<Record<string, string>>((result, value, index) => {
        const match = value.match(/(?:\(([^)]+)\)|\[([^\]]+)\]|\s+([%A-Za-z가-힣][^\s]*)\s*$)/);
        if (match) result[String(index + 1)] = match[1] ?? match[2] ?? match[3]!;
        return result;
      }, {});
      const merges = getWorksheetMerges(sheet);
      return {
        name: sheet.name,
        hidden: sheet.state !== 'visible',
        range: maxRows && maxColumns ? `A1:${sheet.getCell(maxRows, maxColumns).address}` : null,
        rows,
        formulas,
        formulaResults: formulas.map(({ cell, result, cachedResult }) => ({
          cell,
          result,
          cachedResult,
        })),
        header,
        units,
        hiddenRows,
        hiddenColumns,
        mergedRanges: merges,
      };
    });
    if (workbook.worksheets.length > 100) warnings.push('시트 수 제한으로 일부만 처리했습니다.');
    return {
      content: sheets,
      metadata: {
        sheetCount: workbook.worksheets.length,
        namedRanges: getNamedRanges(workbook),
      },
      warnings,
    };
  }
  if (ext === '.csv' || ext === '.txt' || ext === '.md') {
    if (bytes.includes(0)) throw new Error('Binary 파일로 판단되어 텍스트 추출을 중단했습니다.');
    const decoded = decodeText(bytes);
    const text = decoded.text;
    if (ext === '.csv') {
      const delimiter = detectDelimiter(text);
      const warnings: string[] = [];
      const parsed = parseCsv(text, {
        bom: true,
        delimiter,
        relaxColumnCount: true,
        skipEmptyLines: false,
        to: MAX_CSV_RECORDS + 1,
      }) as string[][];
      const truncatedRecords = parsed.length > MAX_CSV_RECORDS;
      const rows = parsed.slice(0, MAX_CSV_RECORDS).map((record) => {
        let fields = record;
        if (fields.length > MAX_CSV_FIELDS) {
          warnings.push('필드 수 제한으로 일부만 처리했습니다.');
          fields = fields.slice(0, MAX_CSV_FIELDS);
        }
        return fields.map((field) => {
          if (field.length <= MAX_CSV_FIELD_CHARS) return field;
          warnings.push('필드 크기 제한으로 일부만 처리했습니다.');
          return field.slice(0, MAX_CSV_FIELD_CHARS);
        });
      });
      if (truncatedRecords) warnings.push('레코드 수 제한으로 일부만 처리했습니다.');
      return {
        content: rows,
        metadata: {
          rowCount: rows.length,
          estimatedRowCount: estimateCsvRows(bytes),
          delimiter,
          encoding: decoded.encoding,
          supportedEncodings: ['utf-8', 'utf-8-bom'],
          cp949Supported: false,
          truncated: truncatedRecords || warnings.length > 0,
        },
        warnings: [...new Set(warnings)],
      };
    }
    const warnings =
      text.length > MAX_TEXT_CHARS ? ['텍스트 크기 제한으로 일부만 처리했습니다.'] : [];
    return {
      content: text.slice(0, MAX_TEXT_CHARS),
      metadata: {
        characterCount: Math.min(text.length, MAX_TEXT_CHARS),
        encoding: decoded.encoding,
        supportedEncodings: ['utf-8', 'utf-8-bom'],
        cp949Supported: false,
      },
      warnings,
    };
  }
  const dimensions = readImageDimensions(ext, bytes);
  return {
    content: null,
    metadata: {
      image: true,
      width: dimensions.width,
      height: dimensions.height,
      pixelCount: dimensions.width * dimensions.height,
    },
    warnings: [
      '이미지 분석은 선택한 Codex 모델의 이미지 입력 지원 여부에 따라 AI 작업 시 수행됩니다.',
    ],
  };
}

async function extractPdf(bytes: Buffer): Promise<ExtractResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (process.versions.electron && process.resourcesPath) {
    // PDF.js treats Electron as a browser-like runtime and therefore does not
    // install its Node default workerSrc. Point it at the worker bundled in
    // app.asar so utility-process PDF extraction remains self-contained.
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      path.join(process.resourcesPath, 'app.asar', 'out', 'main', 'pdf.worker.mjs'),
    ).href;
  }
  const pdf = await withTimeout(
    pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise,
    PDF_OPERATION_TIMEOUT_MS,
  );
  const warnings: string[] = [];
  if (pdf.numPages > MAX_PDF_PAGES) warnings.push('페이지 수 제한으로 일부만 처리했습니다.');
  const pages: {
    locator: string;
    text: string;
    pageHash: string;
    items: { text: string; bbox: [number, number, number, number] }[];
    textDensity: number;
  }[] = [];
  let total = 0;
  for (let i = 1; i <= Math.min(pdf.numPages, MAX_PDF_PAGES); i += 1) {
    try {
      const page = await withTimeout(pdf.getPage(i), PDF_OPERATION_TIMEOUT_MS);
      const text = await withTimeout(page.getTextContent(), PDF_OPERATION_TIMEOUT_MS);
      const viewport = page.getViewport({ scale: 1 });
      const items = text.items
        .filter(
          (item): item is typeof item & { str: string; transform: number[] } =>
            'str' in item && 'transform' in item && Array.isArray(item.transform),
        )
        .map((item) => {
          const x = Number(item.transform[4] ?? 0);
          const y = Number(item.transform[5] ?? 0);
          const width = Number('width' in item ? item.width : 0);
          const height = Number('height' in item ? item.height : 0);
          return { text: item.str, x, y, width, height };
        })
        // PDF coordinates originate at the lower-left. Sorting this way makes
        // the reading order explicit for multi-column/positioned text.
        .sort((a, b) => (Math.abs(a.y - b.y) > 4 ? b.y - a.y : a.x - b.x));
      let value = items.map((item) => item.text).join(' ');
      const remaining = MAX_PDF_TEXT - total;
      if (remaining <= 0) {
        warnings.push('PDF 텍스트 크기 제한으로 일부만 처리했습니다.');
        break;
      }
      if (value.length > remaining) {
        value = value.slice(0, remaining);
        warnings.push('PDF 텍스트 크기 제한으로 일부만 처리했습니다.');
      }
      total += value.trim().length;
      const pageItems = items.map((item) => ({
        text: item.text,
        bbox: [item.x, item.y, item.width, item.height] as [number, number, number, number],
      }));
      const area = Math.max(1, Number(viewport.width) * Number(viewport.height));
      const textDensity = value.trim().length / area;
      const pageHash = createHash('sha256')
        .update(JSON.stringify({ value, pageItems }))
        .digest('hex');
      if (!value.trim()) warnings.push(`page ${i}: 텍스트가 없어 OCR 또는 스캔 PDF일 수 있습니다.`);
      if (textDensity < 0.00005 && value.trim())
        warnings.push(`page ${i}: 텍스트 밀도가 낮아 레이아웃/스캔 품질을 확인하십시오.`);
      pages.push({ locator: `page ${i}`, text: value, pageHash, items: pageItems, textDensity });
    } catch (error) {
      warnings.push(
        error instanceof Error && error.message === 'PDF_TIMEOUT'
          ? 'PDF 페이지 처리 시간이 제한을 초과해 일부만 처리했습니다.'
          : `page ${i}: PDF 페이지를 처리하지 못했습니다.`,
      );
      break;
    }
  }
  if (total < Math.max(50, pages.length * 20))
    warnings.push('텍스트 추출 부족: 스캔 중심 PDF일 수 있습니다. OCR은 수행하지 않았습니다.');
  return {
    content: pages,
    metadata: {
      pageCount: pdf.numPages,
      readingOrder: 'top-to-bottom,left-to-right',
      pageHashes: pages.map((page) => ({ locator: page.locator, hash: page.pageHash })),
      textDensity: pages.map((page) => ({ locator: page.locator, value: page.textDensity })),
    },
    warnings: [...new Set(warnings)],
  };
}

function validateSignature(ext: string, bytes: Buffer): void {
  if (isImage(ext)) {
    readImageDimensions(ext, bytes);
    return;
  }
  if (ext === '.pdf' && !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')))
    throw new Error('SOURCE_SIGNATURE_MISMATCH');
  if (isOoxml(ext) && !isZipSignature(bytes)) throw new Error('SOURCE_SIGNATURE_MISMATCH');
}
async function preflightOoxml(bytes: Buffer, ext: string): Promise<void> {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const allEntries = Object.values(zip.files);
  if (allEntries.length > MAX_ZIP_ENTRIES) throw new Error('압축 항목 수 제한을 초과했습니다.');
  const names = allEntries.map((entry) => entry.unsafeOriginalName ?? entry.name);
  for (const name of names) {
    const normalized = name.replaceAll('\\', '/');
    if (
      normalized.startsWith('/') ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split('/').includes('..')
    )
      throw new Error('압축 경로 traversal이 감지되었습니다.');
  }
  const requiredPrefix = ext === '.docx' ? 'word/' : ext === '.pptx' ? 'ppt/' : 'xl/';
  if (!names.some((name) => name.replaceAll('\\', '/').startsWith(requiredPrefix)))
    throw new Error('SOURCE_SIGNATURE_MISMATCH');
  const entries = allEntries.filter((entry) => !entry.dir);
  let expanded = 0;
  for (const entry of entries) {
    const data =
      (entry as unknown as { _data?: { uncompressedSize?: number; compressedSize?: number } })
        ._data ?? {};
    const single = Number(data.uncompressedSize ?? 0);
    const compressed = Number(data.compressedSize ?? 0);
    if (!Number.isFinite(single) || !Number.isFinite(compressed) || single < 0 || compressed < 0)
      throw new Error('압축 항목 크기 메타데이터가 올바르지 않습니다.');
    if (single > MAX_ZIP_SINGLE_ENTRY_BYTES)
      throw new Error('단일 압축 항목 크기 제한을 초과했습니다.');
    if (compressed === 0 ? single > 0 : single / compressed > MAX_ZIP_RATIO)
      throw new Error('압축 해제 비율 제한을 초과했습니다.');
    expanded += single;
    if (expanded > MAX_ZIP_EXPANDED_BYTES) throw new Error('압축 해제 크기 제한을 초과했습니다.');
  }
}
function readImageDimensions(ext: string, bytes: Buffer): { width: number; height: number } {
  let width = 0;
  let height = 0;
  if (
    ext === '.png' &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.length >= 24
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (
    (ext === '.jpg' || ext === '.jpeg') &&
    bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
  ) {
    for (let offset = 2; offset + 9 < bytes.length;) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        height = bytes.readUInt16BE(offset + 5);
        width = bytes.readUInt16BE(offset + 7);
        break;
      }
      offset += length + 2;
    }
  } else if (
    ext === '.webp' &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const kind = bytes.subarray(12, 16).toString('ascii');
    if (kind === 'VP8X' && bytes.length >= 30) {
      width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
      height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    } else if (kind === 'VP8L' && bytes.length >= 25) {
      const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
      width = 1 + (bits & 0x3fff);
      height = 1 + ((bits >>> 14) & 0x3fff);
    } else if (
      kind === 'VP8 ' &&
      bytes.length >= 30 &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    }
  }
  if (!width || !height) throw new Error('SOURCE_SIGNATURE_MISMATCH');
  if (
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  )
    throw new Error('이미지 dimension/pixel 제한을 초과했습니다.');
  return { width, height };
}
function isImage(ext: string): boolean {
  return ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp';
}
function isOoxml(ext: string): boolean {
  return ext === '.docx' || ext === '.pptx' || ext === '.xlsx';
}
function isZipSignature(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7) &&
    (bytes[3] === 4 || bytes[3] === 6 || bytes[3] === 8)
  );
}
function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type DocxBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; rows: string[][] };

function extractDocxBlocks(html: string, limit: number, warnings: string[]): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  const pattern = /<(h[1-6]|p|ul|ol|table)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let consumed = 0;
  for (const match of html.matchAll(pattern)) {
    const tag = (match[1] ?? '').toLowerCase();
    const body = match[2] ?? '';
    let block: DocxBlock | undefined;
    if (/^h[1-6]$/.test(tag)) {
      block = { type: 'heading', level: Number(tag.slice(1)), text: stripTags(body) };
    } else if (tag === 'p') {
      block = { type: 'paragraph', text: stripTags(body) };
    } else if (tag === 'ul' || tag === 'ol') {
      const items = [...body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
        .map((item) => stripTags(item[1] ?? ''))
        .filter(Boolean);
      block = { type: 'list', ordered: tag === 'ol', items };
    } else if (tag === 'table') {
      const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
        [...(row[1] ?? '').matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) =>
          stripTags(cell[1] ?? ''),
        ),
      );
      block = { type: 'table', rows };
    }
    if (!block) continue;
    const blockText =
      block.type === 'table'
        ? block.rows.flat().join(' ')
        : block.type === 'list'
          ? block.items.join(' ')
          : block.text;
    if (!blockText && block.type !== 'table') continue;
    if (consumed + blockText.length > limit) {
      warnings.push('문서 추출 문자 수 제한으로 일부만 처리했습니다.');
      break;
    }
    consumed += blockText.length;
    blocks.push(block);
  }
  if (!blocks.length) {
    const fallback = stripTags(html).slice(0, limit);
    if (fallback) blocks.push({ type: 'paragraph', text: fallback });
  }
  return blocks;
}

function blocksToText(blocks: DocxBlock[]): string {
  return blocks
    .map((block) =>
      block.type === 'table'
        ? block.rows.map((row) => row.join(' | ')).join('\n')
        : block.type === 'list'
          ? block.items.join('\n')
          : block.text,
    )
    .join('\n');
}

function isFormulaCell(value: unknown): value is { formula: unknown; result?: unknown } {
  return typeof value === 'object' && value !== null && 'formula' in value;
}

function getWorksheetMerges(sheet: unknown): string[] {
  const model = (sheet as { model?: { merges?: unknown } }).model;
  return Array.isArray(model?.merges)
    ? model.merges.filter((merge): merge is string => typeof merge === 'string')
    : [];
}

function getNamedRanges(workbook: unknown): { name: string; ranges: string[] }[] {
  const names = (workbook as { definedNames?: { model?: unknown[] } }).definedNames?.model;
  if (!Array.isArray(names)) return [];
  return names
    .filter(
      (entry): entry is { name: string; ranges?: unknown[] } =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as { name?: unknown }).name === 'string',
    )
    .map((entry) => ({
      name: entry.name,
      ranges: Array.isArray(entry.ranges)
        ? entry.ranges.filter((range): range is string => typeof range === 'string')
        : [],
    }));
}
function extractOpenXmlText(xml: string): string {
  return [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)]
    .map((match) => decodeEntities(match[1] ?? ''))
    .join('\n');
}

interface PptxShape {
  type: 'shape';
  text: string;
  placeholder?: string;
  bbox?: { x: number; y: number; width: number; height: number };
}

function extractPptxSlide(xml: string): {
  text: string;
  shapes: PptxShape[];
  tables: string[][][];
} {
  const shapes: PptxShape[] = [];
  for (const match of xml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/gi)) {
    const body = match[1] ?? '';
    const text = extractOpenXmlText(body);
    if (!text) continue;
    const placeholder = body.match(/<p:ph\b[^>]*\btype="([^"]+)"/i)?.[1];
    const bbox = readPptxBbox(body);
    shapes.push({
      ...(placeholder ? { placeholder } : {}),
      type: 'shape',
      text,
      ...(bbox ? { bbox } : {}),
    });
  }
  const tables: string[][][] = [];
  for (const graphic of xml.matchAll(/<p:graphicFrame\b[^>]*>([\s\S]*?)<\/p:graphicFrame>/gi)) {
    const body = graphic[1] ?? '';
    if (!/<a:tbl\b/i.test(body)) continue;
    const rows = [...body.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/gi)].map((row) =>
      [...(row[1] ?? '').matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/gi)].map((cell) =>
        extractOpenXmlText(cell[1] ?? ''),
      ),
    );
    if (rows.length) tables.push(rows);
  }
  return { text: extractOpenXmlText(xml), shapes, tables };
}

function readPptxBbox(
  xml: string,
): { x: number; y: number; width: number; height: number } | undefined {
  const off = xml.match(/<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/i);
  const ext = xml.match(/<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/i);
  if (!off || !ext) return undefined;
  return { x: Number(off[1]), y: Number(off[2]), width: Number(ext[1]), height: Number(ext[2]) };
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
function decodeText(bytes: Buffer): { text: string; encoding: 'utf-8' | 'utf-8-bom' } {
  const hasBom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const utf8 = bytes.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) ?? []).length;
  if (bad > Math.max(2, utf8.length * 0.01))
    throw new Error(
      'CSV_ENCODING_UNSUPPORTED_CP949: UTF-8만 지원합니다. CP949/EUC-KR 파일은 UTF-8로 저장 후 다시 시도하십시오.',
    );
  return { text: utf8.replace(/^\uFEFF/, ''), encoding: hasBom ? 'utf-8-bom' : 'utf-8' };
}
function estimateCsvRows(bytes: Buffer): number {
  // A cheap upper bound that does not parse untrusted CSV twice. Quoted newlines
  // mean this is deliberately labelled an estimate in metadata.
  let rows = 0;
  for (const byte of bytes) if (byte === 0x0a) rows += 1;
  return rows + (bytes.length && bytes[bytes.length - 1] !== 0x0a ? 1 : 0);
}
function detectDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  const counts = new Map<string, number>([
    [',', 0],
    ['\t', 0],
    [';', 0],
    ['|', 0],
  ]);
  let quoted = false;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === '"') {
      if (quoted && sample[i + 1] === '"') i += 1;
      else quoted = !quoted;
    } else if (!quoted && counts.has(sample[i]!))
      counts.set(sample[i]!, (counts.get(sample[i]!) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ',';
}
async function copyWithHash(input: string, output: string): Promise<CopyResult> {
  const hash = createHash('sha256');
  let size = 0;
  const counting = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_SOURCE_BYTES) {
        callback(new Error('SOURCE_FILE_TOO_LARGE'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(createReadStream(input), counting, createWriteStream(output, { flags: 'wx' }));
  return { size, sha256: hash.digest('hex') };
}

/** Copy once into a content-addressed location. A temporary stream prevents a
 * partially written blob from ever becoming visible as a valid cache hit. */
async function materializeBlob(input: string, blobRoot: string): Promise<CopyResult> {
  const temporary = path.join(blobRoot, `.upload-${randomUUID()}.tmp`);
  try {
    const copied = await copyWithHash(input, temporary);
    const target = path.join(blobRoot, copied.sha256);
    try {
      await stat(target);
      await rm(temporary, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await rename(temporary, target);
    }
    return copied;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

interface CachedExtraction {
  content: unknown;
  metadata: Record<string, unknown>;
  warnings: string[];
}

async function readCachedExtraction(
  filePath: string,
  sourceHash: string,
): Promise<CachedExtraction | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Partial<CachedExtraction>;
    if (!value.metadata || typeof value.metadata !== 'object' || !Array.isArray(value.warnings))
      return null;
    const provenance = (value.metadata as Record<string, unknown>).provenance;
    if (!provenance || typeof provenance !== 'object') return null;
    const p = provenance as Record<string, unknown>;
    if (p.sourceHash !== sourceHash || p.extractorVersion !== EXTRACTOR_VERSION) return null;
    return {
      content: value.content,
      metadata: value.metadata as Record<string, unknown>,
      warnings: value.warnings.filter((warning): warning is string => typeof warning === 'string'),
    };
  } catch {
    // A corrupt/incomplete cache is not an import failure; the bounded parser
    // will regenerate it using the current extractor version.
    return null;
  }
}
async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('PDF_TIMEOUT')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
