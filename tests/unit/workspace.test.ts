import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ensureWorkspace,
  inspectWorkspacePolicy,
  isUncPath,
  pathsFor,
  verifyWorkspacePath,
} from '../../src/main/workspace/manager.js';

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

  it('rejects UNC workspaces before creating files', async () => {
    expect(isUncPath('\\\\server\\share\\reports')).toBe(true);
    expect((await inspectWorkspacePolicy('\\\\server\\share\\reports')).storage).toBe('remote');
    await expect(ensureWorkspace('\\\\server\\share\\reports')).rejects.toThrow(
      'WORKSPACE_REMOTE_UNSUPPORTED',
    );
  });

  it('reports synchronized folders and can apply an explicit blocking policy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lg-policy-'));
    created.push(root);
    const syncRoot = path.join(root, 'OneDrive - Internal');
    await mkdir(syncRoot);
    const policy = await inspectWorkspacePolicy(syncRoot);
    expect(policy.synchronized).toBe(true);
    expect(policy.warnings).toContain('WORKSPACE_SYNC_FOLDER');
    await expect(ensureWorkspace(syncRoot, { rejectSynchronizedFolder: true })).rejects.toThrow(
      'WORKSPACE_SYNC_FOLDER_UNSUPPORTED',
    );
  });

  it('detects a synchronized target behind a junction or symlink', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lg-policy-link-'));
    created.push(root);
    const target = path.join(root, 'Dropbox');
    const alias = path.join(root, 'workspace-alias');
    await mkdir(target);
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await inspectWorkspacePolicy(alias)).synchronized).toBe(true);
  });

  it('rejects workspace paths that escape through a junction or symlink', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lg-policy-containment-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lg-policy-outside-'));
    created.push(root, outside);
    const alias = path.join(root, 'alias');
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(
      verifyWorkspacePath(pathsFor(root), path.join(alias, 'report.html'), {
        allowMissing: true,
      }),
    ).rejects.toThrow('PATH_SYMLINK');
  });

  it('rejects overlong workspace selections before touching the filesystem', async () => {
    const root = path.join(os.tmpdir(), 'a'.repeat(1025));
    await expect(ensureWorkspace(root)).rejects.toThrow('WORKSPACE_NOT_SELECTED');
  });
});
