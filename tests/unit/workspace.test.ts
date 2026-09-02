import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureWorkspace, pathsFor } from '../../src/main/workspace/manager.js';

const created: string[] = [];
afterEach(async () => {
  for (const item of created) await rm(item, { recursive: true, force: true });
  created.length = 0;
});
describe('workspace layout', () => {
  it('creates a writable Unicode workspace layout', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), '보고서 workspace '));
    created.push(root);
    const paths = await ensureWorkspace(root);
    expect(paths.database).toContain('.lg-report-agent');
    expect(
      JSON.parse(await readFile(path.join(paths.internal, 'workspace.json'), 'utf8')),
    ).toMatchObject({ format: 1 });
    expect(pathsFor(root).reports).toBe(path.join(path.resolve(root), 'reports'));
  });
});
