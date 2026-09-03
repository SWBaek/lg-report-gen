import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'htmlparser2';
import type {
  ChatMessage,
  ChatSession,
  Persona,
  Report,
  ReportOutputOptions,
  ReportSummary,
  ReportGenerationRecord,
  SourceUsage,
  ClaimEvidence,
  DeletionRetention,
  Revision,
  SourceManifestEntry,
} from '../../shared/types/index.js';
import { reportOutputOptionsSchema } from '../../shared/schemas/index.js';
import { saveReportSchema } from '../../shared/schemas/index.js';
import {
  atomicWrite,
  assertContainedRealpath,
  contentHash,
  sanitizeReportHtml,
} from '../services/files.js';
import type { WorkspacePaths } from '../workspace/manager.js';
import { backupDatabaseOnline, locatorFor } from '../workspace/manager.js';

const now = (): string => new Date().toISOString();
const CANONICAL_SCHEMA_VERSION = 1;
const EMPTY_TIPTAP_DOC = { type: 'doc', content: [] } as const;
const require = createRequire(import.meta.url);
function nativeBinding(): string | undefined {
  if (!process.versions.electron) return undefined;
  const moduleRoot = path.dirname(require.resolve('better-sqlite3/package.json'));
  return path
    .join(moduleRoot, 'native', 'better_sqlite3-electron.node')
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}
const DEFAULT_OPTIONS: ReportOutputOptions = {
  tone: 'standard',
  audience: 'manager',
  length: 'standard',
  format: 'balanced',
  language: 'ko',
  conclusionFirst: true,
  terminology: 'standard',
  evidence: 'standard',
  model: null,
  reasoningEffort: null,
};

export interface ReportListPage {
  items: ReportSummary[];
  nextCursor: string | null;
}

export interface ReportListPageOptions {
  includeDeleted?: boolean;
  query?: string;
  sort?: 'updated' | 'title';
  limit?: number;
  cursor?: string | null;
}
const BUILT_INS = [
  [
    '임원 보고용',
    '결론 우선, 핵심 수치와 영향',
    '위험, 의사결정, 요청사항을 먼저 제시하고 기술 세부는 최소화한다.',
  ],
  ['팀장/관리자 보고용', '목적·현황·이슈·대응·일정', '책임과 후속 조치를 명확히 한다.'],
  ['실무 검토용', '근거와 상세 과정', '재현 과정과 실행 항목을 구체적으로 작성한다.'],
  ['기술 전문가용', '가정·방법·데이터·제약', '불확실성을 명시하고 용어는 최초 사용 시 정의한다.'],
  ['고객/OEM 전달용', '공식적이고 중립적인 표현', '내부 용어를 제거하고 사실과 계획을 구분한다.'],
  ['회의 결과 보고용', '논의·결정·미결·담당·기한', '회의 결과를 실행 가능한 항목으로 정리한다.'],
  [
    '문제 원인 및 대책 보고용',
    '문제·영향·조치·원인·대책',
    '근본 원인과 재발 방지, 담당 및 일정을 명시한다.',
  ],
  ['의사결정 요청용', '배경·선택지·비교·권고', '평가 기준과 요청하는 결정을 명확히 한다.'],
] as const;

export class AppDatabase {
  private db: Database.Database | null = null;
  constructor(private paths: WorkspacePaths) {}
  async open(): Promise<void> {
    await mkdir(this.paths.internal, { recursive: true });
    const hadDatabase = await fileExists(this.paths.database);
    const binding = nativeBinding();
    const db = new Database(this.paths.database, binding ? { nativeBinding: binding } : undefined);
    this.db = db;
    try {
      db.pragma('foreign_keys = ON');
      db.pragma('journal_mode = WAL');
      // FULL makes a successful transaction durable across an OS crash.  This
      // is intentionally explicit instead of relying on SQLite's default.
      db.pragma('synchronous = FULL');
      // Backup and verify before any migration mutates the live database. The
      // online backup API includes pages still present in the WAL file.
      if (hadDatabase) await backupDatabaseOnline(this.paths, db);
      assertDatabaseIntegrity(db);
      this.migrate();
      assertDatabaseIntegrity(db);
      await this.reconcileOperations();
      db.prepare(
        "UPDATE ai_tasks SET state='interrupted', completed_at=? WHERE state='running'",
      ).run(now());
      this.seedPersonas();
    } catch (error) {
      db.close();
      this.db = null;
      throw error;
    }
  }
  close(): void {
    this.db?.close();
    this.db = null;
  }
  private get connection(): Database.Database {
    if (!this.db) throw new Error('DATABASE_OPEN_FAILED');
    return this.db;
  }
  private migrate(): void {
    const db = this.connection;
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version < 1)
      db.transaction(() => {
        db.exec(`
      CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE personas(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,instructions TEXT NOT NULL,is_built_in INTEGER NOT NULL DEFAULT 0,is_default INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE reports(id TEXT PRIMARY KEY,title TEXT NOT NULL,purpose TEXT NOT NULL,persona_id TEXT REFERENCES personas(id),persona_config TEXT NOT NULL DEFAULT '{}',output_options TEXT NOT NULL,layout_mode TEXT NOT NULL CHECK(layout_mode IN ('a4','web')),content_path TEXT NOT NULL,editor_state_path TEXT NOT NULL,current_revision_id TEXT,codex_thread_id TEXT,is_favorite INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
      CREATE TABLE report_revisions(id TEXT PRIMARY KEY,report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,snapshot_path TEXT NOT NULL,reason TEXT NOT NULL,description TEXT NOT NULL,base_content_hash TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE report_sources(id TEXT PRIMARY KEY,report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,original_name TEXT NOT NULL,stored_path TEXT NOT NULL,mime_type TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,extraction_status TEXT NOT NULL CHECK(extraction_status IN ('pending','extracting','ready','partial','failed')),extracted_path TEXT,metadata TEXT NOT NULL,warnings TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE tags(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
      CREATE TABLE report_tags(report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,PRIMARY KEY(report_id,tag_id));
      CREATE TABLE chat_sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('general','report')),report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,codex_thread_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
      CREATE TABLE chat_messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),content TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('streaming','complete','failed','interrupted')),created_at TEXT NOT NULL,sequence INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE ai_tasks(id TEXT PRIMARY KEY,session_type TEXT NOT NULL CHECK(session_type IN ('chat','report')),session_id TEXT NOT NULL,operation TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('running','completed','failed','interrupted')),started_at TEXT NOT NULL,completed_at TEXT,error_code TEXT,safe_error_message TEXT);
      CREATE INDEX reports_updated_idx ON reports(updated_at DESC); CREATE INDEX messages_session_idx ON chat_messages(session_id,created_at);
    `);
        db.pragma('user_version = 1');
      })();
    if (version < 2)
      db.transaction(() => {
        db.exec(
          'ALTER TABLE chat_sessions ADD COLUMN model TEXT; ALTER TABLE chat_sessions ADD COLUMN reasoning_effort TEXT;',
        );
        db.pragma('user_version = 2');
      })();
    if (version < 3)
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS operation_journal(
            id TEXT PRIMARY KEY,
            operation TEXT NOT NULL,
            target TEXT NOT NULL,
            state TEXT NOT NULL,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            error_code TEXT,
            safe_error_message TEXT
          );
          CREATE INDEX IF NOT EXISTS operation_journal_state_idx ON operation_journal(state, started_at);
        `);
        db.pragma('user_version = 3');
      })();
    if (version < 4)
      db.transaction(() => {
        db.exec(`
          ALTER TABLE reports ADD COLUMN canonical_schema_version INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE reports ADD COLUMN html_projection_hash TEXT NOT NULL DEFAULT '';
          ALTER TABLE reports ADD COLUMN editor_json_hash TEXT NOT NULL DEFAULT '';
          ALTER TABLE report_revisions ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE report_revisions ADD COLUMN editor_json TEXT;
          ALTER TABLE report_revisions ADD COLUMN html TEXT;
          ALTER TABLE report_revisions ADD COLUMN title TEXT;
          ALTER TABLE report_revisions ADD COLUMN purpose TEXT;
          ALTER TABLE report_revisions ADD COLUMN output_options TEXT;
          ALTER TABLE report_revisions ADD COLUMN layout_mode TEXT;
          ALTER TABLE report_revisions ADD COLUMN html_projection_hash TEXT;
          ALTER TABLE report_revisions ADD COLUMN editor_json_hash TEXT;
          ALTER TABLE operation_journal ADD COLUMN phase TEXT NOT NULL DEFAULT 'running';
          ALTER TABLE operation_journal ADD COLUMN stage_path TEXT;
          ALTER TABLE operation_journal ADD COLUMN backup_path TEXT;
          ALTER TABLE operation_journal ADD COLUMN payload TEXT;
        `);
        // v1-v3 stored absolute paths. The path in the database is now only a
        // stable workspace-relative locator; the WorkspaceLocator resolves it.
        db.prepare(
          "UPDATE reports SET content_path='reports/' || id || '/report.html', editor_state_path='reports/' || id || '/editor.json'",
        ).run();
        db.prepare(
          "UPDATE report_revisions SET snapshot_path='reports/' || report_id || '/revisions/' || id || '.html'",
        ).run();
        this.migrateSourcePaths(db);
        db.pragma('user_version = 4');
      })();
    if (version < 5)
      db.transaction(() => {
        // The columns above are deliberately nullable for old snapshots. They
        // are backfilled lazily on first read, preserving v1-v3 databases even
        // when their legacy HTML snapshots do not have an editor document.
        db.prepare(
          "UPDATE operation_journal SET phase=CASE WHEN state='running' THEN 'running' ELSE state END WHERE phase IS NULL OR phase='' ",
        ).run();
        db.pragma('user_version = 5');
      })();
    if (version < 6)
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS report_generations(
            id TEXT PRIMARY KEY,
            report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
            schema_version INTEGER NOT NULL DEFAULT 1,
            executive_summary TEXT NOT NULL,
            source_usage TEXT NOT NULL,
            assumptions TEXT NOT NULL,
            warnings TEXT NOT NULL,
            model TEXT,
            prompt_version TEXT NOT NULL,
            source_snapshot_hashes TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS report_claim_evidence(
            id TEXT PRIMARY KEY,
            generation_id TEXT NOT NULL REFERENCES report_generations(id) ON DELETE CASCADE,
            claim TEXT NOT NULL,
            source_id TEXT NOT NULL,
            locator TEXT NOT NULL,
            evidence_excerpt TEXT
          );
          CREATE INDEX IF NOT EXISTS report_generations_report_idx ON report_generations(report_id,created_at DESC);
          CREATE INDEX IF NOT EXISTS report_claim_evidence_generation_idx ON report_claim_evidence(generation_id);
          CREATE TABLE IF NOT EXISTS deletion_retention(
            id TEXT PRIMARY KEY,
            owner_type TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            codex_thread_ids TEXT NOT NULL,
            pending_thread_ids TEXT NOT NULL,
            local_state TEXT NOT NULL,
            codex_state TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS deletion_retention_pending_idx ON deletion_retention(codex_state,updated_at);
        `);
        db.pragma('user_version = 6');
      })();
    if (version < 7)
      db.transaction(() => {
        // SQLite cannot add a CHECK constraint to an existing table without a
        // table rebuild.  These triggers provide the same rejection semantics
        // while leaving old v1-v6 files and their columns untouched.
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS reports_layout_mode_guard
          BEFORE INSERT ON reports WHEN NEW.layout_mode NOT IN ('a4','web')
          BEGIN SELECT RAISE(ABORT,'INVALID_LAYOUT_MODE'); END;
          CREATE TRIGGER IF NOT EXISTS reports_layout_mode_update_guard
          BEFORE UPDATE OF layout_mode ON reports WHEN NEW.layout_mode NOT IN ('a4','web')
          BEGIN SELECT RAISE(ABORT,'INVALID_LAYOUT_MODE'); END;
          CREATE TRIGGER IF NOT EXISTS chat_kind_guard
          BEFORE INSERT ON chat_sessions WHEN NEW.kind NOT IN ('general','report')
          BEGIN SELECT RAISE(ABORT,'INVALID_CHAT_KIND'); END;
          CREATE TRIGGER IF NOT EXISTS chat_kind_update_guard
          BEFORE UPDATE OF kind ON chat_sessions WHEN NEW.kind NOT IN ('general','report')
          BEGIN SELECT RAISE(ABORT,'INVALID_CHAT_KIND'); END;
          CREATE TRIGGER IF NOT EXISTS message_role_state_guard
          BEFORE INSERT ON chat_messages
          WHEN NEW.role NOT IN ('user','assistant','system') OR NEW.state NOT IN ('streaming','complete','failed','interrupted')
          BEGIN SELECT RAISE(ABORT,'INVALID_MESSAGE_ENUM'); END;
          CREATE TRIGGER IF NOT EXISTS message_role_state_update_guard
          BEFORE UPDATE OF role,state ON chat_messages
          WHEN NEW.role NOT IN ('user','assistant','system') OR NEW.state NOT IN ('streaming','complete','failed','interrupted')
          BEGIN SELECT RAISE(ABORT,'INVALID_MESSAGE_ENUM'); END;
          CREATE TRIGGER IF NOT EXISTS source_status_guard
          BEFORE INSERT ON report_sources
          WHEN NEW.extraction_status NOT IN ('pending','extracting','ready','partial','failed')
          BEGIN SELECT RAISE(ABORT,'INVALID_SOURCE_STATUS'); END;
          CREATE TRIGGER IF NOT EXISTS source_status_update_guard
          BEFORE UPDATE OF extraction_status ON report_sources
          WHEN NEW.extraction_status NOT IN ('pending','extracting','ready','partial','failed')
          BEGIN SELECT RAISE(ABORT,'INVALID_SOURCE_STATUS'); END;
          CREATE TRIGGER IF NOT EXISTS ai_task_enum_guard
          BEFORE INSERT ON ai_tasks
          WHEN NEW.session_type NOT IN ('chat','report') OR NEW.state NOT IN ('running','completed','failed','interrupted')
          BEGIN SELECT RAISE(ABORT,'INVALID_AI_TASK_ENUM'); END;
          CREATE TRIGGER IF NOT EXISTS ai_task_enum_update_guard
          BEFORE UPDATE OF session_type,state ON ai_tasks
          WHEN NEW.session_type NOT IN ('chat','report') OR NEW.state NOT IN ('running','completed','failed','interrupted')
          BEGIN SELECT RAISE(ABORT,'INVALID_AI_TASK_ENUM'); END;
        `);
        const messageColumns = db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{
          name: string;
        }>;
        if (!messageColumns.some((column) => column.name === 'sequence'))
          db.exec('ALTER TABLE chat_messages ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0');
        const rows = db
          .prepare(
            'SELECT rowid,session_id FROM chat_messages ORDER BY session_id,created_at,rowid',
          )
          .all() as Array<{ rowid: number; session_id: string }>;
        const counters = new Map<string, number>();
        const updateSequence = db.prepare('UPDATE chat_messages SET sequence=? WHERE rowid=?');
        for (const row of rows) {
          const sequence = (counters.get(row.session_id) ?? 0) + 1;
          counters.set(row.session_id, sequence);
          updateSequence.run(sequence, row.rowid);
        }
        // Keep the most recently updated active report chat when repairing old
        // databases that happened to contain duplicates.
        const chats = db
          .prepare(
            'SELECT id,report_id,updated_at FROM chat_sessions WHERE report_id IS NOT NULL AND deleted_at IS NULL ORDER BY report_id,updated_at DESC,id DESC',
          )
          .all() as Array<{ id: string; report_id: string }>;
        const seen = new Set<string>();
        const retire = db.prepare(
          'UPDATE chat_sessions SET deleted_at=COALESCE(deleted_at,updated_at) WHERE id=?',
        );
        for (const chat of chats) {
          if (seen.has(chat.report_id)) retire.run(chat.id);
          else seen.add(chat.report_id);
        }
        db.exec(
          'CREATE UNIQUE INDEX IF NOT EXISTS chat_sessions_active_report_unique ON chat_sessions(report_id) WHERE report_id IS NOT NULL AND deleted_at IS NULL; CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_session_sequence_unique ON chat_messages(session_id,sequence);',
        );
        db.pragma('user_version = 7');
      })();
  }
  private migrateSourcePaths(db: Database.Database): void {
    const rows = db
      .prepare('SELECT id,stored_path,extracted_path FROM report_sources')
      .all() as Array<{ id: string; stored_path: string; extracted_path: string | null }>;
    const update = db.prepare(
      'UPDATE report_sources SET stored_path=?,extracted_path=? WHERE id=?',
    );
    for (const row of rows) {
      const stored = toWorkspaceRelative(this.paths.root, row.stored_path);
      const extracted = row.extracted_path
        ? toWorkspaceRelative(this.paths.root, row.extracted_path)
        : null;
      update.run(stored, extracted, row.id);
    }
  }
  private async reconcileOperations(): Promise<void> {
    // Journal rows are a recovery queue, not merely an interruption marker.
    // A staged pair is discarded; a promoted pair is rolled forward from its
    // payload; delete operations are completed after their quarantine move.
    const rows = this.connection
      .prepare(
        "SELECT * FROM operation_journal WHERE state IN ('running','staging','staged','files_committed','quarantined','interrupted','failed') ORDER BY started_at",
      )
      .all() as Record<string, unknown>[];
    for (const row of rows) {
      const id = String(row.id);
      const operation = String(row.operation);
      const reportId = String(row.target).match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0] || '';
      const stage = row.stage_path
        ? String(row.stage_path)
        : reportId
          ? path.join(locatorFor(this.paths).report(reportId), '.staging', id)
          : null;
      const backup = row.backup_path ? String(row.backup_path) : null;
      try {
        if (operation === 'delete-report') {
          await this.reconcileDelete(row);
          continue;
        }
        if (row.state === 'files_committed' && row.payload) {
          const payload = JSON.parse(String(row.payload)) as Record<string, unknown>;
          if (
            payload.kind === 'create' &&
            !this.connection
              .prepare('SELECT 1 FROM reports WHERE id=?')
              .get(String(payload.reportId))
          ) {
            const orphan = locatorFor(this.paths).report(String(payload.reportId));
            if (await fileExists(orphan))
              await this.verifyReportPath(orphan, { rejectSymlink: true }).then(() =>
                rm(orphan, { recursive: true, force: true }),
              );
            this.connection
              .prepare(
                "UPDATE operation_journal SET state='rolled_back',phase='rolled_back',completed_at=?,error_code='PROCESS_INTERRUPTED',safe_error_message='중단된 생성 작업을 정리했습니다.' WHERE id=?",
              )
              .run(now(), id);
            continue;
          }
          this.applyReportPayload(payload);
          this.connection
            .prepare(
              "UPDATE operation_journal SET state='completed',phase='completed',completed_at=?,error_code=NULL,safe_error_message=NULL WHERE id=?",
            )
            .run(now(), id);
          if (backup) await rm(backup, { recursive: true, force: true });
          continue;
        }
        if (stage) await rm(stage, { recursive: true, force: true });
        if (backup) await this.restoreBackup(backup, String(row.target));
        this.connection
          .prepare(
            "UPDATE operation_journal SET state='rolled_back',phase='rolled_back',completed_at=?,error_code='PROCESS_INTERRUPTED',safe_error_message='중단된 파일 작업을 시작 시점으로 되돌렸습니다.' WHERE id=?",
          )
          .run(now(), id);
      } catch {
        this.connection
          .prepare(
            "UPDATE operation_journal SET state='quarantined',phase='quarantined',completed_at=?,error_code='RECOVERY_REQUIRED',safe_error_message='중단된 파일 작업을 자동 복구하지 못해 격리했습니다.' WHERE id=?",
          )
          .run(now(), id);
      }
    }
  }
  private beginOperation(operation: string, target: string): string {
    const id = randomUUID();
    this.connection
      .prepare(
        'INSERT INTO operation_journal(id,operation,target,state,started_at,phase) VALUES(?,?,?,?,?,?)',
      )
      .run(id, operation, target, 'running', now(), 'running');
    return id;
  }
  private finishOperation(
    id: string,
    state: 'completed' | 'failed',
    errorCode: string | null = null,
    message: string | null = null,
  ): void {
    this.connection
      .prepare(
        'UPDATE operation_journal SET state=?,phase=?,completed_at=?,error_code=?,safe_error_message=? WHERE id=?',
      )
      .run(state, state, now(), errorCode, message, id);
  }
  private async writeCanonicalPair(
    operationId: string,
    contentPath: string,
    editorPath: string,
    html: string,
    editorJson: unknown,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const stage = path.join(path.dirname(contentPath), '.staging', operationId);
    const backup = path.join(path.dirname(contentPath), '.staging', `${operationId}.backup`);
    await mkdir(stage, { recursive: true });
    await atomicWrite(path.join(stage, 'report.html'), html);
    await atomicWrite(
      path.join(stage, 'editor.json'),
      JSON.stringify({
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        editorJson,
        htmlProjectionHash: contentHash(html),
        editorJsonHash: contentHash(JSON.stringify(editorJson)),
      }),
    );
    this.connection
      .prepare(
        "UPDATE operation_journal SET state='staged',phase='staged',stage_path=?,backup_path=?,payload=? WHERE id=?",
      )
      .run(stage, backup, JSON.stringify(payload), operationId);
    await mkdir(backup, { recursive: true });
    for (const [source, target] of [
      [contentPath, path.join(backup, 'report.html')],
      [editorPath, path.join(backup, 'editor.json')],
    ] as const) {
      try {
        await rename(source, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rename(path.join(stage, 'report.html'), contentPath);
    await rename(path.join(stage, 'editor.json'), editorPath);
    await rm(stage, { recursive: true, force: true });
    this.connection
      .prepare(
        "UPDATE operation_journal SET state='files_committed',phase='files_committed' WHERE id=?",
      )
      .run(operationId);
  }
  private applyReportPayload(payload: Record<string, unknown>): void {
    if (payload.kind !== 'save') return;
    this.connection
      .prepare(
        'UPDATE reports SET title=?,purpose=COALESCE(?,purpose),output_options=COALESCE(?,output_options),layout_mode=?,canonical_schema_version=?,html_projection_hash=?,editor_json_hash=?,updated_at=? WHERE id=?',
      )
      .run(
        String(payload.title),
        payload.purpose == null ? null : String(payload.purpose),
        payload.outputOptions == null ? null : JSON.stringify(payload.outputOptions),
        String(payload.layoutMode),
        CANONICAL_SCHEMA_VERSION,
        String(payload.htmlProjectionHash),
        String(payload.editorJsonHash),
        now(),
        String(payload.reportId),
      );
  }
  private async restoreBackup(backup: string, target: string): Promise<void> {
    if (!(await fileExists(backup))) return;
    const targetPath = path.isAbsolute(target) ? target : path.join(this.paths.root, target);
    for (const name of ['report.html', 'editor.json']) {
      const source = path.join(backup, name);
      if (await fileExists(source)) await rename(source, path.join(path.dirname(targetPath), name));
    }
    await rm(backup, { recursive: true, force: true });
  }
  private async reconcileDelete(row: Record<string, unknown>): Promise<void> {
    const id = String(row.payload || row.target).match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0] || '';
    const target = locatorFor(this.paths).report(id);
    const quarantine = row.stage_path
      ? String(row.stage_path)
      : path.join(this.paths.internal, 'quarantine', String(row.id));
    if (
      row.phase === 'running' ||
      row.phase === 'staging' ||
      row.phase === 'staged' ||
      row.state === 'interrupted'
    ) {
      if ((await fileExists(quarantine)) && !(await fileExists(target))) {
        // The process may have died after the quarantine rename but before the
        // journal phase update. Put the report back before declaring rollback.
        await assertContainedRealpath(this.paths.internal, quarantine, { rejectSymlink: true });
        await mkdir(path.dirname(target), { recursive: true });
        await rename(quarantine, target);
      }
      this.connection
        .prepare(
          "UPDATE operation_journal SET state='rolled_back',phase='rolled_back',completed_at=?,error_code='PROCESS_INTERRUPTED',safe_error_message='삭제 전 중단되어 보고서를 보존했습니다.' WHERE id=?",
        )
        .run(now(), String(row.id));
      return;
    }
    if (await fileExists(target)) await this.verifyReportPath(target, { rejectSymlink: true });
    if (await fileExists(quarantine)) await rm(quarantine, { recursive: true, force: true });
    this.connection.prepare('DELETE FROM reports WHERE id=?').run(id);
    this.connection
      .prepare(
        "UPDATE operation_journal SET state='completed',phase='completed',completed_at=? WHERE id=?",
      )
      .run(now(), String(row.id));
  }
  private async verifyReportPath(
    target: string,
    options: { allowMissing?: boolean; rejectSymlink?: boolean } = {},
  ): Promise<string> {
    // Check both the workspace boundary and the reports boundary. Checking
    // only the latter would allow a malicious replacement of `reports` with a
    // junction to make an external directory appear workspace-owned.
    await assertContainedRealpath(this.paths.root, this.paths.reports, { rejectSymlink: true });
    return assertContainedRealpath(this.paths.reports, target, options);
  }
  private seedPersonas(): void {
    const db = this.connection;
    const count = db.prepare('SELECT count(*) count FROM personas').get() as { count: number };
    if (count.count) return;
    const insert = db.prepare('INSERT INTO personas VALUES(?,?,?,?,?,?,?,?)');
    db.transaction(() =>
      BUILT_INS.forEach(([name, description, instructions], index) => {
        const stamp = now();
        insert.run(
          randomUUID(),
          name,
          description,
          instructions,
          1,
          index === 1 ? 1 : 0,
          stamp,
          stamp,
        );
      }),
    )();
  }
  listReports(
    includeDeleted = false,
    query = '',
    sort: 'updated' | 'title' = 'updated',
  ): ReportSummary[] {
    return this.listReportsPage({ includeDeleted, query, sort, limit: 1_000_000 }).items;
  }

  /** Cursor pagination keeps large workspaces bounded and gives stable results
   * even when several reports share the same timestamp or title. */
  listReportsPage(options: ReportListPageOptions = {}): ReportListPage {
    const includeDeleted = options.includeDeleted === true;
    const query = options.query ?? '';
    const sort = options.sort ?? 'updated';
    const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)));
    const where = [includeDeleted ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
    const terms = `%${escapeLike(query.trim())}%`;
    const parameters: unknown[] = [terms, terms];
    where.push("(title LIKE ? ESCAPE '\\' OR purpose LIKE ? ESCAPE '\\')");
    let order: string;
    const decoded = options.cursor ? decodeReportCursor(options.cursor) : null;
    if (sort === 'title') {
      order = 'title COLLATE NOCASE ASC, id ASC';
      if (decoded) {
        if (decoded.sort !== 'title') throw new Error('INVALID_REPORT_CURSOR');
        where.push('(title COLLATE NOCASE > ? OR (title COLLATE NOCASE = ? AND id > ?))');
        parameters.push(decoded.title, decoded.title, decoded.id);
      }
    } else {
      order = 'is_favorite DESC, updated_at DESC, id DESC';
      if (decoded) {
        if (decoded.sort !== 'updated') throw new Error('INVALID_REPORT_CURSOR');
        where.push(
          '(is_favorite < ? OR (is_favorite = ? AND (updated_at < ? OR (updated_at = ? AND id < ?))))',
        );
        parameters.push(
          decoded.favorite,
          decoded.favorite,
          decoded.updatedAt,
          decoded.updatedAt,
          decoded.id,
        );
      }
    }
    const rows = this.connection
      .prepare(
        `SELECT id,title,purpose,layout_mode,is_favorite,created_at,updated_at,deleted_at FROM reports WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
      )
      .all(...parameters, limit + 1) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(rowToSummary);
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeReportCursor(sort, last) : null;
    return { items, nextCursor };
  }
  async createReport(input: {
    title: string;
    purpose: string;
    personaId: string | null;
    outputOptions: ReportOutputOptions;
    layoutMode: 'a4' | 'web';
    html: string;
  }): Promise<Report> {
    const id = randomUUID();
    const locator = locatorFor(this.paths);
    const dir = locator.report(id);
    const operationId = this.beginOperation('create-report', path.relative(this.paths.root, dir));
    try {
      await Promise.all(
        ['source-originals', 'source-extracted', 'revisions', 'agent-work', 'assets'].map((name) =>
          mkdir(path.join(dir, name), { recursive: true }),
        ),
      );
      await this.verifyReportPath(dir, { rejectSymlink: true });
      const contentPath = locator.reportFile(id, 'report.html');
      const editorStatePath = locator.reportFile(id, 'editor.json');
      const canonical = canonicalFromHtml(input.html);
      await this.writeCanonicalPair(
        operationId,
        contentPath,
        editorStatePath,
        canonical.html,
        canonical.editorJson,
        { kind: 'create', reportId: id },
      );
      const stamp = now();
      this.connection
        .prepare(
          'INSERT INTO reports(id,title,purpose,persona_id,output_options,layout_mode,content_path,editor_state_path,canonical_schema_version,html_projection_hash,editor_json_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          input.title || '제목 없는 보고서',
          input.purpose,
          input.personaId,
          JSON.stringify(input.outputOptions ?? DEFAULT_OPTIONS),
          input.layoutMode,
          storedReportPath(id, 'report.html'),
          storedReportPath(id, 'editor.json'),
          CANONICAL_SCHEMA_VERSION,
          canonical.htmlProjectionHash,
          canonical.editorJsonHash,
          stamp,
          stamp,
        );
      await this.createRevision(id, 'created', '보고서 최초 생성');
      const report = await this.getReport(id);
      this.finishOperation(operationId, 'completed');
      return report;
    } catch (error) {
      this.finishOperation(
        operationId,
        'failed',
        'REPORT_CREATE_FAILED',
        '보고서 생성에 실패했습니다.',
      );
      throw error;
    }
  }
  async getReport(id: string): Promise<Report> {
    const row = this.connection.prepare('SELECT * FROM reports WHERE id=?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) throw new Error('REPORT_NOT_FOUND');
    const locator = locatorFor(this.paths);
    const contentPath = await this.verifyReportPath(locator.reportFile(id, 'report.html'), {
      rejectSymlink: true,
    });
    const editorPath = await this.verifyReportPath(locator.reportFile(id, 'editor.json'), {
      rejectSymlink: true,
    });
    let html: string;
    let editorJson: unknown;
    let editorEnvelope: Record<string, unknown> | null = null;
    try {
      html = sanitizeReportHtml(await readFile(contentPath, 'utf8'));
    } catch (error) {
      throw fileReadError('REPORT_CONTENT_READ_FAILED', error);
    }
    try {
      const envelope = JSON.parse(await readFile(editorPath, 'utf8')) as unknown;
      if (envelope && typeof envelope === 'object' && 'editorJson' in envelope)
        editorEnvelope = envelope as Record<string, unknown>;
      editorJson = readEditorEnvelope(envelope);
    } catch (error) {
      throw fileReadError('REPORT_EDITOR_STATE_READ_FAILED', error);
    }
    if (row.html_projection_hash && String(row.html_projection_hash) !== contentHash(html))
      throw new Error('REPORT_CONTENT_INTEGRITY_FAILED');
    if (
      editorEnvelope?.editorJsonHash &&
      String(editorEnvelope.editorJsonHash) !== contentHash(JSON.stringify(editorJson))
    )
      throw new Error('REPORT_EDITOR_INTEGRITY_FAILED');
    return {
      ...rowToReport(row),
      contentPath,
      editorStatePath: editorPath,
      html,
      editorJson,
      htmlProjectionHash: String(row.html_projection_hash || contentHash(html)),
      canonicalSchemaVersion: Number(row.canonical_schema_version || CANONICAL_SCHEMA_VERSION),
      latestGeneration: this.getLatestGeneration(id),
    };
  }
  async saveReport(input: {
    id: string;
    title: string;
    html: string;
    editorJson: unknown;
    layoutMode: 'a4' | 'web';
    generation?: unknown;
  }): Promise<Report> {
    // This method is also called directly by integration code, so do not rely
    // solely on the IPC boundary for provenance size and type validation.
    const parsedInput = saveReportSchema.parse(input);
    const normalizedGeneration = parsedInput.generation
      ? await this.normalizeGenerationReferences(input.id, parsedInput.generation)
      : undefined;
    const current = await this.getReport(input.id);
    const operationId = this.beginOperation(
      'save-report',
      storedReportPath(input.id, 'report.html'),
    );
    try {
      const canonical = canonicalFromInput(input.html, input.editorJson);
      await this.writeCanonicalPair(
        operationId,
        current.contentPath,
        current.editorStatePath,
        canonical.html,
        canonical.editorJson,
        {
          kind: 'save',
          reportId: input.id,
          title: input.title,
          layoutMode: input.layoutMode,
          htmlProjectionHash: canonical.htmlProjectionHash,
          editorJsonHash: canonical.editorJsonHash,
        },
      );
      this.connection
        .prepare(
          'UPDATE reports SET title=?,layout_mode=?,canonical_schema_version=?,html_projection_hash=?,editor_json_hash=?,updated_at=? WHERE id=?',
        )
        .run(
          input.title,
          input.layoutMode,
          CANONICAL_SCHEMA_VERSION,
          canonical.htmlProjectionHash,
          canonical.editorJsonHash,
          now(),
          input.id,
        );
      const saved = await this.getReport(input.id);
      if (normalizedGeneration) await this.recordGeneration(input.id, normalizedGeneration);
      this.finishOperation(operationId, 'completed');
      return normalizedGeneration ? this.getReport(input.id) : saved;
    } catch (error) {
      this.finishOperation(
        operationId,
        'failed',
        'REPORT_SAVE_FAILED',
        '보고서 저장에 실패했습니다.',
      );
      throw error;
    }
  }
  renameReport(id: string, title: string): void {
    this.connection
      .prepare('UPDATE reports SET title=?,updated_at=? WHERE id=?')
      .run(title, now(), id);
  }
  favoriteReport(id: string, value: boolean): void {
    this.connection
      .prepare('UPDATE reports SET is_favorite=?,updated_at=? WHERE id=?')
      .run(value ? 1 : 0, now(), id);
  }
  trashReport(id: string): void {
    this.connection
      .prepare('UPDATE reports SET deleted_at=?,updated_at=? WHERE id=?')
      .run(now(), now(), id);
  }
  restoreReport(id: string): void {
    this.connection
      .prepare('UPDATE reports SET deleted_at=NULL,updated_at=? WHERE id=?')
      .run(now(), id);
  }
  async deleteReport(id: string): Promise<void> {
    const row = this.connection.prepare('SELECT id FROM reports WHERE id=?').get(id) as
      { id: string } | undefined;
    if (!row) throw new Error('REPORT_NOT_FOUND');
    const directory = locatorFor(this.paths).report(id);
    const operationId = this.beginOperation('delete-report', storedReportPath(id, 'report.html'));
    const quarantine = locatorFor(this.paths).quarantine(`${id}-${operationId}`);
    try {
      await this.verifyReportPath(directory, { rejectSymlink: true });
      await mkdir(path.dirname(quarantine), { recursive: true });
      this.connection
        .prepare(
          "UPDATE operation_journal SET state='staging',phase='staging',stage_path=?,payload=? WHERE id=?",
        )
        .run(quarantine, JSON.stringify({ reportId: id }), operationId);
      await rename(directory, quarantine);
      this.connection
        .prepare(
          "UPDATE operation_journal SET state='quarantined',phase='quarantined',stage_path=?,payload=? WHERE id=?",
        )
        .run(quarantine, JSON.stringify({ reportId: id }), operationId);
      this.connection.transaction(() => {
        // Keep the local chat/message audit trail tied to the deletion while
        // preventing an orphaned active chat after its report is removed.
        this.connection
          .prepare(
            'UPDATE chat_sessions SET deleted_at=?,updated_at=? WHERE report_id=? AND deleted_at IS NULL',
          )
          .run(now(), now(), id);
        this.connection.prepare('DELETE FROM reports WHERE id=?').run(id);
      })();
      await rm(quarantine, { recursive: true, force: true });
      this.finishOperation(operationId, 'completed');
    } catch (error) {
      this.finishOperation(
        operationId,
        'failed',
        'REPORT_DELETE_FAILED',
        '보고서 삭제에 실패했습니다.',
      );
      throw error;
    }
  }
  async duplicateReport(id: string): Promise<Report> {
    const source = await this.getReport(id);
    return this.createReport({
      title: `${source.title} - 복사본`,
      purpose: source.purpose,
      personaId: source.personaId,
      outputOptions: source.outputOptions,
      layoutMode: source.layoutMode,
      html: source.html,
    });
  }
  async createRevision(reportId: string, reason: string, description: string): Promise<Revision> {
    const report = await this.getReport(reportId);
    const id = randomUUID();
    const snapshotPath = path.join(path.dirname(report.contentPath), 'revisions', `${id}.json`);
    await this.verifyReportPath(snapshotPath, { rejectSymlink: true });
    const hash = contentHash(report.html);
    const editorJsonHash = contentHash(JSON.stringify(report.editorJson));
    const envelope = {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      editorJson: report.editorJson,
      html: report.html,
      title: report.title,
      purpose: report.purpose,
      outputOptions: report.outputOptions,
      layoutMode: report.layoutMode,
      htmlProjectionHash: hash,
      editorJsonHash,
    };
    await atomicWrite(snapshotPath, JSON.stringify(envelope));
    const createdAt = now();
    this.connection.transaction(() => {
      this.connection
        .prepare(
          'INSERT INTO report_revisions(id,report_id,snapshot_path,reason,description,base_content_hash,created_at,schema_version,editor_json,html,title,purpose,output_options,layout_mode,html_projection_hash,editor_json_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          reportId,
          storedRevisionPath(reportId, id, 'json'),
          reason,
          description,
          hash,
          createdAt,
          CANONICAL_SCHEMA_VERSION,
          JSON.stringify(report.editorJson),
          report.html,
          report.title,
          report.purpose,
          JSON.stringify(report.outputOptions),
          report.layoutMode,
          hash,
          editorJsonHash,
        );
      this.connection
        .prepare('UPDATE reports SET current_revision_id=? WHERE id=?')
        .run(id, reportId);
    })();
    return {
      id,
      reportId,
      snapshotPath,
      reason,
      description,
      baseContentHash: hash,
      createdAt,
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      editorJson: report.editorJson,
      html: report.html,
      title: report.title,
      purpose: report.purpose,
      outputOptions: report.outputOptions,
      layoutMode: report.layoutMode,
      htmlProjectionHash: hash,
      editorJsonHash,
    };
  }
  listRevisions(reportId: string): Revision[] {
    return (
      this.connection
        .prepare('SELECT * FROM report_revisions WHERE report_id=? ORDER BY created_at DESC')
        .all(reportId) as Record<string, unknown>[]
    ).map((row) => revisionFromRow(row, this.paths));
  }
  async restoreRevision(reportId: string, revisionId: string): Promise<Report> {
    const revision = this.connection
      .prepare('SELECT * FROM report_revisions WHERE id=? AND report_id=?')
      .get(revisionId, reportId) as Record<string, unknown> | undefined;
    if (!revision) throw new Error('REVISION_NOT_FOUND');
    const storedSnapshotPath = String(revision.snapshot_path);
    const snapshotPath = await this.verifyReportPath(
      locatorFor(this.paths).resolveStored(storedSnapshotPath),
      {
        rejectSymlink: true,
      },
    );
    let snapshot: ReturnType<typeof parseRevisionEnvelope>;
    try {
      const raw = await readFile(snapshotPath, 'utf8');
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        /* v1-v3 snapshots were raw HTML */
      }
      snapshot = parseRevisionEnvelope(parsed, revision);
    } catch (error) {
      throw fileReadError('REVISION_SNAPSHOT_READ_FAILED', error);
    }
    await this.createRevision(reportId, 'before-restore', '버전 복원 이전');
    const report = await this.getReport(reportId);
    const operationId = this.beginOperation(
      'restore-revision',
      storedReportPath(reportId, 'report.html'),
    );
    const html = sanitizeReportHtml(snapshot.html);
    await this.writeCanonicalPair(
      operationId,
      report.contentPath,
      report.editorStatePath,
      html,
      snapshot.editorJson,
      {
        kind: 'save',
        reportId,
        title: snapshot.title,
        purpose: snapshot.purpose,
        outputOptions: snapshot.outputOptions,
        layoutMode: snapshot.layoutMode,
        htmlProjectionHash: contentHash(html),
        editorJsonHash: contentHash(JSON.stringify(snapshot.editorJson)),
      },
    );
    this.connection
      .prepare(
        'UPDATE reports SET title=?,purpose=?,output_options=?,layout_mode=?,canonical_schema_version=?,html_projection_hash=?,editor_json_hash=?,updated_at=? WHERE id=?',
      )
      .run(
        snapshot.title,
        snapshot.purpose,
        JSON.stringify(snapshot.outputOptions),
        snapshot.layoutMode,
        CANONICAL_SCHEMA_VERSION,
        contentHash(html),
        contentHash(JSON.stringify(snapshot.editorJson)),
        now(),
        reportId,
      );
    this.finishOperation(operationId, 'completed');
    await this.createRevision(reportId, 'restored', '이전 버전 복원');
    return this.getReport(reportId);
  }
  listPersonas(): Persona[] {
    return (
      this.connection
        .prepare('SELECT * FROM personas ORDER BY is_built_in DESC,name')
        .all() as Record<string, unknown>[]
    ).map(rowToPersona);
  }
  savePersona(input: {
    id?: string;
    name: string;
    description: string;
    instructions: string;
    isDefault: boolean;
  }): Persona {
    const stamp = now();
    const id = input.id ?? randomUUID();
    const existing = this.connection
      .prepare('SELECT is_built_in FROM personas WHERE id=?')
      .get(id) as { is_built_in: number } | undefined;
    if (existing?.is_built_in) throw new Error('BUILT_IN_PERSONA_PROTECTED');
    this.connection.transaction(() => {
      if (input.isDefault) this.connection.prepare('UPDATE personas SET is_default=0').run();
      this.connection
        .prepare(
          'INSERT INTO personas(id,name,description,instructions,is_built_in,is_default,created_at,updated_at) VALUES(?,?,?,?,0,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,instructions=excluded.instructions,is_default=excluded.is_default,updated_at=excluded.updated_at',
        )
        .run(
          id,
          input.name,
          input.description,
          input.instructions,
          input.isDefault ? 1 : 0,
          stamp,
          stamp,
        );
    })();
    return rowToPersona(
      this.connection.prepare('SELECT * FROM personas WHERE id=?').get(id) as Record<
        string,
        unknown
      >,
    );
  }
  deletePersona(id: string): void {
    const row = this.connection.prepare('SELECT is_built_in FROM personas WHERE id=?').get(id) as
      { is_built_in: number } | undefined;
    if (row?.is_built_in) throw new Error('BUILT_IN_PERSONA_PROTECTED');
    this.connection.prepare('DELETE FROM personas WHERE id=?').run(id);
  }
  saveSource(reportId: string, source: SourceManifestEntry): void {
    this.connection
      .prepare('INSERT OR REPLACE INTO report_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        source.sourceId,
        reportId,
        source.originalName,
        source.storedPath,
        source.mimeType,
        source.size,
        source.sha256,
        source.extractionStatus,
        source.extractedPath,
        JSON.stringify(source.metadata),
        JSON.stringify(source.warnings),
        source.createdAt,
      );
  }
  listSources(reportId: string): SourceManifestEntry[] {
    return (
      this.connection
        .prepare('SELECT * FROM report_sources WHERE report_id=? ORDER BY created_at')
        .all(reportId) as Record<string, unknown>[]
    ).map((row) => ({
      sourceId: String(row.id),
      originalName: String(row.original_name),
      storedPath: String(row.stored_path),
      mimeType: String(row.mime_type),
      size: Number(row.size),
      sha256: String(row.sha256),
      extractionStatus: row.extraction_status as SourceManifestEntry['extractionStatus'],
      extractedPath: row.extracted_path ? String(row.extracted_path) : null,
      metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>,
      warnings: JSON.parse(String(row.warnings)) as string[],
      createdAt: String(row.created_at),
    }));
  }
  private async normalizeGenerationReferences(
    reportId: string,
    input: {
      schemaVersion: 1;
      executiveSummary: string;
      sourceUsage: SourceUsage[];
      assumptions: string[];
      warnings: string[];
      model: string | null;
      promptVersion: string;
      sourceSnapshotHashes: Record<string, string>;
      claimEvidence: ClaimEvidence[];
    },
  ): Promise<typeof input> {
    const sources = this.listSources(reportId);
    const byId = new Map(sources.map((source) => [source.sourceId, source]));
    const sourceUsage: SourceUsage[] = [];
    let unknownSources = 0;
    let unavailableSnapshots = 0;
    for (const usage of input.sourceUsage) {
      const source = byId.get(usage.sourceId);
      if (!source) {
        unknownSources++;
        continue;
      }
      if (!source.extractedPath) {
        unavailableSnapshots++;
        continue;
      }
      try {
        await readFile(locatorFor(this.paths).resolveStored(source.extractedPath), 'utf8');
      } catch {
        unavailableSnapshots++;
        continue;
      }
      sourceUsage.push(usage);
    }
    const usageKeys = new Set(
      sourceUsage.map((usage) => `${usage.sourceId}\u0000${usage.locator}`),
    );
    const requestedClaimEvidence =
      input.claimEvidence.length > 0
        ? input.claimEvidence
        : sourceUsage.map((usage) => ({
            claim: usage.claimSummary,
            sourceId: usage.sourceId,
            locator: usage.locator,
            evidenceExcerpt: undefined,
          }));
    const claimEvidence = requestedClaimEvidence.filter((entry) =>
      usageKeys.has(`${entry.sourceId}\u0000${entry.locator}`),
    );
    const droppedClaims = requestedClaimEvidence.length - claimEvidence.length;
    const warnings = [...input.warnings];
    if (unknownSources > 0)
      warnings.push(`현재 보고서에 없는 Source를 참조한 근거 ${unknownSources}건을 제외했습니다.`);
    if (unavailableSnapshots > 0)
      warnings.push(
        `검증 가능한 추출 Snapshot이 없는 근거 ${unavailableSnapshots}건을 제외했습니다.`,
      );
    if (droppedClaims > 0)
      warnings.push(
        `유효한 Source 사용과 연결되지 않은 주장-근거 ${droppedClaims}건을 제외했습니다.`,
      );
    return {
      ...input,
      sourceUsage,
      claimEvidence,
      warnings: [...new Set(warnings)],
    };
  }
  /** Persist AI provenance and a claim-to-evidence ledger after validating all references. */
  private async recordGeneration(
    reportId: string,
    input: {
      schemaVersion?: 1;
      executiveSummary: string;
      sourceUsage: SourceUsage[];
      assumptions: string[];
      warnings: string[];
      model: string | null;
      promptVersion: string;
      sourceSnapshotHashes?: Record<string, string>;
      claimEvidence?: ClaimEvidence[];
    },
  ): Promise<ReportGenerationRecord> {
    const sources = this.listSources(reportId);
    const byId = new Map(sources.map((source) => [source.sourceId, source]));
    const warnings = [...input.warnings];
    for (const usage of input.sourceUsage) {
      const source = byId.get(usage.sourceId);
      if (!source?.extractedPath) continue;
      // A locator may be semantic (page/slide/row), so preserve it while
      // explicitly marking locators that could not be proven in the snapshot.
      try {
        const snapshot = await readFile(
          locatorFor(this.paths).resolveStored(source.extractedPath),
          'utf8',
        );
        const metadata = JSON.stringify(source.metadata);
        if (!snapshot.includes(usage.locator) && !metadata.includes(usage.locator)) {
          warnings.push(
            `근거 위치를 추출 스냅샷에서 확인하지 못했습니다: ${usage.sourceId}/${usage.locator}`,
          );
        }
      } catch {
        warnings.push('생성 결과 저장 중 일부 Source Snapshot을 다시 읽지 못했습니다.');
      }
    }
    const claimEvidence =
      input.claimEvidence ??
      input.sourceUsage.map((usage) => ({
        claim: usage.claimSummary,
        sourceId: usage.sourceId,
        locator: usage.locator,
        evidenceExcerpt: undefined,
      }));
    for (const entry of claimEvidence) {
      if (!byId.has(entry.sourceId)) continue;
      const usage = input.sourceUsage.find(
        (candidate) => candidate.sourceId === entry.sourceId && candidate.locator === entry.locator,
      );
      if (!usage)
        warnings.push(`주장-근거 연결을 확인하지 못했습니다: ${entry.sourceId}/${entry.locator}`);
    }
    const sourceSnapshotHashes: Record<string, string> = {};
    for (const source of sources) {
      if (source.extractedPath) {
        try {
          sourceSnapshotHashes[source.sourceId] = contentHash(
            await readFile(locatorFor(this.paths).resolveStored(source.extractedPath)),
          );
        } catch {
          sourceSnapshotHashes[source.sourceId] = source.sha256;
        }
      } else sourceSnapshotHashes[source.sourceId] = source.sha256;
    }
    const id = randomUUID();
    const createdAt = now();
    this.connection.transaction(() => {
      this.connection
        .prepare(
          'INSERT INTO report_generations(id,report_id,schema_version,executive_summary,source_usage,assumptions,warnings,model,prompt_version,source_snapshot_hashes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          reportId,
          1,
          input.executiveSummary,
          JSON.stringify(input.sourceUsage),
          JSON.stringify(input.assumptions),
          JSON.stringify([...new Set(warnings)]),
          input.model,
          input.promptVersion,
          JSON.stringify(sourceSnapshotHashes),
          createdAt,
        );
      const insert = this.connection.prepare(
        'INSERT INTO report_claim_evidence(id,generation_id,claim,source_id,locator,evidence_excerpt) VALUES(?,?,?,?,?,?)',
      );
      for (const entry of claimEvidence)
        insert.run(
          randomUUID(),
          id,
          entry.claim,
          entry.sourceId,
          entry.locator,
          entry.evidenceExcerpt ?? null,
        );
    })();
    return this.getGeneration(id)!;
  }
  private getGeneration(id: string): ReportGenerationRecord | null {
    const row = this.connection.prepare('SELECT * FROM report_generations WHERE id=?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    const ledger = this.connection
      .prepare(
        'SELECT claim,source_id,locator,evidence_excerpt FROM report_claim_evidence WHERE generation_id=?',
      )
      .all(id) as Record<string, unknown>[];
    return {
      id: String(row.id),
      reportId: String(row.report_id),
      schemaVersion: Number(row.schema_version || 1),
      executiveSummary: String(row.executive_summary),
      sourceUsage: JSON.parse(String(row.source_usage)) as SourceUsage[],
      assumptions: JSON.parse(String(row.assumptions)) as string[],
      warnings: JSON.parse(String(row.warnings)) as string[],
      model: row.model ? String(row.model) : null,
      promptVersion: String(row.prompt_version),
      sourceSnapshotHashes: JSON.parse(String(row.source_snapshot_hashes)) as Record<
        string,
        string
      >,
      claimEvidence: ledger.map((entry) => ({
        claim: String(entry.claim),
        sourceId: String(entry.source_id),
        locator: String(entry.locator),
        evidenceExcerpt: entry.evidence_excerpt ? String(entry.evidence_excerpt) : undefined,
      })),
      createdAt: String(row.created_at),
    };
  }
  getLatestGeneration(reportId: string): ReportGenerationRecord | null {
    const row = this.connection
      .prepare(
        'SELECT id FROM report_generations WHERE report_id=? ORDER BY created_at DESC LIMIT 1',
      )
      .get(reportId) as { id: string } | undefined;
    return row ? this.getGeneration(row.id) : null;
  }
  listGenerations(reportId: string): ReportGenerationRecord[] {
    return (
      this.connection
        .prepare('SELECT id FROM report_generations WHERE report_id=? ORDER BY created_at DESC')
        .all(reportId) as { id: string }[]
    )
      .map((row) => this.getGeneration(row.id)!)
      .filter(Boolean);
  }
  listClaimEvidence(reportId: string): ClaimEvidence[] {
    return this.listGenerations(reportId).flatMap((generation) => generation.claimEvidence);
  }
  recordDeletionRetention(input: {
    ownerType: 'report' | 'chat';
    ownerId: string;
    codexThreadIds: string[];
    pendingThreadIds: string[];
    localState?: 'deleted' | 'failed';
  }): DeletionRetention {
    const id = randomUUID();
    const stamp = now();
    const codexState = input.pendingThreadIds.length
      ? 'pending'
      : input.codexThreadIds.length
        ? 'deleted'
        : 'none';
    this.connection
      .prepare(
        'INSERT INTO deletion_retention(id,owner_type,owner_id,codex_thread_ids,pending_thread_ids,local_state,codex_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.ownerType,
        input.ownerId,
        JSON.stringify(input.codexThreadIds),
        JSON.stringify(input.pendingThreadIds),
        input.localState ?? 'deleted',
        codexState,
        stamp,
        stamp,
      );
    return this.getDeletionRetention(id)!;
  }
  listDeletionRetention(ownerId?: string): DeletionRetention[] {
    const rows = (
      ownerId
        ? this.connection
            .prepare('SELECT * FROM deletion_retention WHERE owner_id=? ORDER BY updated_at DESC')
            .all(ownerId)
        : this.connection.prepare('SELECT * FROM deletion_retention ORDER BY updated_at DESC').all()
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      ownerType: row.owner_type as 'report' | 'chat',
      ownerId: String(row.owner_id),
      codexThreadIds: JSON.parse(String(row.codex_thread_ids)) as string[],
      pendingThreadIds: JSON.parse(String(row.pending_thread_ids)) as string[],
      localState: row.local_state as 'deleted' | 'failed',
      codexState: row.codex_state as 'deleted' | 'pending' | 'none',
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }
  private getDeletionRetention(id: string): DeletionRetention | null {
    return this.listDeletionRetention().find((entry) => entry.id === id) ?? null;
  }
  updateDeletionRetention(id: string, pendingThreadIds: string[]): DeletionRetention {
    const current = this.getDeletionRetention(id);
    if (!current) throw new Error('DELETION_RETENTION_NOT_FOUND');
    const codexState = pendingThreadIds.length
      ? 'pending'
      : current.codexThreadIds.length
        ? 'deleted'
        : 'none';
    this.connection
      .prepare(
        'UPDATE deletion_retention SET pending_thread_ids=?,codex_state=?,updated_at=? WHERE id=?',
      )
      .run(JSON.stringify(pendingThreadIds), codexState, now(), id);
    return this.getDeletionRetention(id)!;
  }
  listChats(): ChatSession[] {
    return (
      this.connection
        .prepare('SELECT * FROM chat_sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC')
        .all() as Record<string, unknown>[]
    ).map(rowToChat);
  }
  listChatsForReport(reportId: string): ChatSession[] {
    return (
      this.connection
        .prepare('SELECT * FROM chat_sessions WHERE report_id=?')
        .all(reportId) as Record<string, unknown>[]
    ).map(rowToChat);
  }
  getChat(id: string): ChatSession | null {
    const row = this.connection.prepare('SELECT * FROM chat_sessions WHERE id=?').get(id) as
      Record<string, unknown> | undefined;
    return row ? rowToChat(row) : null;
  }
  async createChat(title: string, reportId: string | null): Promise<ChatSession> {
    const id = randomUUID();
    await mkdir(path.join(this.paths.chats, id, 'agent-work'), { recursive: true });
    const stamp = now();
    this.connection
      .prepare(
        'INSERT INTO chat_sessions(id,title,kind,report_id,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      )
      .run(id, title, reportId ? 'report' : 'general', reportId, stamp, stamp);
    return rowToChat(
      this.connection.prepare('SELECT * FROM chat_sessions WHERE id=?').get(id) as Record<
        string,
        unknown
      >,
    );
  }
  renameChat(id: string, title: string): void {
    this.connection
      .prepare('UPDATE chat_sessions SET title=?,updated_at=? WHERE id=?')
      .run(title, now(), id);
  }
  updateChatAiSettings(
    id: string,
    model: string | null,
    reasoningEffort: string | null,
  ): ChatSession {
    this.connection
      .prepare('UPDATE chat_sessions SET model=?,reasoning_effort=?,updated_at=? WHERE id=?')
      .run(model, reasoningEffort, now(), id);
    const row = this.connection.prepare('SELECT * FROM chat_sessions WHERE id=?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) throw new Error('CHAT_NOT_FOUND');
    return rowToChat(row);
  }
  deleteChat(id: string): void {
    this.connection
      .prepare('UPDATE chat_sessions SET deleted_at=?,updated_at=? WHERE id=?')
      .run(now(), now(), id);
  }
  listMessages(sessionId: string): ChatMessage[] {
    return (
      this.connection
        .prepare('SELECT * FROM chat_messages WHERE session_id=? ORDER BY sequence')
        .all(sessionId) as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      role: row.role as ChatMessage['role'],
      content: String(row.content),
      state: row.state as ChatMessage['state'],
      createdAt: String(row.created_at),
    }));
  }
  addMessage(
    sessionId: string,
    role: ChatMessage['role'],
    content: string,
    state: ChatMessage['state'],
  ): ChatMessage {
    const message = { id: randomUUID(), sessionId, role, content, state, createdAt: now() };
    const insert = this.connection.transaction(() => {
      const current = this.connection
        .prepare(
          'SELECT COALESCE(MAX(sequence),0) AS sequence FROM chat_messages WHERE session_id=?',
        )
        .get(sessionId) as { sequence: number };
      this.connection
        .prepare(
          'INSERT INTO chat_messages(id,session_id,role,content,state,created_at,sequence) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          message.id,
          message.sessionId,
          message.role,
          message.content,
          message.state,
          message.createdAt,
          Number(current.sequence) + 1,
        );
    });
    insert();
    this.connection
      .prepare('UPDATE chat_sessions SET updated_at=? WHERE id=?')
      .run(now(), sessionId);
    return message;
  }
  setThread(sessionId: string, threadId: string): void {
    this.connection
      .prepare('UPDATE chat_sessions SET codex_thread_id=? WHERE id=?')
      .run(threadId, sessionId);
  }
  beginTask(sessionType: string, sessionId: string, operation: string): string {
    const id = randomUUID();
    this.connection
      .prepare(
        'INSERT INTO ai_tasks(id,session_type,session_id,operation,state,started_at) VALUES(?,?,?,?,?,?)',
      )
      .run(id, sessionType, sessionId, operation, 'running', now());
    return id;
  }
  finishTask(
    id: string,
    state: string,
    errorCode: string | null = null,
    message: string | null = null,
  ): void {
    this.connection
      .prepare(
        'UPDATE ai_tasks SET state=?,completed_at=?,error_code=?,safe_error_message=? WHERE id=?',
      )
      .run(state, now(), errorCode, message, id);
  }
}

function rowToSummary(row: Record<string, unknown>): ReportSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    purpose: String(row.purpose),
    layoutMode: row.layout_mode as 'a4' | 'web',
    isFavorite: Boolean(row.is_favorite),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
  };
}

function escapeLike(value: string): string {
  // Escape the escape character first so user supplied `%`, `_`, and `\\`
  // remain literal while preserving ordinary Unicode (including Korean).
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

type ReportCursor =
  | { sort: 'updated'; favorite: number; updatedAt: string; id: string }
  | { sort: 'title'; title: string; id: string };

function encodeReportCursor(sort: 'updated' | 'title', row: ReportSummary): string {
  const cursor: ReportCursor =
    sort === 'title'
      ? { sort, title: row.title, id: row.id }
      : { sort, favorite: row.isFavorite ? 1 : 0, updatedAt: row.updatedAt, id: row.id };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeReportCursor(value: string): ReportCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Partial<ReportCursor>;
    if (
      parsed.sort === 'updated' &&
      typeof parsed.favorite === 'number' &&
      typeof parsed.updatedAt === 'string' &&
      typeof parsed.id === 'string'
    )
      return parsed as ReportCursor;
    if (
      parsed.sort === 'title' &&
      typeof parsed.title === 'string' &&
      typeof parsed.id === 'string'
    )
      return parsed as ReportCursor;
  } catch {
    /* fall through to a safe, explicit error */
  }
  throw new Error('INVALID_REPORT_CURSOR');
}

function rowToReport(row: Record<string, unknown>): Omit<Report, 'html' | 'editorJson'> {
  return {
    ...rowToSummary(row),
    personaId: row.persona_id ? String(row.persona_id) : null,
    personaConfig: String(row.persona_config ?? '{}'),
    outputOptions: reportOutputOptionsSchema.parse(JSON.parse(String(row.output_options))),
    contentPath: String(row.content_path),
    editorStatePath: String(row.editor_state_path),
    currentRevisionId: row.current_revision_id ? String(row.current_revision_id) : null,
    codexThreadId: row.codex_thread_id ? String(row.codex_thread_id) : null,
    htmlProjectionHash: String(row.html_projection_hash || ''),
    canonicalSchemaVersion: Number(row.canonical_schema_version || CANONICAL_SCHEMA_VERSION),
    latestGeneration: null,
  };
}
function rowToPersona(row: Record<string, unknown>): Persona {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    instructions: String(row.instructions),
    isBuiltIn: Boolean(row.is_built_in),
    isDefault: Boolean(row.is_default),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
function rowToChat(row: Record<string, unknown>): ChatSession {
  return {
    id: String(row.id),
    title: String(row.title),
    kind: row.kind as 'general' | 'report',
    reportId: row.report_id ? String(row.report_id) : null,
    codexThreadId: row.codex_thread_id ? String(row.codex_thread_id) : null,
    model: row.model ? String(row.model) : null,
    reasoningEffort: row.reasoning_effort ? String(row.reasoning_effort) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
  };
}

function assertDatabaseIntegrity(db: Database.Database): void {
  const result = db.pragma('quick_check', { simple: true }) as string;
  const values = [result];
  if (values.length !== 1 || values[0] !== 'ok') throw new Error('DATABASE_INTEGRITY_FAILED');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function storedReportPath(reportId: string, fileName: string): string {
  return path.posix.join('reports', reportId, fileName);
}
function toWorkspaceRelative(root: string, value: string): string {
  if (!path.isAbsolute(value)) return value.replaceAll('\\', '/');
  const relative = path.relative(root, value);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return value;
  return relative.split(path.sep).join('/');
}
function storedRevisionPath(
  reportId: string,
  revisionId: string,
  extension: 'json' | 'html',
): string {
  return path.posix.join('reports', reportId, 'revisions', `${revisionId}.${extension}`);
}

function canonicalFromHtml(inputHtml: string): {
  html: string;
  editorJson: unknown;
  htmlProjectionHash: string;
  editorJsonHash: string;
} {
  const html = sanitizeReportHtml(inputHtml || '<p></p>');
  return canonicalResult(html, htmlToTiptap(html));
}

function canonicalFromInput(inputHtml: string, inputEditorJson: unknown) {
  const html = sanitizeReportHtml(inputHtml || '<p></p>');
  const candidate = isTiptapDocument(inputEditorJson)
    ? inputEditorJson
    : { type: 'doc' as const, content: [] as unknown[] };
  // Older renderer versions sent an empty document while sending meaningful
  // HTML. Derive a document in that case so the two projections cannot drift.
  const editorJson =
    isEmptyTiptapDocument(candidate) && hasVisibleHtml(html) ? htmlToTiptap(html) : candidate;
  return canonicalResult(html, editorJson);
}
function canonicalResult(html: string, editorJson: unknown) {
  return {
    html,
    editorJson,
    htmlProjectionHash: contentHash(html),
    editorJsonHash: contentHash(JSON.stringify(editorJson)),
  };
}
function isTiptapDocument(value: unknown): value is { type: 'doc'; content?: unknown[] } {
  return Boolean(
    value && typeof value === 'object' && (value as { type?: unknown }).type === 'doc',
  );
}
function isEmptyTiptapDocument(value: { type: 'doc'; content?: unknown[] }): boolean {
  return !Array.isArray(value.content) || value.content.length === 0;
}
function hasVisibleHtml(html: string): boolean {
  return nodeText(parseHtml(html)).replaceAll('\u00a0', ' ').trim().length > 0;
}
function readEditorEnvelope(value: unknown): unknown {
  if (value && typeof value === 'object' && 'editorJson' in value) {
    const envelope = value as { schemaVersion?: unknown; editorJson?: unknown };
    if (
      Number(envelope.schemaVersion) !== CANONICAL_SCHEMA_VERSION ||
      !isTiptapDocument(envelope.editorJson)
    )
      throw new Error('REPORT_EDITOR_STATE_SCHEMA_INVALID');
    return envelope.editorJson;
  }
  // v1-v3 stored the bare Tiptap JSON document.
  if (isTiptapDocument(value)) return value;
  throw new Error('REPORT_EDITOR_STATE_SCHEMA_INVALID');
}

function htmlToTiptap(html: string): { type: 'doc'; content: unknown[] } {
  const blocks = parseHtml(html).children.flatMap(blockTiptap);
  return { type: 'doc', content: blocks };
}

type HtmlNode = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: HtmlNode[];
};

function parseHtml(html: string): { children: HtmlNode[] } {
  return parseDocument(html, { decodeEntities: true }) as unknown as { children: HtmlNode[] };
}

function blockTiptap(node: HtmlNode): unknown[] {
  if (node.type === 'text') {
    const text = node.data ?? '';
    return text.trim() ? [{ type: 'paragraph', content: textTiptap(text) }] : [];
  }
  const tag = node.name?.toLowerCase();
  const children = node.children ?? [];
  if (!tag) return children.flatMap(blockTiptap);
  if (/^h[1-4]$/.test(tag))
    return [
      {
        type: 'heading',
        attrs: { level: Number(tag.slice(1)) },
        content: inlineTiptap(children),
      },
    ];
  if (tag === 'p') return [{ type: 'paragraph', content: inlineTiptap(children) }];
  if (tag === 'blockquote') {
    const content = children.flatMap(blockTiptap);
    return [
      {
        type: 'blockquote',
        content: content.length
          ? content
          : [{ type: 'paragraph', content: inlineTiptap(children) }],
      },
    ];
  }
  if (tag === 'pre') {
    const text = nodeText(node);
    return [{ type: 'codeBlock', ...(text ? { content: textTiptap(text) } : {}) }];
  }
  if (tag === 'ul' || tag === 'ol') return [listTiptap(node, tag === 'ol')];
  if (tag === 'table') return [tableTiptap(node)];
  if (tag === 'hr') return [{ type: 'horizontalRule' }];
  const nestedBlocks = children.flatMap((child) =>
    isBlockElement(child) ? blockTiptap(child) : [],
  );
  if (nestedBlocks.length) return nestedBlocks;
  const inline = inlineTiptap(children);
  return inline.length ? [{ type: 'paragraph', content: inline }] : [];
}

function inlineTiptap(nodes: HtmlNode[], inheritedMarks: unknown[] = []): unknown[] {
  const result: unknown[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      const text = node.data ?? '';
      if (text) result.push(...textTiptap(text, inheritedMarks));
      continue;
    }
    const tag = node.name?.toLowerCase();
    if (!tag) {
      result.push(...inlineTiptap(node.children ?? [], inheritedMarks));
      continue;
    }
    if (tag === 'br') {
      result.push({ type: 'hardBreak' });
      continue;
    }
    if (tag === 'img') {
      const src = node.attribs?.src;
      if (src)
        result.push({
          type: 'image',
          attrs: {
            src,
            alt: node.attribs?.alt ?? null,
            title: node.attribs?.title ?? null,
          },
        });
      continue;
    }
    const marks = [...inheritedMarks];
    if (tag === 'strong' || tag === 'b') marks.push({ type: 'bold' });
    if (tag === 'em' || tag === 'i') marks.push({ type: 'italic' });
    if (tag === 'u') marks.push({ type: 'underline' });
    if (tag === 's') marks.push({ type: 'strike' });
    if (tag === 'code') marks.push({ type: 'code' });
    if (tag === 'a' && node.attribs?.href)
      marks.push({ type: 'link', attrs: { href: node.attribs.href } });
    result.push(...inlineTiptap(node.children ?? [], marks));
  }
  return result;
}

function textTiptap(text: string, marks: unknown[] = []): unknown[] {
  return text ? [{ type: 'text', text, ...(marks.length ? { marks } : {}) }] : [];
}

function listTiptap(node: HtmlNode, ordered: boolean): Record<string, unknown> {
  const items = (node.children ?? [])
    .filter((child) => child.name?.toLowerCase() === 'li')
    .map((item) => {
      const children = item.children ?? [];
      const nestedLists = children.filter((child) => ['ul', 'ol'].includes(child.name ?? ''));
      const inline = children.filter((child) => !nestedLists.includes(child));
      return {
        type: 'listItem',
        content: [
          { type: 'paragraph', content: inlineTiptap(inline) },
          ...nestedLists.map((child) => listTiptap(child, child.name === 'ol')),
        ],
      };
    });
  return { type: ordered ? 'orderedList' : 'bulletList', content: items };
}

function tableTiptap(node: HtmlNode): Record<string, unknown> {
  const rows = descendants(node, 'tr').map((row) => ({
    type: 'tableRow',
    content: (row.children ?? [])
      .filter((cell) => cell.name === 'th' || cell.name === 'td')
      .map((cell) => ({
        type: cell.name === 'th' ? 'tableHeader' : 'tableCell',
        attrs: {
          colspan: Number(cell.attribs?.colspan ?? 1),
          rowspan: Number(cell.attribs?.rowspan ?? 1),
          colwidth: null,
        },
        content: [{ type: 'paragraph', content: inlineTiptap(cell.children ?? []) }],
      })),
  }));
  return { type: 'table', content: rows };
}

function descendants(node: HtmlNode, tag: string): HtmlNode[] {
  const result: HtmlNode[] = [];
  for (const child of node.children ?? []) {
    if (child.name?.toLowerCase() === tag) result.push(child);
    else result.push(...descendants(child, tag));
  }
  return result;
}

function nodeText(node: HtmlNode | { children: HtmlNode[] }): string {
  if ('type' in node && node.type === 'text') return node.data ?? '';
  if ('type' in node && node.name?.toLowerCase() === 'br') return '\n';
  return (node.children ?? []).map(nodeText).join('');
}

function isBlockElement(node: HtmlNode): boolean {
  return /^(?:h[1-4]|p|blockquote|pre|ul|ol|table|hr|div|figure|figcaption)$/.test(
    node.name?.toLowerCase() ?? '',
  );
}

function parseRevisionEnvelope(
  value: unknown,
  legacy: Record<string, unknown>,
): {
  editorJson: unknown;
  html: string;
  title: string;
  purpose: string;
  outputOptions: ReportOutputOptions;
  layoutMode: 'a4' | 'web';
} {
  if (typeof value === 'string') {
    const html = sanitizeReportHtml(value);
    return {
      editorJson: htmlToTiptap(html),
      html,
      title: String(legacy.title || ''),
      purpose: String(legacy.purpose || ''),
      outputOptions: reportOutputOptionsSchema.parse(
        JSON.parse(String(legacy.output_options || '{}')),
      ),
      layoutMode: (legacy.layout_mode as 'a4' | 'web') || 'a4',
    };
  }
  if (!value || typeof value !== 'object' || !('html' in value) || !('editorJson' in value))
    throw new Error('REVISION_SCHEMA_INVALID');
  const envelope = value as Record<string, unknown>;
  if (Number(envelope.schemaVersion) !== CANONICAL_SCHEMA_VERSION)
    throw new Error('REVISION_SCHEMA_INVALID');
  const html = sanitizeReportHtml(String(envelope.html));
  return {
    editorJson: readEditorEnvelope({
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      editorJson: envelope.editorJson,
    }),
    html,
    title: String(envelope.title || ''),
    purpose: String(envelope.purpose || ''),
    outputOptions: reportOutputOptionsSchema.parse(envelope.outputOptions),
    layoutMode: envelope.layoutMode as 'a4' | 'web',
  };
}

function revisionFromRow(row: Record<string, unknown>, paths: WorkspacePaths): Revision {
  const html = row.html == null ? '' : String(row.html);
  const editorJson = row.editor_json
    ? (JSON.parse(String(row.editor_json)) as unknown)
    : EMPTY_TIPTAP_DOC;
  return {
    id: String(row.id),
    reportId: String(row.report_id),
    snapshotPath: path.isAbsolute(String(row.snapshot_path))
      ? String(row.snapshot_path)
      : path.resolve(paths.root, String(row.snapshot_path)),
    reason: String(row.reason),
    description: String(row.description),
    baseContentHash: String(row.base_content_hash),
    createdAt: String(row.created_at),
    schemaVersion: Number(row.schema_version || 1),
    editorJson,
    html,
    title: String(row.title || ''),
    purpose: String(row.purpose || ''),
    outputOptions: reportOutputOptionsSchema.parse(
      row.output_options ? JSON.parse(String(row.output_options)) : DEFAULT_OPTIONS,
    ),
    layoutMode: (row.layout_mode as 'a4' | 'web') || 'a4',
    htmlProjectionHash: String(row.html_projection_hash || row.base_content_hash),
    editorJsonHash: String(row.editor_json_hash || contentHash(JSON.stringify(editorJson))),
  };
}

function fileReadError(code: string, cause: unknown): Error {
  const error = new Error(code);
  Object.defineProperty(error, 'cause', { value: cause, enumerable: false });
  return error;
}
