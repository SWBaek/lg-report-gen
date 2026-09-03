import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Report } from '../../src/shared/types/index.js';
import { preflightReportExport } from '../../src/main/exporters/html-exporter.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});

function report(root: string, html: string): Report {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    html,
    contentPath: path.join(root, 'report.html'),
  } as unknown as Report;
}

describe('export preflight security', () => {
  it('reports external, missing, unsupported, invalid and overflowing assets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lg-export-preflight-'));
    roots.push(root);
    await writeFile(path.join(root, 'not-an-image.png'), 'not an image');
    const result = await preflightReportExport(
      report(
        root,
        '<img src="https://example.com/remote.png"><img src="missing.png"><img src="icon.svg"><img src="not-an-image.png"><table><tr><td>내용</td></tr></table>',
      ),
      { format: 'pdf' },
    );

    expect(result.canExport).toBe(true);
    expect(result.format).toBe('pdf');
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        'EXTERNAL_ASSET',
        'MISSING_ASSET',
        'UNSUPPORTED_IMAGE',
        'INVALID_IMAGE_MIME',
        'PAGE_OVERFLOW_POSSIBLE',
      ]),
    );
  });
});
