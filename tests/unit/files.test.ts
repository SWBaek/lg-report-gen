import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  contentHash,
  resolveWithin,
  safeFilename,
  sanitizeReportHtml,
} from '../../src/main/services/files.js';

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
  it('creates stable SHA-256 hashes', () => {
    expect(contentHash('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});
