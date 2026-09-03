# Manual QA checklist

실제 설치된 Codex CLI의 계정·모델 조회, 일반 응답, 보고서 Structured Output 계약은 `npm run test:integration:codex`로 확인한다. 이 검사는 사용자의 Codex 계정을 실제로 사용하므로 명시적인 로컬 QA에서만 실행하고 CI 기본 검사에는 포함하지 않는다.

1. 신규 userData에서 앱을 시작해 데이터 경계 동의와 Workspace 생성이 나타나는지 확인한다.
2. 1180×720에서 Sidebar, Wizard, Toolbar, A4 canvas 가로 스크롤을 확인한다.
3. Settings Refresh가 실제 설치/version/account/model을 표시하고 미설치 PATH로 실행했을 때 설치 안내가 나타나는지 확인한다.
4. 각 지원 Source를 첨부해 원본 복사, locator metadata, 부분 실패 Warning을 확인한다.
5. 계획 생성 → outline 수정 → 본문 생성 → 수동 수정 → 재시작 복원을 확인한다.
6. AI 수정 중 본문을 수정해 hash conflict가 자동 적용을 막는지 확인한다. 거절/적용/복원을 확인한다.
7. A4/Web, Print Preview, HTML/PDF export를 각각 확인한다. preflight의 외부/누락 이미지 경고를 확인하고 승인 후 생성되는 파일에서 script/on* 부재, PDF A4 페이지 크기, header/footer/page number를 확인한다.
8. 즐겨찾기, rename, duplicate, Trash restore/permanent delete를 확인한다.
9. Chat create/stream/cancel/retry/report conversion/delete와 재시작 복원을 확인한다.
10. AI Turn 중 Codex process를 종료해 crash UI와 재연결을 확인한다.

E2E screenshot은 `artifacts/screenshots`에 저장한다.
