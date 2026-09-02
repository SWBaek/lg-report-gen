# Agent instructions

- Preserve Electron's main/preload/renderer security boundary.
- Add every IPC channel to the shared allowlist and validate every input with Zod.
- Never read Codex authentication files, store secrets, or log report/source content.
- Keep report HTML sanitized and atomically written.
- Run `npm run check` after implementation changes; run E2E and Windows packaging for release work.
