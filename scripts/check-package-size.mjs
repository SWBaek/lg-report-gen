import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const maximumBytes = 110 * 1024 * 1024;
const artifacts = [
  `LG-Report-Agent-${version}-x64-Portable.exe`,
  `LG-Report-Agent-Setup-${version}-x64.exe`,
];

for (const name of artifacts) {
  const size = (await stat(path.join(root, 'release', name))).size;
  const mebibytes = size / 1024 / 1024;
  if (size > maximumBytes)
    throw new Error(`${name} 용량이 제한을 초과했습니다: ${mebibytes.toFixed(2)} MiB > 110 MiB`);
  process.stdout.write(`${name}: ${mebibytes.toFixed(2)} MiB (limit 110 MiB)\n`);
}
