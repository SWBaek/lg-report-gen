# Agent instructions

## Change ownership

- Keep OS, filesystem, database, import/export, and Codex operations in `src/main`; expose renderer capabilities only through the shared API contract and `src/preload`.
- Keep UI work in `src/renderer` and cross-boundary IPC constants, contracts, schemas, and types in `src/shared`.
- Preserve Electron's main/preload/renderer security boundary.
- For every IPC change, update the shared channel allowlist, `DesktopApi` contract, preload bridge, Zod schema for each payload-bearing input, and Main handler together.
- Never read Codex authentication files, store secrets, or log report/source content.
- Sanitize report HTML in the Renderer and Main process; use `atomicWrite` for canonical and exported report files.

## Keep public behavior in sync

- When the security boundary or Codex authentication and sandbox behavior changes, update `docs/security.md`, the README security section, and matching tests.
- When Workspace layout, supported source formats, export behavior, or user-visible limitations change, update the matching README section and tests.

## Validation

- During implementation, run the narrowest relevant check: `npm test` for unit coverage, `npm run test:integration` for database/importer/Codex integration, and `npm run test:e2e` for Electron workflows.
- Run `npm run check` after implementation changes.
- For release work, follow the complete `.github/workflows/release.yml` sequence, including source checks, Electron E2E, Windows packaging, and the packaged-application E2E test.
