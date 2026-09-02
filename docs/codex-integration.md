# Codex App Server integration

`CodexAppServerManager`는 탐색된 실행 파일을 argv 기반 `cross-spawn(executable, ['app-server','--stdio'])`로 시작한다. Shell 문자열을 만들지 않는다. stdio JSONL은 줄 단위로 파싱하고 증가 Request ID, correlation map, timeout, 100개 Queue 상한, malformed JSON 제한, crash 감지, 제한된 지수 backoff 재연결, 앱 종료 시 Windows process tree 정리를 제공한다.

초기화 순서는 `initialize` → `initialized` → 병렬 `account/read`, `model/list`다. 모델 ID는 하드코딩하지 않고 `isDefault`, 기본/지원 Reasoning Effort, 이미지 입력 기능을 동적으로 반영한다. 새 보고서의 고급 설정은 조회된 모델과 해당 모델이 실제 광고한 Effort만 표시하며 선택값을 보고서 옵션에 저장한다. 로그인은 `account/login/start`의 ChatGPT browser flow URL만 HTTPS 외부 브라우저로 연다. API Key 입력 UI와 인증 파일 읽기는 없다.

Thread는 Chat/Report AI session별로 SQLite에 저장한다. Turn은 `approvalPolicy: never`, 세션별 `agent-work` cwd/runtimeWorkspaceRoots, `read-only` 또는 정확한 해당 폴더만 `workspaceWrite`, network disabled, environments disabled로 시작한다. `danger-full-access`는 사용하지 않는다. 스트리밍은 `item/agentMessage/delta`, 완료는 `turn/completed`, 취소는 `turn/interrupt`를 사용한다. 완료 시 `turn.items`의 `final_answer` Agent Message를 권위 있는 결과로 사용하여 중간 commentary와 최종 응답이 결합되지 않게 한다. Structured Output은 JSON Schema를 `outputSchema`로 보내며, Markdown fence나 앞뒤 설명이 있는 호환 응답도 마지막 Schema-valid JSON만 추출한 뒤 Zod/HTML 정화를 거친다. 생성 화면에는 원시 JSON 대신 진행 상태와 수신 크기만 표시한다.

CLI 버전별 알 수 없는 응답 필드는 무시하고 필요한 필드만 Zod로 확인한다. App Server가 없으면 TUI나 `codex exec`로 우회하지 않고 업데이트 필요 상태를 표시한다.
