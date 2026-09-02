import { access, copyFile, mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { atomicWrite, resolveWithin } from '../services/files.js';

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
export async function validateWorkspace(root: string): Promise<WorkspacePaths> {
  if (!root || root.length > 1024) throw new Error('WORKSPACE_NOT_SELECTED');
  const target = path.resolve(root);
  await mkdir(target, { recursive: true });
  const info = await stat(target);
  if (!info.isDirectory()) throw new Error('WORKSPACE_NOT_WRITABLE');
  await access(target, constants.R_OK | constants.W_OK);
  const probe = path.join(target, `.lg-write-${process.pid}`);
  try {
    const handle = await open(probe, 'wx');
    await handle.close();
    await import('node:fs/promises').then((fs) => fs.rm(probe));
  } catch {
    throw new Error('WORKSPACE_NOT_WRITABLE');
  }
  return pathsFor(target);
}
export async function ensureWorkspace(root: string): Promise<WorkspacePaths> {
  const paths = await validateWorkspace(root);
  await Promise.all(
    [
      paths.internal,
      paths.logs,
      paths.cache,
      paths.backups,
      paths.reports,
      paths.chats,
      paths.exports,
    ].map((dir) => mkdir(dir, { recursive: true })),
  );
  await atomicWrite(
    path.join(paths.internal, 'workspace.json'),
    JSON.stringify({ format: 1, application: 'LG Report Agent' }, null, 2),
  );
  return paths;
}
export async function backupDatabase(paths: WorkspacePaths): Promise<string | null> {
  try {
    await access(paths.database);
    const target = path.join(
      paths.backups,
      `app-${new Date().toISOString().replace(/[:.]/g, '-')}.db`,
    );
    await copyFile(paths.database, target);
    return target;
  } catch {
    return null;
  }
}
