import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import spawn from 'cross-spawn';

export interface ResolvedCodex {
  path: string;
  version: string;
}

/** Details retained for local diagnostics, separate from the provider contract. */
export interface CodexExecutableDiagnostics extends ResolvedCodex {
  /** SHA-256 digest; `sha256` is retained as an explicit, self-describing alias. */
  hash: string;
  sha256: string;
  signer: string | null;
  signatureStatus: string;
}
export type CodexExecutableResolutionErrorCode =
  'CODEX_CONFIGURED_PATH_INVALID' | 'CODEX_VERSION_UNSUPPORTED' | 'CODEX_SIGNATURE_UNTRUSTED';
export interface CodexExecutableResolution {
  executable: ResolvedCodex | null;
  diagnostics: CodexExecutableDiagnostics | null;
  errorCode: CodexExecutableResolutionErrorCode | null;
}
/** The publisher policy is intentionally narrow and is not user supplied. */
export const CODEX_EXPECTED_PUBLISHER = 'OpenAI';
export const CODEX_MIN_VERSION = '0.1.0';
/** Do not trust a future incompatible major without an explicit code change. */
export const CODEX_MAX_MAJOR = 99;
let lastDiagnostics: CodexExecutableDiagnostics | null = null;
export function getLastCodexExecutableDiagnostics(): CodexExecutableDiagnostics | null {
  return lastDiagnostics ? { ...lastDiagnostics } : null;
}

export async function resolveCodexExecutable(
  configuredPath?: string | null,
): Promise<ResolvedCodex | null> {
  return (await resolveCodexExecutableWithDiagnostics(configuredPath)).executable;
}

/** A configured path is authoritative; no PATH fallback is attempted on failure. */
export async function resolveCodexExecutableWithDiagnostics(
  configuredPath?: string | null,
): Promise<CodexExecutableResolution> {
  const candidates: string[] = [];
  const configured = configuredPath?.trim() || null;
  if (configured) candidates.push(configured);
  if (!configured && process.platform === 'win32') {
    const where = await runCapture('where.exe', ['codex'], 3000).catch(() => null);
    if (where?.stdout) candidates.push(...where.stdout.split(/\r?\n/).filter(Boolean));
  }
  if (!configured) {
    const pathEntries = (process.env.PATH ?? '').split(path.delimiter);
    for (const entry of pathEntries) {
      if (entry)
        candidates.push(
          path.join(entry, process.platform === 'win32' ? 'codex.exe' : 'codex'),
          path.join(entry, process.platform === 'win32' ? 'codex.cmd' : 'codex'),
        );
    }
  }
  if (!configured && process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    const roaming = process.env.APPDATA;
    if (local) candidates.push(path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
    if (roaming)
      candidates.push(
        path.join(roaming, 'npm', 'codex.cmd'),
        path.join(roaming, 'npm', 'codex.exe'),
      );
  }
  let sawConfiguredFailure = false;
  let lastErrorCode: CodexExecutableResolutionErrorCode | null = null;
  for (const candidate of [...new Set(candidates.map((item) => path.resolve(item)))]) {
    if (!(await isExecutable(candidate))) {
      if (configured) sawConfiguredFailure = true;
      continue;
    }
    const result = await runCapture(candidate, ['--version'], 5000).catch(() => null);
    if (!result || result.code !== 0 || !result.stdout.trim()) {
      if (configured) sawConfiguredFailure = true;
      continue;
    }
    const version = result.stdout.trim();
    if (!isSupportedCodexVersion(version)) {
      lastErrorCode = 'CODEX_VERSION_UNSUPPORTED';
      continue;
    }
    const signature = await inspectAuthenticodeSignature(candidate);
    if (!signature.trusted) {
      lastErrorCode = 'CODEX_SIGNATURE_UNTRUSTED';
      continue;
    }
    const hash = await sha256File(candidate);
    const diagnostics: CodexExecutableDiagnostics = {
      path: candidate,
      version,
      hash,
      sha256: hash,
      signer: signature.signer,
      signatureStatus: signature.status,
    };
    lastDiagnostics = diagnostics;
    return { executable: { path: candidate, version }, diagnostics, errorCode: null };
  }
  return {
    executable: null,
    diagnostics: null,
    errorCode: configured && sawConfiguredFailure ? 'CODEX_CONFIGURED_PATH_INVALID' : lastErrorCode,
  };
}

export function isSupportedCodexVersion(output: string): boolean {
  const match = output.match(/(?:^|\s|-)v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  const [minMajor = 0, minMinor = 0, minPatch = 0] = CODEX_MIN_VERSION.split('.').map(Number);
  if (major < minMajor || (major === minMajor && minor < minMinor)) return false;
  if (major === minMajor && minor === minMinor && patch < minPatch) return false;
  return major <= CODEX_MAX_MAJOR;
}

type SignatureInspection = { status: string; signer: string | null; trusted: boolean };
/** PowerShell receives the path through an isolated environment value and is hidden/time-bound. */
export async function inspectAuthenticodeSignature(filePath: string): Promise<SignatureInspection> {
  if (process.platform !== 'win32') return { status: 'NotApplicable', signer: null, trusted: true };
  // A test/dev fixture may be explicitly opted in without starting a shell
  // process on every refresh/reconnect. Production never satisfies this gate.
  if (isDevelopmentOverride()) return { status: 'DevOverride', signer: null, trusted: true };
  // Windows PowerShell treats every token after `-Command` as part of the
  // command text rather than populating `$args`. Passing a path there made
  // `$args[0]` null and caused every valid signature to be reported as
  // Unknown. An environment value preserves spaces/metacharacters without
  // interpolating an untrusted path into PowerShell source.
  const script =
    '$s = Get-AuthenticodeSignature -LiteralPath $env:LG_REPORT_AGENT_AUTHENTICODE_PATH; [pscustomobject]@{ Status = [string]$s.Status; Signer = if ($null -ne $s.SignerCertificate) { [string]$s.SignerCertificate.Subject } else { $null } } | ConvertTo-Json -Compress';
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const systemPowerShellModules = path.join(
    windowsRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'Modules',
  );
  const result = await runCapture(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    15_000,
    {
      LG_REPORT_AGENT_AUTHENTICODE_PATH: filePath,
      // A parent PowerShell 7 session may prepend its modules to PSModulePath.
      // Windows PowerShell 5.1 can then fail to import its own Security module
      // because of conflicting type data. Only the signed, built-in module
      // directory is needed for Get-AuthenticodeSignature.
      PSModulePath: systemPowerShellModules,
    },
  ).catch(() => null);
  let status = 'Unknown';
  let signer: string | null = null;
  try {
    const parsed = JSON.parse(result?.stdout.trim() || '{}') as {
      Status?: unknown;
      Signer?: unknown;
    };
    if (typeof parsed.Status === 'string' && parsed.Status) status = parsed.Status;
    if (typeof parsed.Signer === 'string' && parsed.Signer) signer = parsed.Signer;
  } catch {
    /* Keep the generic status; command output is never surfaced to the UI. */
  }
  const publisherMatches = signer
    ?.toLocaleLowerCase('en-US')
    .includes(CODEX_EXPECTED_PUBLISHER.toLocaleLowerCase('en-US'));
  const valid = status === 'Valid' && publisherMatches;
  return { status, signer, trusted: valid || isDevelopmentOverride() };
}

function isDevelopmentOverride(): boolean {
  return (
    process.env.LG_REPORT_AGENT_CODEX_ALLOW_UNSIGNED_DEV === '1' &&
    !isPackagedElectronRuntime() &&
    (process.env.NODE_ENV === 'development' ||
      process.env.NODE_ENV === 'test' ||
      process.env.ELECTRON_IS_DEV === '1')
  );
}

/** Electron exposes `defaultApp` only for an unpackaged/default-app launch. */
function isPackagedElectronRuntime(): boolean {
  return Boolean(process.versions.electron) && process.defaultApp !== true;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
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
  environment?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(environment ? { env: mergeEnvironment(environment) } : {}),
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

/** Windows environment keys are case-insensitive. Remove inherited aliases so
 * an override such as PSModulePath is not silently shadowed by PSMODULEPATH. */
function mergeEnvironment(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (process.platform === 'win32') {
      const normalized = key.toLocaleLowerCase('en-US');
      for (const inherited of Object.keys(merged)) {
        if (inherited.toLocaleLowerCase('en-US') === normalized) delete merged[inherited];
      }
    }
    merged[key] = value;
  }
  return merged;
}
export function redact(value: string): string {
  return value
    .replace(/[A-Za-z0-9_-]{30,}/g, '[REDACTED]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[MASKED_EMAIL]')
    .slice(0, 4000);
}
