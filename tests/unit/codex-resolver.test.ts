import { afterEach, describe, expect, it } from 'vitest';
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  inspectAuthenticodeSignature,
  isSupportedCodexVersion,
  resolveCodexExecutable,
  resolveCodexExecutableWithDiagnostics,
} from '../../src/main/codex/executable-resolver.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});

describe('Codex executable trust policy', () => {
  it('checks the supported version range', () => {
    expect(isSupportedCodexVersion('codex-cli 0.1.0')).toBe(true);
    expect(isSupportedCodexVersion('codex-cli 99.0.0-test')).toBe(true);
    expect(isSupportedCodexVersion('codex-cli 0.0.9')).toBe(false);
    expect(isSupportedCodexVersion('codex-cli next')).toBe(false);
  });

  it('does not silently fall back when an explicit path fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-resolver-'));
    roots.push(root);
    const configured = path.join(root, 'missing-codex');
    const result = await resolveCodexExecutableWithDiagnostics(configured);
    expect(result.executable).toBeNull();
    expect(result.errorCode).toBe('CODEX_CONFIGURED_PATH_INVALID');
    await expect(resolveCodexExecutable(configured)).resolves.toBeNull();
  });

  it('provides a SHA-256 diagnostic for the selected executable', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-resolver-'));
    roots.push(root);
    const executable = path.join(root, 'codex');
    await writeFile(executable, '#!/bin/sh\nprintf "codex-cli 1.0.0\\n"\n');
    await chmod(executable, 0o755);
    const result = await resolveCodexExecutableWithDiagnostics(executable);
    expect(result.executable?.path).toBe(executable);
    expect(result.diagnostics?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.diagnostics?.hash).toBe(result.diagnostics?.sha256);
    expect(result.diagnostics?.signatureStatus).toBe('NotApplicable');
  });

  it('resolves the integration fixture version format', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-resolver-'));
    roots.push(root);
    const executable = path.join(root, 'codex.cjs');
    await copyFile(path.resolve('tests/fixtures/mock-codex.cjs'), executable);
    await chmod(executable, 0o755);
    const result = await resolveCodexExecutableWithDiagnostics(executable);
    expect(result.executable).not.toBeNull();
  });

  it('passes an Authenticode target with spaces and shell metacharacters safely', async () => {
    if (process.platform !== 'win32') return;
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex resolver & signature-'));
    roots.push(root);
    const executable = path.join(root, 'unsigned codex & fixture.ps1');
    await writeFile(executable, 'Write-Output test');

    const result = await inspectAuthenticodeSignature(executable);

    expect(result.status).toBe('NotSigned');
    expect(result.signer).toBeNull();
    expect(result.trusted).toBe(false);
  });
});
