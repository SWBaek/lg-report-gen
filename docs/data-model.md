# Data model

SQLite는 UTC ISO timestamp, UUID, foreign keys, WAL, transaction을 사용한다. 기존 DB는 migration 전에 SQLite online backup API로 `.lg-report-agent/backups`에 일관된 snapshot을 만들고 `quick_check` 무결성 검증을 통과해야 한다. 백업/검증/migration 오류는 호출자에게 전파한다. `user_version`으로 명시적 migration을 추적하며, 시작 시 `running` AI task는 `interrupted`로 표시하고 filesystem 작업 journal은 staging 상태에 따라 rollback/roll-forward한다.

백업은 `manifest.json`에 SHA-256과 생성 시각을 기록하고 최신 5개를 유지한다. Manifest가 손상되면 새 백업으로 재구성한다. 전체 Workspace 내보내기는 `.lg-report-agent/backups/workspace-<timestamp>-<id>/` 아래에 온라인 DB 백업과 `reports/`의 canonical 문서·원본/추출 source·revision·asset, `chats/`의 안정 상태 파일을 복사하고, 각 파일의 크기와 SHA-256을 `manifest.json`에 기록한다. 증분 내보내기를 요청해도 현재는 복원 단순성과 일관성을 위해 full snapshot을 우선한다. `restoreWorkspaceSnapshotDryRun`은 실제 파일을 바꾸지 않고 snapshot DB `quick_check`, 누락, 크기/hash 불일치를 보고한다. 전체 snapshot은 최신 5개만 보존하며 cache/log/export와 `.staging`/`agent-work`는 보존 대상이 아니다.

목록 성능의 완화된 회귀 예산은 2,000개 report에서 첫 cursor page(100개)를 2초 안에 반환하는 것이다. 이는 성능 보증이나 하드웨어 기준이 아니라 인덱스·wildcard 검색 회귀를 빠르게 감지하는 테스트 예산이다.

- `app_settings`: Workspace 범위 설정
- `personas`: Built-in/Custom Persona, 기본값
- `reports`: 제목, 목적, Persona/출력 옵션, Layout, workspace-relative canonical locator, current revision, Codex thread, favorite, soft delete. `canonical_schema_version`, `html_projection_hash`, `editor_json_hash`로 Tiptap JSON과 HTML projection의 버전을 확인한다.
- `report_revisions`: versioned JSON envelope snapshot(편집기 JSON·HTML·title·purpose·output options·layout), 이유, 설명, base hash와 양쪽 projection hash
- `report_sources`: 원본/추출 경로, MIME, size, SHA-256, 상태, metadata, warning
- `tags`, `report_tags`: 다대다 Tag
- `chat_sessions`, `chat_messages`: 일반/보고서 AI session과 앱 표시 기록. 일반 Chat의 선택 모델과 Reasoning Effort는 session별로 저장한다. Report chat은 활성 `report_id`당 하나이며 메시지는 session별 단조 증가 `sequence`로 정렬한다.
- `ai_tasks`: 작업 종류, 상태, 안전한 오류 metadata
- `operation_journal`: report 파일 생성·저장·복원·삭제의 staging → files_committed → completed 상태, stage/backup/quarantine 경로와 안전한 오류 metadata. 시작 시 staged 작업은 rollback하고 files_committed 작업은 payload로 roll-forward한다. 삭제는 report UUID 디렉터리를 quarantine으로 먼저 atomic move한 뒤 DB transaction과 정리를 수행한다.
- `report_generations`: AI 생성별 executive summary, source usage, assumptions, warnings, model, prompt version, 생성 당시 source extraction snapshot hash를 보존한다. source ID는 해당 report에 속해야 한다. 모델이 존재하지 않는 ID나 읽을 수 없는 snapshot을 참조하면 해당 근거만 제외하고 검토 경고를 남기며, 유효한 보고서 본문 저장까지 막지는 않는다.
- `report_claim_evidence`: 생성 결과의 주장(claim)과 source ID/locator를 연결하는 ledger. 조회 IPC는 보고서별 생성 이력과 ledger를 제공한다.
- `deletion_retention`: report/chat의 로컬 삭제 결과와 Codex thread 삭제 결과를 분리 기록한다. Codex 삭제 실패 thread는 `pending`으로 남고 재시도 IPC를 통해 반복 처리할 수 있다.

대용량 원본과 보고서 Snapshot은 파일에 두고 DB에는 관계와 workspace-relative locator를 둔다. v1~v3의 absolute path는 migration 시 `reports/<reportId>/...` locator로 변환하며, 실제 경로는 WorkspaceLocator에서만 resolve한다. 사용 직전 realpath containment 및 심볼릭 링크/junction 검증을 수행한다. Canonical report/editor/revision 파일 읽기 실패는 빈 문서로 대체하지 않는다. HTML 입력만 있는 legacy/create 요청은 동일한 HTML에서 Tiptap JSON을 생성해 두 projection이 비어 있는 문서로 갈라지지 않게 한다.
