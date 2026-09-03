import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staging = path.join(root, 'artifacts', `windows-build-${randomUUID()}`);
const destination = path.join(root, 'release');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const signingRequired = process.env.RELEASE_SIGNING_REQUIRED === 'true';
const executable = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
);
if (signingRequired) {
  const signingCheck = spawn.sync(
    process.execPath,
    [path.join(root, 'scripts', 'check-code-signing.mjs')],
    { cwd: root, shell: false, stdio: 'inherit' },
  );
  if (signingCheck.status !== 0) throw new Error('코드 서명 필수 정책을 만족하지 못했습니다.');
}
await mkdir(staging, { recursive: true });
const result = spawn.sync(
  executable,
  [
    '--win',
    'portable',
    'nsis',
    '--x64',
    '--publish',
    'never',
    `--config.forceCodeSigning=${signingRequired}`,
    `--config.directories.output=${staging}`,
  ],
  { cwd: root, shell: false, stdio: 'inherit' },
);
if (result.status !== 0) throw new Error('Windows 패키징에 실패했습니다.');
await mkdir(destination, { recursive: true });
const names = [
  `LG-Report-Agent-${version}-x64-Portable.exe`,
  `LG-Report-Agent-Setup-${version}-x64.exe`,
];
for (const name of names) {
  const target = path.join(destination, name);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await copyFile(path.join(staging, name), temporary);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
await writeFile(
  path.join(root, 'artifacts', 'latest-packaged-path.txt'),
  path.join(staging, 'win-unpacked', 'LG Report Agent.exe'),
);

const fuseCheck = spawn.sync(
  process.execPath,
  [
    path.join(root, 'scripts', 'check-electron-fuses.mjs'),
    path.join(staging, 'win-unpacked', 'LG Report Agent.exe'),
  ],
  { cwd: root, shell: false, stdio: 'inherit' },
);
if (fuseCheck.status !== 0) throw new Error('Electron fuse 검증에 실패했습니다.');
