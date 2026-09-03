import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const packages = new Map();

for (const [location, metadata] of Object.entries(lock.packages)) {
  if (!location.startsWith('node_modules/') || metadata.dev) continue;
  const packageName =
    metadata.name ?? location.slice('node_modules/'.length).split('/node_modules/').pop();
  packages.set(`${packageName}@${metadata.version}`, { location, metadata, packageName });
}

const output = path.join(root, 'artifacts', 'licenses');
await mkdir(output, { recursive: true });
const rows = [];
for (const { location, metadata, packageName } of packages.values()) {
  const packageDir = path.join(root, location);
  let files = [];
  try {
    files = (await readdir(packageDir)).filter((name) =>
      /^licen[cs]e(?:\.|$)|copying|notice/i.test(name),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const licenseText = [];
  for (const file of files) {
    try {
      licenseText.push(`### ${file}\n\n${await readFile(path.join(packageDir, file), 'utf8')}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  rows.push({
    name: packageName,
    version: metadata.version,
    license: metadata.license ?? 'SEE LICENSE',
    licenseText,
  });
}

rows.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
const body = [
  '# Production dependency licenses',
  '',
  '이 파일은 `package-lock.json`의 production dependency graph에서 자동 생성됩니다.',
  '',
  ...rows.flatMap((row) => [
    `## ${row.name}@${row.version}`,
    '',
    `Declared license: ${row.license}`,
    '',
    ...(row.licenseText.length > 0
      ? row.licenseText
      : ['License text was not present in the installed package.']),
    '',
  ]),
].join('\n');
await writeFile(path.join(output, 'THIRD_PARTY_NOTICES.md'), body, 'utf8');
process.stdout.write(
  `Bundled license notices for ${rows.length} production packages in ${output}.\n`,
);
