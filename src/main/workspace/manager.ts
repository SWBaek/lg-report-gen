import {
  access,
  copyFile,
  mkdir,
  open,
  realpath,
  stat,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import spawn from 'cross-spawn';
import type Database from 'better-sqlite3';
import {
  atomicWrite,
  assertContainedRealpath,
  contentHash,
  resolveWithin,
  resolveWithinRealpath,
} from '../services/files.js';

export interface WorkspacePaths {
  root: string;
  internal: string;
  database: string;
  logs: string;
  cache: string;
  backups: string;
  reports: string;
  chats: string;
  exports: string;
}

/** Stable path locator used while persisted absolute paths are being migrated. */
export interface WorkspaceLocator {
  root: string;
  internal: string;
  reports: string;
  chats: string;
  report(reportId: string): string;
  reportFile(reportId: string, fileName: string): string;
  /** Resolve a database-relative path; absolute paths are accepted only for v1-v3 migration. */
  resolveStored(storedPath: string): string;
  quarantine(item: string): string;
}

export type WorkspaceStorageKind = 'local' | 'remote' | 'unknown';

/** Read-only path policy information suitable for a local diagnostics surface. */
export interface WorkspacePolicy {
  inputPath: string;
  canonicalPath: string | null;
  storage: WorkspaceStorageKind;
  synchronized: boolean;
  warnings: string[];
}

export interface WorkspaceValidationOptions {
  /** Remote workspaces stay blocked unless this is explicitly opted in. */
  allowRemote?: boolean;
  /** Permit a sync-folder workspace; the policy still reports a warning. */
  rejectSynchronizedFolder?: boolean;
}

export interface WorkspaceSnapshotFile {
  path: string;
  sha256: string;
  size: number;
}

export interface WorkspaceSnapshotManifest {
  format: 2;
  kind: 'full';
  createdAt: string;
  /** Full snapshots are intentionally preferred until incremental deltas are proven useful. */
  mode: 'full';
  incrementalRequested: boolean;
  files: WorkspaceSnapshotFile[];
  retention: { maxSnapshots: number };
}

export interface WorkspaceSnapshotResult {
  directory: string;
  manifestPath: string;
  manifest: WorkspaceSnapshotManifest;
}

export interface WorkspaceSnapshotOptions {
  outputDirectory?: string;
  incremental?: boolean;
}

export interface WorkspaceRestoreDryRun {
  snapshotPath: string;
  valid: boolean;
  database: { path: string; quickCheck: string; error?: string };
  files: {
    checked: number;
    missing: string[];
    modified: string[];
    invalid: string[];
  };
}

const SYNC_FOLDER_NAMES = [
  /^onedrive(?: - .+)?$/i,
  /^dropbox$/i,
  /^google drive$/i,
  /^box drive$/i,
  /^icloud drive$/i,
  /^syncthing$/i,
];

export function pathsFor(root: string): WorkspacePaths {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    internal: resolveWithin(resolved, '.lg-report-agent'),
    database: resolveWithin(resolved, '.lg-report-agent', 'app.db'),
    logs: resolveWithin(resolved, '.lg-report-agent', 'logs'),
    cache: resolveWithin(resolved, '.lg-report-agent', 'cache'),
    backups: resolveWithin(resolved, '.lg-report-agent', 'backups'),
    reports: resolveWithin(resolved, 'reports'),
    chats: resolveWithin(resolved, 'chats'),
    exports: resolveWithin(resolved, 'exports'),
  };
}

/**
 * Inspect only path metadata. No workspace files or report content are read.
 * Existing junctions are resolved so a local-looking alias cannot hide a
 * synchronized or remote target.
 */
export async function inspectWorkspacePolicy(root: string): Promise<WorkspacePolicy> {
  const inputPath = root;
  const canonicalPath = isUncPath(root) ? null : await canonicalPathForPolicy(root);
  const comparisonPaths = [root, canonicalPath].filter((value): value is string => Boolean(value));
  const synchronized = comparisonPaths.some((value) => isSynchronizedWorkspacePath(value));
  const storage: WorkspaceStorageKind = isUncPath(root)
    ? 'remote'
    : process.platform === 'win32'
      ? await windowsDriveStorage(root)
      : 'local';
  const warnings: string[] = [];
  if (storage === 'remote') warnings.push('WORKSPACE_REMOTE_UNSUPPORTED');
  if (synchronized) warnings.push('WORKSPACE_SYNC_FOLDER');
  return { inputPath, canonicalPath, storage, synchronized, warnings };
}

/** Alias kept descriptive for callers that use a get-style diagnostics API. */
export const getWorkspacePolicy = inspectWorkspacePolicy;

export function isUncPath(value: string): boolean {
  return /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value.trim());
}

export function isSynchronizedWorkspacePath(value: string): boolean {
  return value
    .split(/[\\/]+/g)
    .filter(Boolean)
    .some((component) => SYNC_FOLDER_NAMES.some((pattern) => pattern.test(component)));
}

export const isSyncWorkspacePath = isSynchronizedWorkspacePath;

async function canonicalPathForPolicy(root: string): Promise<string | null> {
  try {
    return await realpath(path.resolve(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(root);
    return null;
  }
}

async function windowsDriveStorage(root: string): Promise<WorkspaceStorageKind> {
  const drive = root.match(/^([A-Za-z]):(?:[\\/]|$)/)?.[1];
  if (!drive) return 'unknown';
  const script =
    "$d = Get-CimInstance Win32_LogicalDisk -Filter (\"DeviceID='{0}:'\" -f $args[0]); if ($null -eq $d) { '0' } else { [string]$d.DriveType }";
  try {
    const result = await runWorkspaceCapture(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
        drive.toUpperCase(),
      ],
      3000,
    );
    return result.stdout.trim() === '4'
      ? 'remote'
      : result.stdout.trim() === '3'
        ? 'local'
        : 'unknown';
  } catch {
    return 'unknown';
  }
}

function runWorkspaceCapture(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('WORKSPACE_POLICY_TIMEOUT'));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 1000) stdout += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, code });
    });
  });
}

export function locatorFor(paths: WorkspacePaths): WorkspaceLocator {
  return {
    root: paths.root,
    internal: paths.internal,
    reports: paths.reports,
    chats: paths.chats,
    report: (reportId) => resolveWithin(paths.reports, reportId),
    reportFile: (reportId, fileName) => resolveWithin(paths.reports, reportId, fileName),
    resolveStored: (storedPath) => {
      if (path.isAbsolute(storedPath)) return path.resolve(storedPath);
      return resolveWithin(paths.root, ...storedPath.split(/[\\/]/g).filter(Boolean));
    },
    quarantine: (item) => resolveWithin(paths.internal, 'quarantine', item),
  };
}

/** Validate a workspace-owned path immediately before a security-sensitive use. */
export async function verifyWorkspacePath(
  paths: WorkspacePaths,
  target: string,
  options: { allowMissing?: boolean; rejectSymlink?: boolean } = {},
): Promise<string> {
  return assertContainedRealpath(paths.root, target, options);
}

export async function verifyWorkspaceDirectory(
  paths: WorkspacePaths,
  target: string,
): Promise<string> {
  return resolveWithinRealpath(paths.root, path.relative(paths.root, target));
}
export async function validateWorkspace(
  root: string,
  options: WorkspaceValidationOptions = {},
): Promise<WorkspacePaths> {
  if (!root || root.length > 1024) throw new Error('WORKSPACE_NOT_SELECTED');
  const policy = await inspectWorkspacePolicy(root);
  if (policy.storage === 'remote' && options.allowRemote !== true)
    throw new Error('WORKSPACE_REMOTE_UNSUPPORTED');
  if (policy.synchronized && options.rejectSynchronizedFolder === true)
    throw new Error('WORKSPACE_SYNC_FOLDER_UNSUPPORTED');
  const target = path.resolve(root);
  await mkdir(target, { recursive: true });
  // Store the canonical root. This prevents a workspace selected through a
  // junction from making later lexical containment checks point elsewhere.
  const canonicalTarget = await realpath(target);
  const info = await stat(canonicalTarget);
  if (!info.isDirectory()) throw new Error('WORKSPACE_NOT_WRITABLE');
  await access(target, constants.R_OK | constants.W_OK);
  const probe = path.join(canonicalTarget, `.lg-write-${process.pid}`);
  try {
    const handle = await open(probe, 'wx');
    await handle.close();
    await import('node:fs/promises').then((fs) => fs.rm(probe));
  } catch {
    throw new Error('WORKSPACE_NOT_WRITABLE');
  }
  return pathsFor(canonicalTarget);
}
export async function ensureWorkspace(
  root: string,
  options: WorkspaceValidationOptions = {},
): Promise<WorkspacePaths> {
  const paths = await validateWorkspace(root, options);
  await Promise.all(
    [
      paths.internal,
      paths.logs,
      paths.cache,
      paths.backups,
      paths.reports,
      paths.chats,
      paths.exports,
    ].map(async (dir) => {
      await mkdir(dir, { recursive: true });
      await verifyWorkspacePath(paths, dir, { rejectSymlink: true });
    }),
  );
  await atomicWrite(
    path.join(paths.internal, 'workspace.json'),
    JSON.stringify({ format: 1, application: 'LG Report Agent' }, null, 2),
  );
  return paths;
}
export async function backupDatabase(paths: WorkspacePaths): Promise<string | null> {
  return backupDatabaseOnline(paths);
}

/**
 * Use SQLite's online backup API so the WAL and a consistent snapshot are
 * included. The source connection is supplied by AppDatabase when possible;
 * the compatibility path opens a short-lived Node connection for direct
 * callers/tests.
 */
export async function backupDatabaseOnline(
  paths: WorkspacePaths,
  source?: Database.Database,
): Promise<string | null> {
  try {
    await access(paths.database, constants.F_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  await mkdir(paths.backups, { recursive: true });
  const target = resolveWithin(
    paths.backups,
    `app-${new Date().toISOString().replace(/[:.]/g, '-')}.db`,
  );
  let connection = source;
  let owned = false;
  if (!connection) {
    const require = createRequire(import.meta.url);
    const DatabaseConstructor = require('better-sqlite3') as new (
      filename: string,
      options?: { readonly?: boolean },
    ) => Database.Database;
    connection = new DatabaseConstructor(paths.database, { readonly: true });
    owned = true;
  }
  try {
    await connection.backup(target);
    await updateBackupManifest(paths, target);
    return target;
  } finally {
    if (owned) connection.close();
  }
}

async function updateBackupManifest(paths: WorkspacePaths, target: string): Promise<void> {
  const manifestPath = resolveWithin(paths.backups, 'manifest.json');
  let entries: Array<{ file: string; sha256: string; createdAt: string }> = [];
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as { entries?: unknown };
    if (Array.isArray(parsed.entries))
      entries = parsed.entries.filter(
        (entry): entry is { file: string; sha256: string; createdAt: string } =>
          Boolean(
            entry &&
            typeof entry === 'object' &&
            typeof (entry as { file?: unknown }).file === 'string' &&
            typeof (entry as { sha256?: unknown }).sha256 === 'string' &&
            typeof (entry as { createdAt?: unknown }).createdAt === 'string',
          ),
      );
  } catch {
    /* a missing/corrupt manifest is rebuilt from the new backup */
  }
  entries = entries.filter((entry) => entry.file !== path.basename(target));
  entries.push({
    file: path.basename(target),
    sha256: contentHash(await readFile(target)),
    createdAt: new Date().toISOString(),
  });
  const files = (await readdir(paths.backups))
    .filter((file) => /^app-.*\.db$/i.test(file))
    .sort()
    .reverse();
  const keep = new Set(files.slice(0, 5));
  for (const file of files.slice(5)) await rm(resolveWithin(paths.backups, file), { force: true });
  entries = entries.filter((entry) => keep.has(entry.file));
  await atomicWrite(manifestPath, JSON.stringify({ format: 1, entries }, null, 2));
}

/**
 * Create an exportable, self-contained workspace snapshot.  A snapshot is a
 * directory so it can be copied to removable storage without requiring a
 * particular archive implementation; `manifest.json` is the portable index.
 * Transient caches, logs, exports, staging directories, and agent-work output
 * are deliberately omitted.  Canonical report documents, source originals /
 * extractions, revisions, assets, chats, and the online DB backup are included.
 */
export async function createWorkspaceSnapshot(
  paths: WorkspacePaths,
  sourceOrOptions?: Database.Database | WorkspaceSnapshotOptions,
  options: WorkspaceSnapshotOptions = {},
): Promise<WorkspaceSnapshotResult> {
  const source = isDatabaseConnection(sourceOrOptions) ? sourceOrOptions : undefined;
  const suppliedOptions = isDatabaseConnection(sourceOrOptions) ? undefined : sourceOrOptions;
  const snapshotOptions: WorkspaceSnapshotOptions = suppliedOptions ?? options;
  const outputDirectory = snapshotOptions.outputDirectory
    ? path.resolve(snapshotOptions.outputDirectory)
    : paths.backups;
  await mkdir(outputDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = resolveWithin(
    outputDirectory,
    `workspace-${stamp}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(directory, { recursive: true });
  const databaseTarget = resolveWithin(directory, 'app.db');
  if (source) await source.backup(databaseTarget);
  else {
    const backup = await backupDatabaseOnline(paths);
    if (!backup) throw new Error('DATABASE_NOT_FOUND');
    await copyFile(backup, databaseTarget);
  }

  const files: WorkspaceSnapshotFile[] = [];
  const sourceFiles = await workspaceSnapshotFiles(paths.root);
  for (const relative of sourceFiles) {
    const sourcePath = resolveWithin(paths.root, ...relative.split('/'));
    const destination = resolveWithin(directory, ...relative.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(sourcePath, destination);
    const bytes = await readFile(destination);
    files.push({ path: relative, sha256: contentHash(bytes), size: bytes.byteLength });
  }
  const databaseBytes = await readFile(databaseTarget);
  files.unshift({
    path: 'app.db',
    sha256: contentHash(databaseBytes),
    size: databaseBytes.byteLength,
  });
  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifest: WorkspaceSnapshotManifest = {
    format: 2,
    kind: 'full',
    createdAt: new Date().toISOString(),
    mode: 'full',
    incrementalRequested: snapshotOptions.incremental === true,
    files,
    retention: { maxSnapshots: 5 },
  };
  const manifestPath = resolveWithin(directory, 'manifest.json');
  await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
  await pruneWorkspaceSnapshots(outputDirectory, 5);
  return { directory, manifestPath, manifest };
}

/** Backward/verb-oriented alias for callers that treat snapshots as exports. */
export const exportWorkspaceSnapshot = createWorkspaceSnapshot;
export const createFullWorkspaceSnapshot = createWorkspaceSnapshot;

/**
 * Verify a snapshot without changing the destination workspace.  This checks
 * every manifest hash and opens the snapshot DB read-only for quick_check.
 */
export async function restoreWorkspaceSnapshotDryRun(
  paths: WorkspacePaths,
  snapshot: string,
): Promise<WorkspaceRestoreDryRun> {
  const snapshotPath = path.resolve(snapshot);
  const manifestPath = (await isDirectory(snapshotPath))
    ? resolveWithin(snapshotPath, 'manifest.json')
    : snapshotPath;
  let parsed: WorkspaceSnapshotManifest;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as WorkspaceSnapshotManifest;
  } catch {
    return {
      snapshotPath: path.dirname(manifestPath),
      valid: false,
      database: { path: '', quickCheck: 'error', error: 'SNAPSHOT_MANIFEST_READ_FAILED' },
      files: { checked: 0, missing: [], modified: [], invalid: ['manifest.json'] },
    };
  }
  const directory = path.dirname(manifestPath);
  const entries = Array.isArray(parsed.files) ? parsed.files : [];
  const missing: string[] = [];
  const modified: string[] = [];
  const invalid: string[] = [];
  if (parsed.format !== 2 || parsed.kind !== 'full' || !Array.isArray(parsed.files))
    invalid.push('manifest.json');
  const database = { path: resolveWithin(directory, 'app.db'), quickCheck: 'error' } as {
    path: string;
    quickCheck: string;
    error?: string;
  };
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)) {
      invalid.push(String((entry as { path?: unknown } | null)?.path ?? '<entry>'));
      continue;
    }
    let candidate: string;
    try {
      candidate = resolveWithin(directory, ...entry.path.split('/'));
    } catch {
      invalid.push(entry.path);
      continue;
    }
    try {
      const bytes = await readFile(candidate);
      if (bytes.byteLength !== entry.size || contentHash(bytes) !== entry.sha256)
        modified.push(entry.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.push(entry.path);
      else invalid.push(entry.path);
    }
  }
  if (!entries.some((entry) => entry && entry.path === 'app.db')) invalid.push('app.db');
  const require = createRequire(import.meta.url);
  let connection: Database.Database | null = null;
  try {
    const DatabaseConstructor = require('better-sqlite3') as new (
      filename: string,
      options?: { readonly?: boolean },
    ) => Database.Database;
    connection = new DatabaseConstructor(database.path, { readonly: true });
    database.quickCheck = String(connection.pragma('quick_check', { simple: true }));
  } catch (error) {
    database.error = error instanceof Error ? error.message : 'SNAPSHOT_DATABASE_READ_FAILED';
  } finally {
    connection?.close();
  }
  return {
    snapshotPath: directory,
    valid:
      database.quickCheck === 'ok' &&
      missing.length === 0 &&
      modified.length === 0 &&
      invalid.length === 0,
    database,
    files: { checked: entries.length, missing, modified, invalid },
  };
}

export const dryRunRestoreWorkspaceSnapshot = restoreWorkspaceSnapshotDryRun;
export const validateWorkspaceSnapshot = restoreWorkspaceSnapshotDryRun;

function isDatabaseConnection(value: unknown): value is Database.Database {
  return Boolean(value && typeof value === 'object' && 'backup' in value);
}

async function workspaceSnapshotFiles(root: string, current = ''): Promise<string[]> {
  const absolute = resolveWithin(root, ...current.split('/').filter(Boolean));
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: string[] = [];
  for (const entry of entries) {
    const relative = current ? `${current}/${entry.name}` : entry.name;
    if (
      relative === '.lg-report-agent/backups' ||
      relative.startsWith('.lg-report-agent/backups/') ||
      relative === '.lg-report-agent/cache' ||
      relative.startsWith('.lg-report-agent/cache/') ||
      relative === '.lg-report-agent/logs' ||
      relative.startsWith('.lg-report-agent/logs/') ||
      relative === 'exports' ||
      relative.startsWith('exports/') ||
      relative.split('/').some((part) => part === '.staging' || part === 'agent-work')
    )
      continue;
    if (entry.isDirectory()) result.push(...(await workspaceSnapshotFiles(root, relative)));
    else if (
      entry.isFile() &&
      (relative.startsWith('reports/') ||
        relative.startsWith('chats/') ||
        relative === '.lg-report-agent/workspace.json')
    )
      result.push(relative);
  }
  return result;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function pruneWorkspaceSnapshots(directory: string, max: number): Promise<void> {
  if (
    path.resolve(directory) !== path.resolve(path.dirname(directory), 'backups') &&
    !directory.endsWith(`${path.sep}backups`)
  )
    return;
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^workspace-/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of entries.slice(max))
    await rm(resolveWithin(directory, name), { recursive: true, force: true });
}
