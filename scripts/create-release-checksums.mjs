import { createHash } from 'node:crypto';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const releaseDir = path.join(root, 'release');
const names = (await readdir(releaseDir))
  .filter((name) => name.toLowerCase().endsWith('.exe'))
  .sort();
if (names.length === 0) throw new Error('release 디렉터리에 EXE가 없습니다.');

const lines = [];
for (const name of names) {
  const digest = createHash('sha256')
    .update(await readFile(path.join(releaseDir, name)))
    .digest('hex');
  lines.push(`${digest}  ${name}`);
}

const target = path.join(releaseDir, 'SHA256SUMS.txt');
const temporary = `${target}.${process.pid}.tmp`;
await writeFile(temporary, `${lines.join('\n')}\n`, 'utf8');
await rename(temporary, target);
process.stdout.write(`Wrote ${target} for ${names.length} release assets.\n`);
