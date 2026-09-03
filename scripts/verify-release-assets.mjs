import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const releaseDir = path.join(root, 'release');
const checksumPath = path.join(releaseDir, 'SHA256SUMS.txt');
const text = await readFile(checksumPath, 'utf8');
const entries = text.split(/\r?\n/).filter(Boolean);
if (entries.length === 0) throw new Error('SHA256SUMS.txt가 비어 있습니다.');

for (const entry of entries) {
  const match = /^(?<hash>[a-f0-9]{64}) {2}(?<name>[A-Za-z0-9._-]+)$/.exec(entry.trim());
  if (!match?.groups) throw new Error(`잘못된 checksum 행: ${entry}`);
  const actual = createHash('sha256')
    .update(await readFile(path.join(releaseDir, match.groups.name)))
    .digest('hex');
  if (actual !== match.groups.hash) throw new Error(`Checksum mismatch: ${match.groups.name}`);
}

process.stdout.write(`Verified ${entries.length} release asset checksums.\n`);
