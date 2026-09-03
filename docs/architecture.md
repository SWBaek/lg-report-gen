# Architecture

Electron Main, Sandbox Preload, React Renderer, Shared Contract의 네 영역으로 분리한다. Main은 Workspace/SQLite/파일 처리/내보내기/Codex child process의 유일한 소유자다. Preload는 `DesktopApi`만 `contextBridge`로 노출하며 Renderer는 파일 시스템, DB, child process를 직접 사용할 수 없다. 보고서의 canonical 문서는 versioned Tiptap JSON이고 HTML은 sanitised projection이다.

사용자 설정 `bootstrap.json`은 Zod 형태 검증을 거친다. 파일이 없는 경우에만 기본값을 사용하고, JSON이 손상되거나 schema가 맞지 않으면 `.corrupt-<timestamp>-<uuid>`로 격리한 뒤 기본 설정으로 복구한다. 그 외 파일시스템 오류는 전파한다.

Main의 `ApplicationContext`는 현재 Workspace DB와 하나의 장기 실행 Codex App Server Broker를 관리한다. Workspace 전환은 새 경로 검증과 DB open/migration 성공 후 기존 DB를 닫고 Broker를 재시작한다. SQLite는 WAL 상태에서 online backup과 integrity check를 수행한 뒤 migration하며, 실패를 숨기지 않는다. 보고서 저장은 정화된 HTML과 Tiptap JSON을 임시 파일+fsync+rename으로 기록하고 operation journal에 상태를 남긴다. Workspace 파일 경로는 locator로 생성하고 사용 직전 realpath containment를 재검증하여 junction/symlink를 통한 workspace 탈출을 막는다.

SQLite 연결은 `synchronous=FULL`을 명시해 성공한 transaction의 저장 완료를 확인한다. Workspace 전체 snapshot은 online backup DB와 canonical 문서/source/revision 파일을 hash manifest로 묶고 최신 5개를 보존한다. 복원 전 dry-run은 snapshot DB의 `quick_check`와 파일별 누락/hash 불일치를 보고하며 실제 Workspace를 변경하지 않는다. 현재 증분 요청도 full snapshot으로 처리해 DB와 파일의 시점이 어긋나는 위험을 줄인다.

Renderer는 Feature별 보고서, Chat, Settings와 공용 Sidebar로 나뉜다. 서버 상태는 Boolean이 아닌 `ProviderSnapshot`으로 전달된다. 공식 템플릿이 들어오면 Export Theme와 보고서 Prompt/Persona를 교체할 수 있다.

## 보고서 저장 복구

생성·저장·복원은 journal에 staging 디렉터리와 backup을 등록한 뒤 두 canonical projection을 준비하고 함께 승격한다. DB metadata commit 전 프로세스가 종료되면 다음 시작 시 staged 파일은 rollback하고, 이미 승격된 파일은 journal payload로 DB를 roll-forward한다. 삭제는 UUID 디렉터리를 `.lg-report-agent/quarantine`으로 atomic move한 후 DB cascade transaction을 수행하고 quarantine을 정리한다. quarantine/backup 정리에 실패해도 원본을 즉시 파괴하지 않고 journal에 recovery 상태를 남긴다.

HTML Export는 정화된 Canonical Fragment와 별도 `report-theme` 모듈을 조합한다. 이 Theme는 화면용 종이 Layout, 제목·표·인용·근거 표기 스타일, A4 Print CSS, Data URI Pretendard를 포함하며 JavaScript나 외부 Resource를 사용하지 않는다.

보고서 목록은 LIKE 입력의 `%`, `_`, `\\`를 escape하고 `ESCAPE` 절을 사용한다. 내부 cursor API는 updated/title 정렬의 동률을 ID로 해소해 한국어 제목과 대규모 목록에서도 중복·누락 없는 페이지 경계를 제공한다.

## 배포 용량 경계

Renderer와 순수 JavaScript Main 의존성은 Vite가 번들링하고, Electron에서 직접 로드해야 하는 `better-sqlite3`와 PDF.js의 Canvas 네이티브 모듈만 Production Dependency로 외부화한다. UI와 HTML Export는 Renderer Bundle에 포함된 단일 Pretendard Variable WOFF2를 공유한다. Windows Package에는 `ko`, `en-US` Electron Locale만 포함하며, SQLite Source와 Node용 중복 Binary는 제외한다. `check:package-size`는 Portable과 Setup 각각에 110 MiB 상한을 적용해 의존성 중복 회귀를 감지한다.

의존성 선택: electron-vite 5의 Stable peer 범위 때문에 Vite 7을 사용한다. Electron은 공개 보안 advisory가 수정되고 better-sqlite3의 공식 Windows prebuilt ABI와 호환되는 최신 Stable 조합인 42.11.1 / 12.11.1을 사용한다. 설치 스크립트는 Node 테스트용과 Electron 런타임용 native binary를 분리한다. 공식 `pretendard` npm 배포의 Variable WOFF2 한 파일을 UI와 HTML Export가 공유하며 SIL Open Font License 1.1 전문도 Package에 포함한다.
