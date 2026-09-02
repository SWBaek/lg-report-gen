# Data model

SQLite는 UTC ISO timestamp, UUID, foreign keys, WAL, transaction을 사용한다. Migration 전 `.lg-report-agent/backups`에 DB를 복사하고 `user_version`으로 명시적 migration을 추적한다. 시작 시 `running` AI task는 `interrupted`로 정리한다.

- `app_settings`: Workspace 범위 설정
- `personas`: Built-in/Custom Persona, 기본값
- `reports`: 제목, 목적, Persona/출력 옵션, Layout, canonical/editor 경로, current revision, Codex thread, favorite, soft delete
- `report_revisions`: 파일 snapshot, 이유, 설명, base hash
- `report_sources`: 원본/추출 경로, MIME, size, SHA-256, 상태, metadata, warning
- `tags`, `report_tags`: 다대다 Tag
- `chat_sessions`, `chat_messages`: 일반/보고서 AI session과 앱 표시 기록. 일반 Chat의 선택 모델과 Reasoning Effort는 session별로 저장한다.
- `ai_tasks`: 작업 종류, 상태, 안전한 오류 metadata

대용량 원본과 보고서 Snapshot은 파일에 두고 DB에는 관계와 경로를 둔다. 영구 삭제는 DB cascade 이후 해당 UUID 디렉터리만 제거한다.
