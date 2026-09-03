import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ensureWorkspace } from '../../src/main/workspace/manager.js';
import { SourceImporter } from '../../src/main/importers/source-importer.js';
import { ParserSupervisor } from '../../src/main/importers/parser-supervisor.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});
async function importer() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lg-source-'));
  roots.push(root);
  const paths = await ensureWorkspace(root);
  const reportId = '11111111-1111-4111-8111-111111111111';
  return { root, reportId, importer: new SourceImporter(paths) };
}
describe('source extraction', () => {
  it('preserves PDF page locators', async () => {
    const fixture = await importer();
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    for (const text of ['Page one evidence', 'Page two result']) {
      const page = pdf.addPage();
      page.drawText(text, { x: 50, y: 700, font });
    }
    const file = path.join(fixture.root, 'evidence.pdf');
    await writeFile(file, await pdf.save());
    const [source] = await fixture.importer.import(fixture.reportId, [file]);
    expect(source?.metadata.pageCount).toBe(2);
    const extracted = JSON.parse(await readFile(source!.extractedPath!, 'utf8')) as {
      content: { locator: string }[];
    };
    expect(extracted.content.map((p) => p.locator)).toEqual(['page 1', 'page 2']);
  }, 30_000);
  it('keeps PPTX numeric slide order and XLSX sheet/formula mapping', async () => {
    const fixture = await importer();
    const zip = new JSZip();
    zip.file('ppt/slides/slide10.xml', '<a:t>ten</a:t>');
    zip.file('ppt/slides/slide2.xml', '<a:t>two</a:t>');
    const ppt = path.join(fixture.root, 'slides.pptx');
    await writeFile(ppt, await zip.generateAsync({ type: 'nodebuffer' }));
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Summary');
    sheet.addRow([1, 2]);
    sheet.addRow(['sum', { formula: 'A1+B1', result: 3 }]);
    const xlsx = path.join(fixture.root, 'book.xlsx');
    await book.xlsx.writeFile(xlsx);
    const [pptSource, xlsxSource] = await fixture.importer.import(fixture.reportId, [ppt, xlsx]);
    const pptData = JSON.parse(await readFile(pptSource!.extractedPath!, 'utf8')) as {
      content: { locator: string }[];
    };
    expect(pptData.content.map((s) => s.locator)).toEqual(['slide 2', 'slide 10']);
    expect(xlsxSource?.metadata.sheetCount).toBe(1);
    const xlsxData = JSON.parse(await readFile(xlsxSource!.extractedPath!, 'utf8')) as {
      content: {
        formulas: { cell: string; result: string; cachedResult: unknown }[];
        header: string[];
        mergedRanges: string[];
      }[];
    };
    expect(xlsxData.content[0]?.formulas[0]).toMatchObject({
      cell: 'B2',
      result: '3',
      cachedResult: 3,
    });
  }, 30_000);
  it('rejects binary text and records a safe failure', async () => {
    const fixture = await importer();
    const file = path.join(fixture.root, 'bad.txt');
    await writeFile(file, Buffer.from([0, 1, 2, 3]));
    const [source] = await fixture.importer.import(fixture.reportId, [file]);
    expect(source?.extractionStatus).toBe('failed');
    expect(source?.warnings[0]).toContain('Binary');
  });

  it('preserves previous manifest entries and extracts quoted multi-line CSV records', async () => {
    const fixture = await importer();
    const first = path.join(fixture.root, 'first.txt');
    const second = path.join(fixture.root, 'second.csv');
    await writeFile(first, 'first source');
    await writeFile(second, 'name;note\nAlice;"line one\nline two"\nBob;ok\n');
    const firstResult = await fixture.importer.import(fixture.reportId, [first]);
    const secondResult = await fixture.importer.import(fixture.reportId, [second]);
    const manifestPath = path.join(
      fixture.root,
      'reports',
      fixture.reportId,
      'source-manifest.json',
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      sources: { sourceId: string }[];
    };
    expect(manifest.sources.map((source) => source.sourceId)).toEqual([
      firstResult[0]!.sourceId,
      secondResult[0]!.sourceId,
    ]);
    const extracted = JSON.parse(await readFile(secondResult[0]!.extractedPath!, 'utf8')) as {
      content: string[][];
      metadata: { delimiter: string; provenance: { sourceHash: string; extractor: string } };
    };
    expect(extracted.metadata.delimiter).toBe(';');
    expect(extracted.content[1]).toEqual(['Alice', 'line one\nline two']);
    expect(extracted.metadata.provenance.extractor).toBe('source-importer');
    expect(extracted.metadata.provenance.sourceHash).toBe(secondResult[0]!.sha256);
    expect(secondResult[0]!.metadata.evidenceLocator).toMatch(/^evidence\//);
    expect(secondResult[0]!.metadata.derivedLocator).toMatch(/^derived\//);
    expect(secondResult[0]!.metadata.agentWorkOriginal).toBeUndefined();
    expect(secondResult[0]!.metadata.agentWorkExtracted).toBeUndefined();
  });

  it('reuses a content-addressed blob and extraction snapshot for duplicate bytes', async () => {
    const fixture = await importer();
    const first = path.join(fixture.root, 'first.txt');
    const second = path.join(fixture.root, 'renamed.txt');
    await writeFile(first, 'same source bytes');
    await writeFile(second, 'same source bytes');
    const [firstResult] = await fixture.importer.import(fixture.reportId, [first]);
    const [secondResult] = await fixture.importer.import(fixture.reportId, [second]);
    expect(secondResult?.sourceId).toBe(firstResult?.sourceId);
    expect(secondResult?.storedPath).toBe(firstResult?.storedPath);
    expect(secondResult?.metadata.extractionReused).toBe(true);
    const manifest = JSON.parse(
      await readFile(
        path.join(fixture.root, 'reports', fixture.reportId, 'source-manifest.json'),
        'utf8',
      ),
    ) as { sources: unknown[] };
    expect(manifest.sources).toHaveLength(1);
  });

  it('retains PPTX shape bounds, table rows, and speaker notes', async () => {
    const fixture = await importer();
    const zip = new JSZip();
    zip.file(
      'ppt/slides/slide1.xml',
      '<p:sp><p:nvSpPr><p:ph type="title"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="10" y="20"/><a:ext cx="300" cy="400"/></a:xfrm></p:spPr><p:txBody><a:t>Title</a:t></p:txBody></p:sp><p:graphicFrame><a:tbl><a:tr><a:tc><a:t>Header</a:t></a:tc></a:tr><a:tr><a:tc><a:t>Value</a:t></a:tc></a:tr></a:tbl></p:graphicFrame>',
    );
    zip.file('ppt/notesSlides/notesSlide1.xml', '<a:t>Presenter note</a:t>');
    const file = path.join(fixture.root, 'deck.pptx');
    await writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    const [source] = await fixture.importer.import(fixture.reportId, [file]);
    const extracted = JSON.parse(await readFile(source!.extractedPath!, 'utf8')) as {
      content: {
        shapes: { text: string; bbox?: { x: number } }[];
        tables: string[][][];
        notes: string;
      }[];
    };
    expect(extracted.content[0]?.shapes[0]?.text).toBe('Title');
    expect(extracted.content[0]?.shapes[0]?.bbox?.x).toBe(10);
    expect(extracted.content[0]?.tables[0]).toEqual([['Header'], ['Value']]);
    expect(extracted.content[0]?.notes).toBe('Presenter note');
  });

  it('records signature and OOXML zip traversal failures without extracting content', async () => {
    const fixture = await importer();
    const wrongPdf = path.join(fixture.root, 'not-a-pdf.pdf');
    await writeFile(wrongPdf, 'plain text');
    const traversalZip = new JSZip();
    traversalZip.file('../ppt/slides/slide1.xml', '<a:t>unsafe</a:t>');
    const traversal = path.join(fixture.root, 'traversal.pptx');
    await writeFile(traversal, await traversalZip.generateAsync({ type: 'nodebuffer' }));
    const [pdfSource, zipSource] = await fixture.importer.import(fixture.reportId, [
      wrongPdf,
      traversal,
    ]);
    expect(pdfSource?.extractionStatus).toBe('failed');
    expect(pdfSource?.warnings[0]).toContain('SIGNATURE');
    expect(zipSource?.extractionStatus).toBe('failed');
    expect(zipSource?.warnings[0]).toContain('traversal');
  });

  it('rejects images whose declared pixel dimensions exceed the safety bound', async () => {
    const fixture = await importer();
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
    png.writeUInt32BE(20_001, 16);
    png.writeUInt32BE(1, 20);
    const file = path.join(fixture.root, 'oversized.png');
    await writeFile(file, png);
    const [source] = await fixture.importer.import(fixture.reportId, [file]);
    expect(source?.extractionStatus).toBe('failed');
    expect(source?.warnings[0]).toContain('dimension');
  });
});

describe('parser process isolation', () => {
  async function parserFixture(
    worker: string,
    options: ConstructorParameters<typeof ParserSupervisor>[0] = {},
  ) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lg-parser-'));
    roots.push(root);
    const input = path.join(root, 'input.txt');
    await writeFile(input, 'safe input');
    return new ParserSupervisor({
      workerPath: path.join(process.cwd(), 'tests/integration/fixtures', worker),
      ...options,
    }).run(input, '.txt', root);
  }

  it('kills a parser that exceeds the hard timeout', async () => {
    await expect(parserFixture('parser-timeout.mjs', { timeoutMs: 100 })).rejects.toThrow(
      'PARSER_TIMEOUT',
    );
  });

  it('contains worker crashes', async () => {
    await expect(parserFixture('parser-crash.mjs', { timeoutMs: 2_000 })).rejects.toThrow(
      'PARSER_CRASH',
    );
  });

  it('rejects malformed worker results', async () => {
    await expect(parserFixture('parser-malformed.mjs')).rejects.toThrow('PARSER_RESULT_INVALID');
  });

  it('rejects oversized worker results before accepting them', async () => {
    await expect(
      parserFixture('parser-large-result.mjs', { maxResultBytes: 1_024 }),
    ).rejects.toThrow('PARSER_RESULT_TOO_LARGE');
  });

  it('supports cancellation through AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();
    const root = await mkdtemp(path.join(os.tmpdir(), 'lg-parser-abort-'));
    roots.push(root);
    const input = path.join(root, 'input.txt');
    await writeFile(input, 'safe input');
    await expect(
      new ParserSupervisor({
        workerPath: path.join(process.cwd(), 'tests/integration/fixtures/parser-timeout.mjs'),
      }).run(input, '.txt', root, undefined, controller.signal),
    ).rejects.toThrow('PARSER_ABORTED');
  });
});
