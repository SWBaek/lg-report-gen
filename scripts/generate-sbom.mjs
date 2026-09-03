import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const output = path.join(root, 'artifacts', 'sbom');
await mkdir(output, { recursive: true });
const npm =
  process.env.npm_execpath ??
  (process.platform === 'win32'
    ? path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : 'npm');

for (const format of ['cyclonedx', 'spdx']) {
  const result = spawnSync(
    process.platform === 'win32' ? process.execPath : npm,
    process.platform === 'win32'
      ? [
          npm,
          'sbom',
          '--package-lock-only',
          '--omit=dev',
          '--sbom-format',
          format,
          '--sbom-type',
          'application',
        ]
      : [
          'sbom',
          '--package-lock-only',
          '--omit=dev',
          '--sbom-format',
          format,
          '--sbom-type',
          'application',
        ],
    { cwd: root, encoding: 'utf8', shell: false },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'npm sbom failed\n');
    process.exit(result.status ?? 1);
  }
  await writeFile(path.join(output, `lg-report-agent-${format}.json`), result.stdout, 'utf8');
}

process.stdout.write(`Generated CycloneDX and SPDX SBOMs in ${output}.\n`);
