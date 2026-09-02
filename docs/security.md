# Security

- BrowserWindow: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`.
- CSP는 self script/font/image만 허용하고 remote script/style, object, frame, form, network connection을 차단한다.
- `window.open`과 임의 Navigation을 차단한다. 사용자가 누른 공식 링크만 Zod가 `https://`를 확인한 뒤 `shell.openExternal`로 연다.
- IPC 채널은 공유 상수 Allowlist이며 입력을 Zod로 검증한다.
- HTML은 script/style/iframe/object/embed/form/input/button, inline style, on* handler를 허용하지 않는다. 이미지 URL은 data 또는 보고서 내부 상대 경로만 Export 시 포함한다.
- Path traversal은 resolved root prefix로 검증하며 Windows 예약명과 위험 문자를 제거한다.
- Codex는 인증 파일/토큰/API Key를 읽거나 저장하지 않는다. stderr는 token-like 문자열과 이메일을 가리고 크기를 제한한다.
- Prompt, 첨부 본문, 보고서 HTML은 진단 로그에 쓰지 않는다. Telemetry/Crash Reporter/자동 업데이트는 없다.
- Codex writable root는 해당 session의 `agent-work` 하나이며 DB, canonical HTML, 설치 디렉터리, 다른 보고서는 포함하지 않는다. 승인 정책은 `never`, network disabled다.

현재 Windows Sandbox 구현은 설치된 Codex의 App Server sandbox 정책에 의존한다. 파일 system ACL을 별도 재작성하지 않는다.
