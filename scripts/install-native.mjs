import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleRoot = path.join(root, 'node_modules', 'better-sqlite3');
const buildBinary = path.join(moduleRoot, 'build', 'Release', 'better_sqlite3.node');
const nativeRoot = path.join(moduleRoot, 'native');
const nodeBinary = path.join(nativeRoot, 'better_sqlite3.node');
const electronBinary = path.join(nativeRoot, 'better_sqlite3-electron.node');
const electronPackage = JSON.parse(
  await readFile(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'),
);
await mkdir(nativeRoot, { recursive: true });
await copyFile(buildBinary, nodeBinary);
const executable = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prebuild-install.cmd' : 'prebuild-install',
);
const result = spawn.sync(executable, ['-r', 'electron', '-t', electronPackage.version], {
  cwd: moduleRoot,
  shell: false,
  stdio: 'inherit',
});
if (result.status !== 0) throw new Error('Electron용 better-sqlite3 prebuilt 설치에 실패했습니다.');
await copyFile(buildBinary, electronBinary);
await copyFile(nodeBinary, buildBinary);
