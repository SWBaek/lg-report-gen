# Architecture

Electron Main, Sandbox Preload, React Renderer, Shared Contract의 네 영역으로 분리한다. Main은 Workspace/SQLite/파일 처리/내보내기/Codex child process의 유일한 소유자다. Preload는 `DesktopApi`만 `contextBridge`로 노출하며 Renderer는 파일 시스템, DB, child process를 직접 사용할 수 없다.

Main의 `ApplicationContext`는 현재 Workspace DB와 하나의 장기 실행 Codex App Server Broker를 관리한다. Workspace 전환은 새 경로 검증과 DB open/migration 성공 후 기존 DB를 닫고 Broker를 재시작한다. 보고서 저장은 정화된 HTML과 Tiptap JSON을 임시 파일+fsync+rename으로 기록한다.

Renderer는 Feature별 보고서, Chat, Settings와 공용 Sidebar로 나뉜다. 서버 상태는 Boolean이 아닌 `ProviderSnapshot`으로 전달된다. 공식 템플릿이 들어오면 Export Theme와 보고서 Prompt/Persona를 교체할 수 있다.

HTML Export는 정화된 Canonical Fragment와 별도 `report-theme` 모듈을 조합한다. 이 Theme는 화면용 종이 Layout, 제목·표·인용·근거 표기 스타일, A4 Print CSS, Data URI Pretendard를 포함하며 JavaScript나 외부 Resource를 사용하지 않는다.

## 배포 용량 경계

Renderer와 순수 JavaScript Main 의존성은 Vite가 번들링하고, Electron에서 직접 로드해야 하는 `better-sqlite3`와 PDF.js의 Canvas 네이티브 모듈만 Production Dependency로 외부화한다. UI와 HTML Export는 Renderer Bundle에 포함된 단일 Pretendard Variable WOFF2를 공유한다. Windows Package에는 `ko`, `en-US` Electron Locale만 포함하며, SQLite Source와 Node용 중복 Binary는 제외한다. `check:package-size`는 Portable과 Setup 각각에 110 MiB 상한을 적용해 의존성 중복 회귀를 감지한다.

의존성 선택: electron-vite 5의 Stable peer 범위 때문에 Vite 7을 사용한다. Electron은 공개 보안 advisory가 수정되고 better-sqlite3의 공식 Windows prebuilt ABI와 호환되는 최신 Stable 조합인 42.11.1 / 12.11.1을 사용한다. 설치 스크립트는 Node 테스트용과 Electron 런타임용 native binary를 분리한다. 공식 `pretendard` npm 배포의 Variable WOFF2 한 파일을 UI와 HTML Export가 공유하며 SIL Open Font License 1.1 전문도 Package에 포함한다.
