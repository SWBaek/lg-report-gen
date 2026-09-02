# LG Report Agent

LG Report Agent는 LG전자 내부 사용자를 위한 로컬 우선 표준 보고서 작성·편집 데스크톱 애플리케이션입니다. 보고서의 Canonical Format은 HTML이며, 사용자가 별도로 설치하고 개인 계정으로 로그인한 Codex CLI의 `codex app-server`만 AI 경로로 사용합니다. 별도 OpenAI API Key, 원격 백엔드, Telemetry, 자동 업데이트, Crash Reporting은 없습니다.

현재 테마는 일반 Enterprise 보고서 구조와 교체 가능한 Burgundy Accent를 사용합니다. 공식 LG 로고·상표 이미지·공식 CI 준수 주장은 포함하지 않습니다. 실제 LG 표준 보고서 템플릿은 아직 제공되지 않아 포함되어 있지 않습니다.

## 다운로드

최신 Windows 배포 파일은 [GitHub Releases](https://github.com/SWBaek/lg-report-gen/releases/latest)에서 받을 수 있습니다.

- `LG-Report-Agent-Setup-<version>-x64.exe`: 일반 사용자용 설치 파일
- `LG-Report-Agent-<version>-x64-Portable.exe`: 설치 없이 실행하는 Portable 파일
- `SHA256SUMS.txt`: 다운로드 무결성 확인용 SHA-256 목록

배포 파일은 코드 서명되지 않았으므로 Windows SmartScreen 경고가 표시될 수 있습니다. 실행 전 Release의 `SHA256SUMS.txt`와 다운로드 파일의 해시를 비교하십시오.

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

선택적 실제 Codex Smoke Test는 `npm run test:integration:codex`로 실행하며 일반 테스트에는 실제 계정 호출이 없습니다. Windows 빌드는 `release/LG-Report-Agent-1.0.3-x64-Portable.exe`와 `release/LG-Report-Agent-Setup-1.0.3-x64.exe`를 생성합니다. `npm run check:package-size`는 두 산출물이 각각 110 MiB를 넘지 않는지 검사합니다. 코드 서명이 구성되지 않았으므로 산출물은 unsigned이며 SmartScreen 경고가 나타날 수 있습니다.

`v<package.json version>` 형식의 Tag를 Push하면 `.github/workflows/release.yml`이 검사, Electron E2E, Windows 패키징, 패키지 실행 테스트를 수행하고 EXE와 SHA-256 목록을 GitHub Release에 게시합니다.

## Workspace 구조

```text
<workspace>/
  .lg-report-agent/app.db, backups/, cache/, logs/
  reports/<uuid>/report.html, editor.json, source-originals/, source-extracted/, revisions/, agent-work/, assets/
  chats/<uuid>/agent-work/
  exports/
```

`userData`에는 마지막 Workspace 경로, 최초 동의, 창 위치/크기, Codex 실행 경로처럼 부트스트랩에 필요한 최소 설정만 둡니다. 보고서·대화·첨부 본문은 Workspace에만 저장합니다.

## 현실적 제약

- 스캔 PDF OCR은 제공하지 않으며 텍스트 부족으로 표시합니다.
- PPTX는 슬라이드 텍스트와 표 XML 및 노트 존재를 추출하지만 시각 레이아웃을 재현하지 않습니다.
- CSV는 UTF-8을 우선하며 비 UTF-8 파일은 UTF-8 재저장을 안내합니다.
- A4 편집 화면은 CSS 경계를 제공하고 정확한 페이지 나눔은 인쇄 미리보기를 기준으로 합니다.
- HTML 내보내기는 UI와 동일한 단일 Pretendard Variable WOFF2를 포함하므로 내보낸 문서의 크기가 약 2 MB 증가합니다.
- 코드 서명과 공식 LG 템플릿/CI 자산은 포함하지 않습니다.

## 보안 경계

Renderer에는 Node.js를 노출하지 않습니다. Zod로 검증된 Allowlist IPC만 Preload에서 제공하며 `contextIsolation`, Sandbox, CSP, Navigation 차단을 적용합니다. AI HTML은 Main의 `sanitize-html`과 Renderer의 DOMPurify 양쪽에서 정화합니다. Codex의 cwd와 Writable Root는 세션별 `agent-work`이며 승인 정책은 `never`, 네트워크는 Sandbox 수준에서 비활성화합니다. 자세한 내용은 [docs/security.md](docs/security.md)를 참조하십시오.
