import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { getCurrentFuseWire } from '@electron/fuses';

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const expected = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: true,
};
const configured = packageJson.build?.electronFuses;
for (const [key, value] of Object.entries(expected)) {
  const configKey = key.charAt(0).toLowerCase() + key.slice(1);
  if (configured?.[configKey] !== value)
    throw new Error(`electronFuses.${configKey} must be ${value}.`);
}

const target = process.argv[2];
if (!target) {
  process.stdout.write(
    'Electron fuse configuration is complete. Packaged binary inspection runs after build:win.',
  );
  process.exit(0);
}

const actual = await getCurrentFuseWire(target);
const fuseNames = Object.keys(expected);
for (const name of fuseNames) {
  const index = {
    RunAsNode: 0,
    EnableCookieEncryption: 1,
    EnableNodeOptionsEnvironmentVariable: 2,
    EnableNodeCliInspectArguments: 3,
    EnableEmbeddedAsarIntegrityValidation: 4,
    OnlyLoadAppFromAsar: 5,
    LoadBrowserProcessSpecificV8Snapshot: 6,
    GrantFileProtocolExtraPrivileges: 7,
  }[name];
  const expectedState = expected[name] ? 49 : 48;
  if (actual[index] !== expectedState) {
    throw new Error(`Packaged Electron fuse ${name} has an unexpected state.`);
  }
}
process.stdout.write(`Verified Electron fuses in ${target}.\n`);
