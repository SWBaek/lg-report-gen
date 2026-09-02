import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ensureWorkspace } from '../../src/main/workspace/manager.js';
import { SourceImporter } from '../../src/main/importers/source-importer.js';

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
  }, 30_000);
  it('rejects binary text and records a safe failure', async () => {
    const fixture = await importer();
    const file = path.join(fixture.root, 'bad.txt');
    await writeFile(file, Buffer.from([0, 1, 2, 3]));
    const [source] = await fixture.importer.import(fixture.reportId, [file]);
    expect(source?.extractionStatus).toBe('failed');
    expect(source?.warnings[0]).toContain('Binary');
  });
});
