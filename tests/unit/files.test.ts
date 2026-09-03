import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  contentHash,
  readJson,
  readJsonOrQuarantine,
  resolveWithin,
  safeFilename,
  sanitizeReportHtml,
} from '../../src/main/services/files.js';
import { buildReportDocument } from '../../src/main/exporters/report-theme.js';

describe('secure file and HTML utilities', () => {
  it('removes active HTML and unsafe attributes', () => {
    const clean = sanitizeReportHtml(
      '<h1 onclick="x()">제목</h1><script>alert(1)</script><iframe src="x"></iframe><p style="color:red">본문</p>',
    );
    expect(clean).toBe('<h1>제목</h1><p>본문</p>');
  });
  it('sanitizes Windows filenames and reserved names', () => {
    expect(safeFilename('a:b?.html')).toBe('a_b_.html');
    expect(safeFilename('CON')).toBe('report');
    expect(safeFilename('제목. ')).toBe('제목');
  });
  it('rejects path traversal', () => {
    const root = path.resolve('safe');
    expect(() => resolveWithin(root, '..', 'outside')).toThrow('PATH_TRAVERSAL');
    expect(resolveWithin(root, 'inside')).toContain('inside');
  });
  it('uses fallback only for ENOENT and quarantines corrupt JSON', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lg-agent-json-'));
    try {
      const missing = path.join(root, 'missing.json');
      expect(await readJson(missing, { ok: true })).toEqual({ ok: true });
      const corrupt = path.join(root, 'bootstrap.json');
      await writeFile(corrupt, '{not-json');
      expect(await readJsonOrQuarantine(corrupt, { ok: true })).toEqual({ ok: true });
      expect(await readdir(root)).toHaveLength(1);
      expect((await readdir(root))[0]).toContain('bootstrap.json.corrupt-');
      await expect(readJson(corrupt, { ok: true })).resolves.toEqual({ ok: true });
      // The original name is now absent; ENOENT is the only ordinary default path.
      expect(await readFile(path.join(root, (await readdir(root))[0]!), 'utf8')).toBe('{not-json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('creates stable SHA-256 hashes', () => {
    expect(contentHash('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
  it('builds a styled offline report document with print rules', () => {
    const html = buildReportDocument({
      title: '품질 검토 보고서',
      body: '<h2>요약</h2><table><thead><tr><th>항목</th></tr></thead></table>',
      fontBase64: 'AA==',
      a4: true,
    });
    expect(html).toContain('<main class="report-sheet">');
    expect(html).toContain('<h1>품질 검토 보고서</h1>');
    expect(html).toContain('--report-accent: #a50034');
    expect(html).toContain('thead th');
    expect(html).toContain('@media print');
    expect(html).toContain('@page { size: A4 portrait; margin: 16mm; }');
    expect(html).toContain('Content-Security-Policy');
    expect(html).not.toContain('<script');
  });
  it('does not duplicate an existing report title heading', () => {
    const html = buildReportDocument({
      title: '외부 제목',
      body: '<h1>본문 제목</h1><p>내용</p>',
      fontBase64: 'AA==',
      a4: false,
    });
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('@page { size: auto; margin: 12mm; }');
  });
});
