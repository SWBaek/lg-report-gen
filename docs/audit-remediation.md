# 6차 감사 remediation closure

최초 감사의 P0-01~P0-14와 분류 태그(S/D/C/I/U/E/Q/M)를 현재 코드와 회귀 테스트에
대조한 종료 기록이다. `Completed`는 구현과 저장소 내 회귀 검증이 모두 있는 경우,
`Partial`은 구현 또는 검증 경계가 남은 경우, `External`은 저장소 밖 운영이 필요한
경우, `Deferred`는 이번 차수에서 범위를 넓히지 않은 경우에만 사용한다.

## P0 closure

| 항목                                                          | 태그  | 상태      | 근거와 테스트                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------- | ----- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0-01 IPC sender·top-frame·origin 인증                        | S/C   | Completed | `src/main/security/renderer.ts`의 `isAuthorizedIpcSender` seam과 `src/main/ipc/register.ts`의 공통 인증 경로가 등록된 `BrowserWindow`/`webContents`, top-level `mainFrame`, trusted renderer URL을 모두 검증한다. `tests/unit/renderer-security.test.ts`가 정상 호출 및 미등록 webContents, subframe, remote/untrusted URL, packaged/development origin 불일치를 검증한다.                                                     |
| P0-02 패키지 renderer 환경변수 차단                           | S     | Completed | `src/main/security/renderer.ts`가 packaged 실행에서 override를 무시하고 개발 시 loopback만 허용한다. `tests/unit/renderer-security.test.ts`가 packaged/development 경로를 검증한다.                                                                                                                                                                                                                                            |
| P0-03 Preload 경계·IPC allowlist·schema                       | S/C   | Completed | `src/preload/index.ts`, `src/shared/constants/ipc.ts`, `src/shared/schemas/index.ts`, `src/main/ipc/register.ts`; `tests/unit/prompts-schemas.test.ts`가 privileged input과 외부 URL을 거부한다.                                                                                                                                                                                                                               |
| P0-04 HTML 정화·출력 경계                                     | S/E   | Completed | Main/Renderer 양쪽 정화와 CSP가 구현되어 있다(`src/main/services/files.ts`, `src/renderer/src/features/reports/ReportEditor.tsx`, `src/main/exporters/report-theme.ts`). `tests/unit/files.test.ts`, `tests/integration/database.test.ts`, 앱 E2E export가 검증한다.                                                                                                                                                           |
| P0-05 Workspace 경로·junction/symlink·UNC                     | S/D   | Completed | `src/main/workspace/manager.ts`, `src/main/services/files.ts`의 realpath containment와 remote/sync 정책; `tests/unit/workspace.test.ts`가 UNC, sync junction, symlink 탈출, 길이 제한을 검증한다.                                                                                                                                                                                                                              |
| P0-06 Codex cwd/writable root·network/approval                | S     | Partial   | Main이 report `agent-work/output`, `approvalPolicy: never`, network disabled를 구성한다. `tests/integration/codex-manager.test.ts`는 fixture lifecycle만 검증하며 실제 App Server/OS Sandbox enforcement는 별도 확인이 필요하다.                                                                                                                                                                                               |
| P0-07 Codex 실행 파일 신뢰·진단 최소화                        | S/M   | Partial   | `src/main/codex/executable-resolver.ts`의 명시 경로·버전·서명·hash 진단과 account masking이 구현되어 있다. `tests/unit/codex-resolver.test.ts`, `tests/integration/codex-manager.test.ts`가 검증하지만 Windows Authenticode 실체는 서명 릴리스에서만 확인한다.                                                                                                                                                                 |
| P0-08 parser crash/timeout/cancel/result 제한                 | S/I/C | Completed | `src/main/importers/parser-supervisor.ts`의 one-shot `utilityProcess` worker와 bounded IPC; `tests/integration/importers.test.ts`가 timeout, crash, malformed/oversized result, AbortSignal cancel을 검증한다. Windows packaged E2E는 hardened `RunAsNode=false` fuse 상태에서 PDF worker를 기동해 실제 PDF 추출까지 검증한다.                                                                                                 |
| P0-09 source quality·format/signature/archive/provenance      | I/S   | Completed | `src/main/importers/source-importer.ts`가 content-addressed 원본 blob와 extractor-version extraction cache로 duplicate bytes를 재사용하고, PDF/DOCX/PPTX/XLSX/CSV의 semantic extraction과 evidence/derived provenance locator를 보존한다. `docs/importers.md`와 `tests/integration/importers.test.ts`의 semantic PPTX/XLSX/CSV, duplicate reuse, PDF locator, signature/traversal, image limit, manifest 보존 테스트가 근거다. |
| P0-10 canonical HTML/editor JSON·revision                     | D/C   | Completed | `src/main/database/database.ts`의 versioned envelope, projection hash, revision snapshot, atomic/journal 저장; `tests/integration/database.test.ts`의 canonical envelope, restore, staged rollback, missing canonical read failure가 검증한다.                                                                                                                                                                                 |
| P0-11 WAL durability·FULL backup·integrity·full snapshot      | D     | Completed | `src/main/database/database.ts`가 WAL과 `synchronous=FULL`, online backup, `quick_check`를 명시한다. `src/main/workspace/manager.ts`의 full workspace snapshot은 DB와 canonical/source/revision/chat 파일의 hash manifest, 최신 5개 retention, dry-run tamper 검사를 제공한다. `tests/integration/database.test.ts`의 WAL reopen backup, pragma=2, full hash manifest와 tamper dry-run이 검증한다.                             |
| P0-12 export preflight·HTML/PDF isolation·atomic output       | E/S/D | Completed | `src/main/exporters/html-exporter.ts`가 임시 HTML file URL, 비영속 partition, HTTP(S) 차단, exact temp file allow, `finally` cleanup을 적용한다. `tests/unit/exporter-security.test.ts`의 preflight warning matrix와 `tests/e2e/app.spec.ts`의 HTML/PDF 산출 및 `%PDF-` signature 검증이 통과했다.                                                                                                                             |
| P0-13 fast/duplicate/cancel-late/resume                       | C/U   | Completed | turn reservation, stream/task idempotence, terminal tombstone이 구현되어 있다. `tests/integration/codex-manager.test.ts`가 fast burst, duplicate completion, late cancel, persisted resume, concurrent busy를 검증한다.                                                                                                                                                                                                        |
| P0-14 release signing·branch protection·approval·supply chain | M/S/Q | External  | `.github/workflows/release.yml`, scripts, `docs/release-operations.md`에 signing gate, fuse/checksum/SBOM/license/provenance 절차가 있다. 실제 인증서 Secret, GitHub ruleset/required check, 관리자 승인, Advanced Security는 외부 운영자가 구성해야 한다.                                                                                                                                                                     |

## 분류별 요약

| 분류                           | 상태      | 판단                                                                                                                             |
| ------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| S — Security                   | Partial   | renderer/경로/입력/출력 경계는 검증됐지만 sender auth 직접 부정 테스트, 실제 Codex Sandbox, Windows 서명 운영 검증이 남아 있다.  |
| D — Data durability            | Completed | WAL/FULL, canonical/revision/journal, online backup, full snapshot과 export atomic output이 검증됐다.                            |
| C — Concurrency/correctness    | Completed | schema, canonical, turn reservation/idempotence를 fixture 범위에서 검증한다. sender auth 직접 검증은 P0-01 잔여로 별도 표시했다. |
| I — Import                     | Completed | parser isolation, format/signature/limits, dedup, semantic extraction, provenance가 회귀 검증됐다.                               |
| U — User experience            | Partial   | main E2E와 keyboard 입력 경로는 있으나 모든 breakpoint와 Tab/Enter/Escape 순서 자동화는 Deferred다.                              |
| E — Export                     | Completed | HTML 정화/CSP, preflight, HTML/PDF isolation, atomic output, `%PDF-` signature가 검증됐다.                                       |
| Q — Quality gates              | Partial   | local lint/type/unit/integration/build 절차는 있으나 release signing과 조직 required checks는 External이다.                      |
| M — Maintainability/operations | Partial   | release/checksum/SBOM/rollback 문서는 있으나 인증서·ruleset·승인 설정은 External이다.                                            |

## 회귀 범위와 잔여 blocker

이번 차수에서 확인/추가한 회귀는 `tests/unit/renderer-security.test.ts`의 packaged
renderer 차단, `tests/unit/workspace.test.ts`의 junction/symlink containment,
`tests/unit/exporter-security.test.ts`의 preflight warning matrix다. 기존 integration
suite에는 fast/duplicate/cancel/resume, WAL/FULL/full snapshot, canonical revision,
parser crash/timeout, source dedup/semantic extraction 회귀가 포함되어 있다.

우선순위 blocker는 다음과 같다.

1. **P0-01 / S** — sender authorization을 검증할 testable seam을 설계한다.
2. **P0-06 / S** — packaged Windows에서 실제 writable root/network enforcement를 확인한다.
3. **P0-14 / M/S/Q** — 인증서 Secret, `RELEASE_SIGNING_REQUIRED`, GitHub ruleset/required checks, Advanced Security를 관리자 권한으로 구성한다.
4. **U** — responsive breakpoint와 Tab/Enter/Escape traversal E2E를 확장하는 것은 Deferred다.

검증 명령은 `npm run check`, `npm run test:e2e`, `npm run build:win`,
`npm run test:e2e:packaged`다. 실제 서명, GitHub 보호 규칙, 설치된 Codex Sandbox는
이 명령으로 증명하지 않는다.
