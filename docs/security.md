# Security

- BrowserWindow: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`.
- CSP는 self script/font/image만 허용하고 remote script/style, object, frame, form, network connection을 차단한다.
- `window.open`과 임의 Navigation을 차단한다. 외부 문서는 목적별 exact URL Allowlist로만 열며, Codex 로그인 URL은 `https://auth.openai.com` 또는 `https://chatgpt.com` origin만 허용한다.
- IPC 채널은 공유 상수 Allowlist이며 입력을 Zod로 검증한다. 모든 invoke는 등록된 앱 BrowserWindow의 WebContents, top frame, trusted renderer origin을 공통으로 확인한다.
- 개발용 `ELECTRON_RENDERER_URL`은 loopback HTTP(S) origin만 허용한다. 패키지 실행에서는 이 값과 `LG_REPORT_AGENT_E2E_USER_DATA`를 모두 무시한다.
- Renderer는 Source 절대경로 대신 Main이 발급한 TTL 일회성 selection ID만 전달하며, Codex의 session/thread ID, cwd·writable·outputSchema는 Main이 DB 세션과 intent에서 결정한다. Renderer가 보낸 model/effort는 Main의 현재 provider catalog와 session 설정으로 다시 검증한다. Report/Revision/Source 공개 DTO에는 내부 파일 경로가 없다.
- HTML은 script/style/iframe/object/embed/form/input/button, inline style, on* handler를 허용하지 않는다. 이미지 URL은 data 또는 보고서 내부 상대 경로만 Export 시 포함한다.
- Export preflight는 HTML parser 기반 asset registry로 이미지 URL을 확인하고, 보고서 디렉터리 realpath containment·파일 magic MIME·개별 10 MiB/전체 40 MiB 한도를 적용한다. PDF 렌더링은 sandbox/contextIsolation을 켠 별도 hidden BrowserWindow와 전용 session에서 수행하며 HTTP/HTTPS/file 요청을 취소한다.
- Export filename은 `.lock` 파일을 `wx`로 먼저 예약하고, HTML/PDF 본문은 flush 후 atomic rename한다. 승인 토큰은 Main에서 발급하는 TTL 일회성 값이며 형식과 report ID에 묶여 있다.
- Path traversal은 resolved root prefix로 검증하며 Windows 예약명과 위험 문자를 제거한다.
- Codex는 인증 파일/토큰/API Key를 읽거나 저장하지 않는다. stderr는 token-like 문자열과 이메일을 가리고 크기를 제한한다.
- Windows에서 Codex 실행 파일은 `Get-AuthenticodeSignature`를 `shell:false`, 숨김 창, 15초 timeout으로 조회한다. 검사 경로는 PowerShell 명령문에 보간하지 않고 전용 환경변수로 전달하며, Windows PowerShell의 기본 Security module 경로만 사용해 부모 PowerShell 버전의 module-path 오염을 차단한다. 기본 publisher는 `OpenAI`이며 `Valid` 서명과 publisher 일치가 모두 필요하다. 경로·CLI version·SHA-256·signer·signature status는 내용 없이 로컬 진단에만 사용할 수 있다. 서명 없는 개발 fixture는 `NODE_ENV=development|test`에서 `LG_REPORT_AGENT_CODEX_ALLOW_UNSIGNED_DEV=1`을 함께 지정한 경우에만 허용하며, 패키지 실행에는 적용되지 않는다.
- 사용자가 지정한 Codex 경로가 존재하지 않거나 실행/버전 검증에 실패하면 PATH나 알려진 설치 위치로 조용히 대체하지 않는다. App Server 지원 버전 범위 밖의 CLI도 거부한다.
- Prompt, 첨부 본문, 보고서 HTML은 진단 로그에 쓰지 않는다. Telemetry/Crash Reporter/자동 업데이트는 없다.
- AI prompt에는 요청·첨부·현재 HTML을 명시적인 untrusted envelope로 감싸 전달하며, 구조화 출력은 버전(1), 문자열/배열 상한, Zod 검증을 통과해야 한다. 생성 provenance와 claim/evidence 연결은 source extraction snapshot hash와 함께 저장되고, 삭제된 report/chat의 Codex thread 정리 실패는 pending retention으로만 보존한다.
- Workspace는 UNC 경로와 Windows 네트워크 드라이브를 기본 거부한다(`WORKSPACE_REMOTE_UNSUPPORTED`). OneDrive, Dropbox, Google Drive, Box Drive, iCloud Drive, Syncthing 등 동기화 폴더는 경로와 junction의 정규 경로를 대소문자 비구분으로 진단하며 `inspectWorkspacePolicy`의 경고/정책 결과를 사용한다. 필요하면 `rejectSynchronizedFolder` 정책으로 명시 거부할 수 있다. 길이 1,024자를 넘는 경로도 선택할 수 없다.
- SQLite는 WAL과 함께 durability 우선 설정(`synchronous=FULL`)을 사용하고, canonical/export 파일은 임시 파일 flush 후 atomic rename으로 기록한다.
- Codex report turn의 읽기 기준은 report 디렉터리지만 writable root는 `agent-work/output` 하나뿐이며 `source-originals`, `source-extracted`, `evidence`, DB, canonical HTML, 설치 디렉터리, 다른 보고서는 포함하지 않는다. 승인 정책은 `never`, network disabled다.

현재 Windows Sandbox 구현은 설치된 Codex의 App Server sandbox 정책에 의존한다. 파일 system ACL을 별도 재작성하지 않는다.

## 저장소 및 릴리스 거버넌스

PR과 `main` push는 `candidate-checks` required candidate check를 통과해야 하며, CodeQL과 dependency review가 변경과 정기 스캔을 수행한다. GitHub Actions는 가능한 경우 전체 commit SHA로 고정하고 Dependabot이 고정 버전 업데이트를 제안한다. GitHub Advanced Security의 secret scanning/push protection은 조직 또는 저장소 관리자가 **Settings → Security → Advanced Security**에서 별도로 활성화해야 한다.

릴리스는 signing-required gate, Electron fuse 검사, SHA-256 checksum, CycloneDX/SPDX SBOM, production dependency license bundle 및 GitHub artifact provenance attestation을 포함한다. 실제 인증서는 저장소에 넣지 않고 `WINDOWS_CERTIFICATE_BASE64`, `WINDOWS_CERTIFICATE_PASSWORD` Secret과 `RELEASE_SIGNING_REQUIRED` Variable로만 주입한다. 미구성 환경의 개발 패키지는 unsigned임을 Release notes에 명시한다. 운영/롤백 규칙은 [release-operations.md](release-operations.md)에 기록한다.

현재 renderer는 `file://`를 사용하므로 `grantFileProtocolExtraPrivileges` fuse를 유지한다. custom `app://` protocol 전환을 완료한 뒤에만 이 privilege를 비활성화한다.
