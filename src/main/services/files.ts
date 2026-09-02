import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
