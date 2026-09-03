import { createHash } from 'node:crypto';
import { copyFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { flipFuses, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';

const root = process.cwd();
const original = process.env.PACKAGED_APP_PATH;
if (!original) {
  process.stderr.write('PACKAGED_APP_PATH가 지정되지 않았습니다.\n');
  process.exit(1);
}

const checkScript = path.join(root, 'scripts', 'check-electron-fuses.mjs');
const playwrightCli = path.join(root, 'node_modules', 'playwright', 'cli.js');
const clone = path.join(path.dirname(original), `.lg-report-agent-packaged-e2e-${process.pid}.exe`);
const inspectorFuse = (enabled) => ({
  version: FuseVersion.V1,
  [FuseV1Options.EnableNodeCliInspectArguments]: enabled,
});
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const fuseWire = async (file) => JSON.stringify(await getCurrentFuseWire(file));
const signatureState = (file) => {
  if (process.platform !== 'win32') return 'unsupported';
  const located = spawnSync('where.exe', ['signtool.exe'], { encoding: 'utf8' });
  if (located.status !== 0) return 'unavailable';
  const signtool = located.stdout.split(/\r?\n/)[0].trim();
  const result = spawnSync(signtool, ['verify', '/pa', '/all', file], {
    stdio: 'ignore',
    shell: false,
  });
  return result.status === 0 ? 'valid' : 'invalid';
};
const runFuseCheck = (file) =>
  spawnSync(process.execPath, [checkScript, file], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  }).status ?? 1;
const stopCloneProcesses = () => {
  if (process.platform === 'win32') {
    const name = path.basename(clone).replaceAll("'", "''");
    const query = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${name}*' } | Select-Object -ExpandProperty ProcessId`;
    const located = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', query],
      { encoding: 'utf8', shell: false },
    );
    const processIds = (located.stdout ?? '')
      .split(/\r?\n/)
      .map((value) => Number.parseInt(value.trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0);
    for (const processId of processIds) {
      spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(processId)], {
        stdio: 'ignore',
        shell: false,
      });
    }
    spawnSync('taskkill.exe', ['/F', '/T', '/IM', path.basename(clone)], {
      stdio: 'ignore',
      shell: false,
    });
  }
};
const removeClone = async () => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(clone, { force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 9) throw error;
      await delay(200);
    }
  }
};

const before = {
  hash: await hash(original),
  fuse: await fuseWire(original),
  signature: signatureState(original),
};
if (runFuseCheck(original) !== 0) process.exit(1);

let testStatus;
let cleanupError;
try {
  await copyFile(original, clone);
  await flipFuses(clone, inspectorFuse(true));
  const result = spawnSync(
    process.execPath,
    [playwrightCli, 'test', 'tests/e2e/packaged.spec.ts'],
    {
      cwd: root,
      env: { ...process.env, PACKAGED_APP_PATH: clone },
      stdio: 'inherit',
      shell: false,
    },
  );
  testStatus = result.status ?? 1;
} finally {
  stopCloneProcesses();
  try {
    await removeClone();
  } catch (error) {
    cleanupError = error;
  }
}

const after = {
  hash: await hash(original),
  fuse: await fuseWire(original),
  signature: signatureState(original),
};
if (testStatus === undefined) testStatus = 1;
if (JSON.stringify(before) !== JSON.stringify(after)) {
  process.stderr.write('원본 packaged executable이 E2E 전후 변경되었습니다.\n');
  testStatus = 1;
}
if (cleanupError) {
  process.stderr.write(`E2E clone 정리에 실패했습니다: ${cleanupError.message}\n`);
  testStatus = 1;
}
if (runFuseCheck(original) !== 0) testStatus = 1;
process.stdout.write(
  'Packaged E2E used an unsigned temporary clone; original executable integrity was preserved.\n',
);
process.exit(testStatus);
