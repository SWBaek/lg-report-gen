# Manual QA checklist

1. 신규 userData에서 앱을 시작해 데이터 경계 동의와 Workspace 생성이 나타나는지 확인한다.
2. 1180×720에서 Sidebar, Wizard, Toolbar, A4 canvas 가로 스크롤을 확인한다.
3. Settings Refresh가 실제 설치/version/account/model을 표시하고 미설치 PATH로 실행했을 때 설치 안내가 나타나는지 확인한다.
4. 각 지원 Source를 첨부해 원본 복사, locator metadata, 부분 실패 Warning을 확인한다.
5. 계획 생성 → outline 수정 → 본문 생성 → 수동 수정 → 재시작 복원을 확인한다.
6. AI 수정 중 본문을 수정해 hash conflict가 자동 적용을 막는지 확인한다. 거절/적용/복원을 확인한다.
7. A4/Web, Print Preview, HTML export offline 표시와 script/on* 부재를 확인한다.
8. 즐겨찾기, rename, duplicate, Trash restore/permanent delete를 확인한다.
9. Chat create/stream/cancel/retry/report conversion/delete와 재시작 복원을 확인한다.
10. AI Turn 중 Codex process를 종료해 crash UI와 재연결을 확인한다.

E2E screenshot은 `artifacts/screenshots`에 저장한다.
