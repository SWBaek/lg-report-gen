import process from 'node:process';

const required = process.env.RELEASE_SIGNING_REQUIRED === 'true';
const certificate = process.env.CSC_LINK?.trim();
const password = process.env.CSC_KEY_PASSWORD ?? '';

if (!required) {
  process.stderr.write(
    'Release signing is not required. This build is intentionally unsigned unless CSC_LINK and CSC_KEY_PASSWORD are configured.\n',
  );
  process.exit(0);
}

if (!certificate || !password) {
  process.stderr.write(
    'Release signing is required, but CSC_LINK or CSC_KEY_PASSWORD is missing. Configure repository secrets before publishing.\n',
  );
  process.exit(1);
}

process.stdout.write(
  'Release signing gate passed; electron-builder will use the configured Windows certificate.\n',
);
