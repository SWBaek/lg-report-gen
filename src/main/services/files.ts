import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import sanitizeHtml from 'sanitize-html';

export const ALLOWED_HTML = {
  allowedTags: [
    'h1',
    'h2',
    'h3',
    'h4',
    'p',
    'strong',
    'em',
    'u',
    's',
    'ul',
    'ol',
    'li',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'blockquote',
    'code',
    'pre',
    'a',
    'img',
    'figure',
    'figcaption',
    'hr',
    'div',
    'span',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
    div: ['class'],
    span: ['class'],
  },
  allowedClasses: { div: ['page-break', 'report-callout', 'source-note'], span: ['source-ref'] },
  allowedSchemes: ['https', 'data'],
  allowedSchemesByTag: { img: ['data'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard' as const,
};

export function sanitizeReportHtml(html: string): string {
  return sanitizeHtml(html, ALLOWED_HTML);
}
export function contentHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
export function safeFilename(name: string, fallback = 'report'): string {
  const withoutControlCharacters = [...name]
    .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
    .join('');
  const cleaned = withoutControlCharacters
    .normalize('NFC')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  return !cleaned || reserved.test(cleaned) ? fallback : cleaned;
}
export function resolveWithin(root: string, ...parts: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...parts);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`))
    throw new Error('PATH_TRAVERSAL');
  return target;
}

/**
 * Resolve a path using the real path of every existing parent.  The regular
 * resolveWithin helper is intentionally synchronous and is useful for
 * constructing paths, but it cannot defend against a symlink/junction that is
 * introduced after the path is constructed.
 */
export async function resolveWithinRealpath(root: string, ...parts: string[]): Promise<string> {
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = resolveWithin(lexicalRoot, ...parts);
  const realRoot = await realpath(lexicalRoot);
  const realTarget = await realpathOfExistingOrParent(lexicalTarget);
  if (!isContained(realRoot, realTarget)) throw new Error('PATH_TRAVERSAL');
  return lexicalTarget;
}

/** Verify an already-resolved path is still inside root (including symlinks). */
export async function assertContainedRealpath(
  root: string,
  target: string,
  options: { allowMissing?: boolean; rejectSymlink?: boolean } = {},
): Promise<string> {
  const lexicalRoot = path.resolve(root);
  const lexicalTarget = path.resolve(target);
  if (!isContained(lexicalRoot, lexicalTarget)) throw new Error('PATH_TRAVERSAL');
  const realRoot = await realpath(lexicalRoot);
  let targetStat;
  try {
    targetStat = await lstat(lexicalTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || options.allowMissing === false)
      throw error;
  }
  if (
    options.rejectSymlink !== false &&
    (targetStat?.isSymbolicLink() || (await hasSymlinkComponent(lexicalRoot, lexicalTarget)))
  )
    throw new Error('PATH_SYMLINK');
  const realTarget = await realpathOfExistingOrParent(lexicalTarget);
  if (!isContained(realRoot, realTarget)) throw new Error('PATH_TRAVERSAL');
  return lexicalTarget;
}

/**
 * Re-check and remove a path below root.  This is deliberately stricter than
 * a normal rm: the target itself may not be a symlink/junction and the root
 * cannot be removed.
 */
export async function removeWithin(
  root: string,
  target: string,
  options: { recursive?: boolean; force?: boolean } = {},
): Promise<void> {
  const verified = await assertContainedRealpath(root, target, {
    allowMissing: options.force === true,
    rejectSymlink: true,
  });
  const realRoot = await realpath(path.resolve(root));
  const realTarget = await realpathOfExistingOrParent(verified);
  if (realTarget === realRoot) throw new Error('PATH_TRAVERSAL');
  await rm(verified, { recursive: options.recursive ?? true, force: options.force ?? false });
}

// Compatibility aliases for callers that want to make the containment check
// explicit at a security-sensitive call site.
export const verifyContainedPath = assertContainedRealpath;
export const assertWorkspaceContainment = assertContainedRealpath;

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function realpathOfExistingOrParent(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    const realParent = await realpathOfExistingOrParent(parent);
    return path.join(realParent, path.basename(target));
  }
}

async function hasSymlinkComponent(root: string, target: string): Promise<boolean> {
  const relative = path.relative(root, target);
  let cursor = root;
  for (const component of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, component);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return false;
}

export async function atomicWrite(filePath: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data);
    const handle = await open(temporary, 'r+');
    await handle.sync();
    await handle.close();
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class JsonFileError extends Error {
  readonly code = 'JSON_FILE_INVALID';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'JsonFileError';
  }
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    // A missing optional file is the only case where a fallback is safe.  A
    // malformed or inaccessible file must remain observable to its caller.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError)
      throw new JsonFileError(`JSON_FILE_INVALID: ${path.basename(filePath)}`, { cause: error });
    throw error;
  }
}

/**
 * Read and validate a JSON file. Corrupt bootstrap-like files are moved aside
 * before returning the supplied defaults, so the next startup cannot consume
 * the same bytes silently. I/O failures other than ENOENT are propagated.
 */
export async function readJsonOrQuarantine<T>(
  filePath: string,
  fallback: T,
  validate?: (value: unknown) => T,
): Promise<T> {
  try {
    const value = await readJson<unknown>(filePath, fallback);
    return validate ? validate(value) : (value as T);
  } catch (error) {
    const invalid =
      error instanceof JsonFileError || (error instanceof Error && error.name === 'ZodError');
    if (!invalid) throw error;
    await quarantineFile(filePath);
    return fallback;
  }
}

export async function quarantineFile(filePath: string): Promise<string | null> {
  try {
    await access(filePath, constants.F_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const quarantined = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  await rename(filePath, quarantined);
  return quarantined;
}
