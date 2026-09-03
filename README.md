# LG Report Agent

LG Report Agent는 LG전자 내부 사용자를 위한 로컬 우선 표준 보고서 작성·편집 데스크톱 애플리케이션입니다. 보고서의 Canonical Format은 HTML이며, 사용자가 별도로 설치하고 개인 계정으로 로그인한 Codex CLI의 `codex app-server`만 AI 경로로 사용합니다. 별도 OpenAI API Key, 원격 백엔드, Telemetry, 자동 업데이트, Crash Reporting은 없습니다.

현재 테마는 일반 Enterprise 보고서 구조와 교체 가능한 Burgundy Accent를 사용합니다. 공식 LG 로고·상표 이미지·공식 CI 준수 주장은 포함하지 않습니다. 실제 LG 표준 보고서 템플릿은 아직 제공되지 않아 포함되어 있지 않습니다.

## 다운로드

최신 Windows 배포 파일은 [GitHub Releases](https://github.com/SWBaek/lg-report-gen/releases/latest)에서 받을 수 있습니다.

- `LG-Report-Agent-Setup-<version>-x64.exe`: 일반 사용자용 설치 파일
- `LG-Report-Agent-<version>-x64-Portable.exe`: 설치 없이 실행하는 Portable 파일
- `SHA256SUMS.txt`: 다운로드 무결성 확인용 SHA-256 목록
- `artifacts/sbom/*.json`: CycloneDX/SPDX production dependency SBOM
- `THIRD_PARTY_NOTICES.md`: production dependency license bundle

현재 공개 빌드는 코드 서명되지 않았으므로 Windows SmartScreen 경고가 표시될 수 있습니다. 실행 전 Release의 `SHA256SUMS.txt`와 다운로드 파일의 해시를 비교하십시오. 서명 릴리스 운영과 롤백 절차는 [docs/release-operations.md](docs/release-operations.md)를 참조하십시오.

## 개발 환경

- Windows 10/11 x64
- Node.js 22 이상(검증 환경: Node.js 24)
- npm
- 별도 Codex CLI(선택적 AI 기능)

```powershell
npm install
npm run dev
```

Codex CLI 설치와 로그인:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
codex login
codex login status
```

공식 안내: https://developers.openai.com/codex/cli

앱은 인증 파일이나 토큰을 직접 읽지 않습니다. `initialize`/`initialized` 후 `account/read`로 실제 상태를 확인합니다.

## 검사와 빌드

```powershell
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:integration
npm run test:e2e
npm run build
npm run build:win
```

선택적 실제 Codex Smoke Test는 `npm run test:integration:codex`로 실행하며 일반 테스트에는 실제 계정 호출이 없습니다. Windows 빌드는 `release/LG-Report-Agent-1.1.0-x64-Portable.exe`와 `release/LG-Report-Agent-Setup-1.1.0-x64.exe`를 생성합니다. `npm run check:package-size`는 두 산출물이 각각 110 MiB를 넘지 않는지 검사합니다. 코드 서명이 구성되지 않았으므로 산출물은 unsigned이며 SmartScreen 경고가 나타날 수 있습니다.

`v<package.json version>` 형식의 Tag를 Push하면 `.github/workflows/release.yml`이 검사, Electron E2E, Windows 패키징, 패키지 실행 테스트를 수행하고 EXE와 SHA-256 목록을 GitHub Release에 게시합니다.

Pull Request와 `main` push에는 `candidate-checks` required candidate check가 실행됩니다. Release는 signing-required gate, Electron fuse 검증, CycloneDX/SPDX SBOM, production license bundle, checksum 검증과 GitHub provenance attestation을 추가로 수행합니다. 저장소 관리자만 release tag/ruleset, Windows 인증서 Secret, `RELEASE_SIGNING_REQUIRED` Variable, Dependabot, CodeQL, secret scanning/push protection을 조직 설정에서 활성화할 수 있습니다.

## Workspace 구조

```text
<workspace>/
  .lg-report-agent/app.db, backups/, cache/, logs/
  reports/<uuid>/report.html, editor.json, source-originals/ (evidence/), source-extracted/ (derived/), revisions/, agent-work/ (agent-output), assets/
  chats/<uuid>/agent-work/
  exports/
```

Workspace 백업은 `.lg-report-agent/backups/workspace-*/` full snapshot으로 내보낼 수 있습니다. Snapshot은 온라인 DB 백업과 report의 canonical 문서, source 원본/추출, revision, asset 및 chat의 안정 파일을 SHA-256 manifest로 함께 보존합니다. 최신 5개만 유지하며 cache/log/export와 임시 `agent-work`는 제외합니다. 복원 전 dry-run 검사는 DB `quick_check`와 누락·파일 hash 불일치를 보고하고 Workspace를 변경하지 않습니다. 증분 요청도 현재는 일관성 확보를 위해 full snapshot으로 저장됩니다.

`userData`에는 마지막 Workspace 경로, 최초 동의, 창 위치/크기, Codex 실행 경로처럼 부트스트랩에 필요한 최소 설정만 둡니다. 보고서·대화·첨부 본문은 Workspace에만 저장합니다.

Workspace는 로컬 디스크를 기준으로 하며 UNC(`\\server\\share`)와 Windows 네트워크 드라이브는 기본 차단됩니다. OneDrive·Dropbox·Google Drive·Box Drive·iCloud Drive·Syncthing 같은 동기화 폴더는 junction을 포함한 정규 경로를 진단해 경고하며, 정책 API에서 명시적으로 거부할 수 있습니다. 경로가 1,024자를 초과하면 선택할 수 없습니다. 동기화 충돌과 파일 잠금이 우려되므로 가능하면 로컬 폴더를 사용하십시오.

## 현실적 제약

- 지원 소스 형식은 PDF, DOCX, PPTX, XLSX, CSV, TXT, Markdown, PNG/JPEG/WebP입니다. 확장자와 파일 signature가 일치하지 않거나 제한을 넘는 파일은 가져오지 않습니다.
- 원본은 파일당 100 MiB까지 스트리밍으로 SHA-256을 계산하며 `source-originals/blobs/sha256/<hash>`에 content-addressed로 보관합니다. 같은 source는 원본과 extractor-version별 추출 cache를 재사용하고, manifest의 sourceId/name 링크는 유지합니다. extractor 버전·config·schema·source hash·추출 시각·partial 사유 provenance도 결과에 포함됩니다.
- OOXML ZIP은 항목 수·전체/단일 해제 크기·압축 비율·경로 traversal을 사전 검사합니다. 추출 가능한 범위가 parser 제한에 걸리면 `partial` 상태와 경고를 함께 기록합니다.
- PDF는 최대 500페이지와 10 MiB 텍스트, 페이지별 처리 시간 제한을 적용하며 page hash·bbox·reading order·text density를 기록합니다. 이미지의 dimension/pixel 수를 확인하고, 편집기에는 EXIF 등 원본 metadata를 제거한 PNG 표시본만 제공합니다.
- DOCX는 heading/list/table 의미 block, PPTX는 shape/notes/table 최소 구조, XLSX는 formula+cached result·hidden·merged·named range·header/unit을 추출합니다.
- CSV는 인용부호 안의 개행을 지원하며 구분자를 여러 행에서 감지합니다. 최대 100,000개 record·1,000개 field·field당 1,000,000자까지 처리하고 estimated row count/truncation을 기록합니다. UTF-8만 지원하며 CP949/EUC-KR은 UTF-8 변환을 안내합니다.
- 스캔 PDF OCR은 제공하지 않으며 텍스트 부족으로 표시합니다.
- PPTX는 슬라이드 텍스트와 표 XML 및 노트 존재를 추출하지만 시각 레이아웃을 재현하지 않습니다.
- CSV는 UTF-8을 우선하며 비 UTF-8 파일은 UTF-8 재저장을 안내합니다.
- A4 편집 화면은 CSS 경계를 제공하고 정확한 페이지 나눔은 인쇄 미리보기를 기준으로 합니다.
- HTML 내보내기는 UI와 동일한 단일 Pretendard Variable WOFF2를 포함하므로 내보낸 문서의 크기가 약 2 MB 증가합니다.
- 내보내기는 HTML과 PDF(A4) 형식을 지원합니다. 내보내기 전에 외부/누락/지원하지 않는 이미지, 실제 MIME 불일치, 내장 이미지 크기, 페이지 넘침 가능성을 검사하고 사용자의 확인을 받은 뒤 파일을 생성합니다. PDF는 격리된 숨은 BrowserWindow에서 네트워크를 차단한 채 Chromium `printToPDF`로 렌더링합니다.
- 코드 서명과 공식 LG 템플릿/CI 자산은 포함하지 않습니다.
- 보안 취약점은 공개 이슈가 아닌 [GitHub private vulnerability report](https://github.com/SWBaek/lg-report-gen/security/advisories/new)로 신고하고, 일반 지원은 [GitHub Issues](https://github.com/SWBaek/lg-report-gen/issues)를 사용하십시오. 자세한 내용은 [SECURITY.md](SECURITY.md)를 참조하십시오.

## 보안 경계

AI 생성 결과의 임원 요약·사용 근거·가정·주의사항과 모델/프롬프트 버전은 Workspace DB에 보존되며, 편집 화면에서 검토할 수 있습니다. 근거는 report에 연결된 source와 extraction snapshot을 기준으로 검증하고, 삭제 시 Codex thread 정리 실패는 재시도 가능한 retention 상태로 남깁니다.

Renderer에는 Node.js를 노출하지 않습니다. Zod로 검증된 Allowlist IPC만 Preload에서 제공하며, 모든 IPC invoke는 등록된 창·top frame·앱 origin을 확인합니다. `ELECTRON_RENDERER_URL`은 개발 시 loopback만, E2E userData hook은 비패키지 실행에서만 허용합니다. Source 절대경로와 Codex cwd/writable/outputSchema는 Renderer API에 노출하지 않습니다. AI HTML은 Main의 `sanitize-html`과 Renderer의 DOMPurify 양쪽에서 정화합니다. Codex의 Writable Root는 세션별 `agent-work`이며 승인 정책은 `never`, 네트워크는 Sandbox 수준에서 비활성화합니다. 자세한 내용은 [docs/security.md](docs/security.md)를 참조하십시오. HTML/PDF export에는 언어, 작성자, 날짜, revision, classification, header/footer, 페이지 번호 메타데이터가 포함될 수 있으며 파일명은 배타적 reservation과 atomic rename으로 충돌을 방지합니다.

Windows Codex 실행 파일은 Authenticode 상태와 OpenAI publisher 일치 여부를 확인하고, 확인된 경로·버전·SHA-256·signer 상태만 로컬 진단에 사용합니다. 명시한 실행 파일이 실패해도 PATH 설치본으로 자동 전환하지 않으며, 인증 파일·토큰·프롬프트·보고서 내용은 진단 로그에 기록하지 않습니다. 서명 없는 fixture를 쓰는 개발 테스트는 명시적인 개발 override가 필요합니다.
