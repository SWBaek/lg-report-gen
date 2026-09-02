import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import spawn from 'cross-spawn';

export interface ResolvedCodex {
  path: string;
  version: string;
}
export async function resolveCodexExecutable(
  configuredPath?: string | null,
): Promise<ResolvedCodex | null> {
  const candidates: string[] = [];
  if (configuredPath) candidates.push(configuredPath);
  if (process.platform === 'win32') {
    const where = await runCapture('where.exe', ['codex'], 3000).catch(() => null);
    if (where?.stdout) candidates.push(...where.stdout.split(/\r?\n/).filter(Boolean));
  }
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter);
  for (const entry of pathEntries) {
    if (entry)
      candidates.push(
        path.join(entry, process.platform === 'win32' ? 'codex.exe' : 'codex'),
        path.join(entry, process.platform === 'win32' ? 'codex.cmd' : 'codex'),
      );
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    const roaming = process.env.APPDATA;
    if (local) candidates.push(path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
    if (roaming)
      candidates.push(
        path.join(roaming, 'npm', 'codex.cmd'),
        path.join(roaming, 'npm', 'codex.exe'),
      );
  }
  for (const candidate of [...new Set(candidates.map((item) => path.resolve(item)))]) {
    if (!(await isExecutable(candidate))) continue;
    const result = await runCapture(candidate, ['--version'], 5000).catch(() => null);
    if (result?.code === 0 && result.stdout.trim())
      return { path: candidate, version: result.stdout.trim() };
  }
  return null;
}
async function isExecutable(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
export function runCapture(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('CODEX_REQUEST_TIMEOUT'));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 100_000) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 100_000) stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: redact(stderr), code });
    });
  });
}
export function redact(value: string): string {
  return value
    .replace(/[A-Za-z0-9_-]{30,}/g, '[REDACTED]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[MASKED_EMAIL]')
    .slice(0, 4000);
}
