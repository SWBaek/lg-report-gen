import { access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const releaseDir = path.join(root, 'release');
const files = [
  'LG-Report-Agent-${version}-x64-Portable.exe',
  'LG-Report-Agent-Setup-${version}-x64.exe',
];
const packageJson = JSON.parse(
  await (await import('node:fs/promises')).readFile(path.join(root, 'package.json'), 'utf8'),
);
const executables = files.map((name) =>
  path.join(releaseDir, name.replace('${version}', packageJson.version)),
);
const required = process.env.RELEASE_SIGNING_REQUIRED === 'true';

if (!required) {
  process.stderr.write(
    'Signature verification skipped: RELEASE_SIGNING_REQUIRED is not true (unsigned build is allowed).',
  );
  process.exit(0);
}

if (process.platform !== 'win32') {
  process.stderr.write('Required Authenticode verification must run on Windows.\n');
  process.exit(1);
}

let signtool;
try {
  signtool = execFileSync('where.exe', ['signtool.exe'], { encoding: 'utf8' })
    .split(/\r?\n/)[0]
    .trim();
} catch {
  process.stderr.write('signtool.exe was not found; cannot verify required release signatures.\n');
  process.exit(1);
}

for (const executable of executables) {
  await access(executable);
  execFileSync(signtool, ['verify', '/pa', '/all', executable], { stdio: 'inherit' });
}

process.stdout.write(
  `Verified Authenticode signatures for ${executables.length} release assets.\n`,
);
