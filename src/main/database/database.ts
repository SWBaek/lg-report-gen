import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  ChatMessage,
  ChatSession,
  Persona,
  Report,
  ReportOutputOptions,
  ReportSummary,
  Revision,
  SourceManifestEntry,
} from '../../shared/types/index.js';
import { atomicWrite, contentHash, sanitizeReportHtml } from '../services/files.js';
import type { WorkspacePaths } from '../workspace/manager.js';
import { backupDatabase } from '../workspace/manager.js';

const now = (): string => new Date().toISOString();
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
  reasoningEffort: null,
};
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
    await backupDatabase(this.paths);
    const binding = nativeBinding();
    this.db = new Database(this.paths.database, binding ? { nativeBinding: binding } : undefined);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    this.db
      .prepare("UPDATE ai_tasks SET state='interrupted', completed_at=? WHERE state='running'")
      .run(now());
    this.seedPersonas();
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
      CREATE TABLE reports(id TEXT PRIMARY KEY,title TEXT NOT NULL,purpose TEXT NOT NULL,persona_id TEXT REFERENCES personas(id),persona_config TEXT NOT NULL DEFAULT '{}',output_options TEXT NOT NULL,layout_mode TEXT NOT NULL,content_path TEXT NOT NULL,editor_state_path TEXT NOT NULL,current_revision_id TEXT,codex_thread_id TEXT,is_favorite INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
      CREATE TABLE report_revisions(id TEXT PRIMARY KEY,report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,snapshot_path TEXT NOT NULL,reason TEXT NOT NULL,description TEXT NOT NULL,base_content_hash TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE report_sources(id TEXT PRIMARY KEY,report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,original_name TEXT NOT NULL,stored_path TEXT NOT NULL,mime_type TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,extraction_status TEXT NOT NULL,extracted_path TEXT,metadata TEXT NOT NULL,warnings TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE tags(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
      CREATE TABLE report_tags(report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,PRIMARY KEY(report_id,tag_id));
      CREATE TABLE chat_sessions(id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,codex_thread_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
      CREATE TABLE chat_messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,role TEXT NOT NULL,content TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE ai_tasks(id TEXT PRIMARY KEY,session_type TEXT NOT NULL,session_id TEXT NOT NULL,operation TEXT NOT NULL,state TEXT NOT NULL,started_at TEXT NOT NULL,completed_at TEXT,error_code TEXT,safe_error_message TEXT);
      CREATE INDEX reports_updated_idx ON reports(updated_at DESC); CREATE INDEX messages_session_idx ON chat_messages(session_id,created_at);
    `);
        db.pragma('user_version = 1');
      })();
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
    const where = includeDeleted ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL';
    const order = sort === 'title' ? 'title COLLATE NOCASE' : 'is_favorite DESC, updated_at DESC';
    const terms = `%${query.trim()}%`;
    const rows = this.connection
      .prepare(
        `SELECT id,title,purpose,layout_mode,is_favorite,created_at,updated_at,deleted_at FROM reports WHERE ${where} AND (title LIKE ? OR purpose LIKE ?) ORDER BY ${order}`,
      )
      .all(terms, terms) as Record<string, unknown>[];
    return rows.map(rowToSummary);
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
    const dir = path.join(this.paths.reports, id);
    await Promise.all(
      ['source-originals', 'source-extracted', 'revisions', 'agent-work', 'assets'].map((name) =>
        mkdir(path.join(dir, name), { recursive: true }),
      ),
    );
    const contentPath = path.join(dir, 'report.html');
    const editorStatePath = path.join(dir, 'editor.json');
    const html = sanitizeReportHtml(input.html);
    await atomicWrite(contentPath, html);
    await atomicWrite(editorStatePath, JSON.stringify({ type: 'doc', content: [] }));
    const stamp = now();
    this.connection
      .prepare(
        'INSERT INTO reports(id,title,purpose,persona_id,output_options,layout_mode,content_path,editor_state_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.title || '제목 없는 보고서',
        input.purpose,
        input.personaId,
        JSON.stringify(input.outputOptions ?? DEFAULT_OPTIONS),
        input.layoutMode,
        contentPath,
        editorStatePath,
        stamp,
        stamp,
      );
    await this.createRevision(id, 'created', '보고서 최초 생성');
    return this.getReport(id);
  }
  async getReport(id: string): Promise<Report> {
    const row = this.connection.prepare('SELECT * FROM reports WHERE id=?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) throw new Error('REPORT_NOT_FOUND');
    const contentPath = String(row.content_path);
    const editorPath = String(row.editor_state_path);
    return {
      ...rowToReport(row),
      html: await readFile(contentPath, 'utf8').catch(() => '<p></p>'),
      editorJson: JSON.parse(
        await readFile(editorPath, 'utf8').catch(() => '{"type":"doc","content":[]}'),
      ) as unknown,
    };
  }
  async saveReport(input: {
    id: string;
    title: string;
    html: string;
    editorJson: unknown;
    layoutMode: 'a4' | 'web';
  }): Promise<Report> {
    const current = await this.getReport(input.id);
    const html = sanitizeReportHtml(input.html);
    await atomicWrite(current.contentPath, html);
    await atomicWrite(current.editorStatePath, JSON.stringify(input.editorJson));
    this.connection
      .prepare('UPDATE reports SET title=?,layout_mode=?,updated_at=? WHERE id=?')
      .run(input.title, input.layoutMode, now(), input.id);
    return this.getReport(input.id);
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
    const report = await this.getReport(id);
    this.connection.prepare('DELETE FROM reports WHERE id=?').run(id);
    await rm(path.dirname(report.contentPath), { recursive: true, force: true });
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
    const snapshotPath = path.join(path.dirname(report.contentPath), 'revisions', `${id}.html`);
    const hash = contentHash(report.html);
    await atomicWrite(snapshotPath, report.html);
    const createdAt = now();
    this.connection.transaction(() => {
      this.connection
        .prepare('INSERT INTO report_revisions VALUES(?,?,?,?,?,?,?)')
        .run(id, reportId, snapshotPath, reason, description, hash, createdAt);
      this.connection
        .prepare('UPDATE reports SET current_revision_id=? WHERE id=?')
        .run(id, reportId);
    })();
    return { id, reportId, snapshotPath, reason, description, baseContentHash: hash, createdAt };
  }
  listRevisions(reportId: string): Revision[] {
    return (
      this.connection
        .prepare('SELECT * FROM report_revisions WHERE report_id=? ORDER BY created_at DESC')
        .all(reportId) as Record<string, unknown>[]
    ).map((row) => ({
      id: String(row.id),
      reportId: String(row.report_id),
      snapshotPath: String(row.snapshot_path),
      reason: String(row.reason),
      description: String(row.description),
      baseContentHash: String(row.base_content_hash),
      createdAt: String(row.created_at),
    }));
  }
  async restoreRevision(reportId: string, revisionId: string): Promise<Report> {
    const revision = this.connection
      .prepare('SELECT * FROM report_revisions WHERE id=? AND report_id=?')
      .get(revisionId, reportId) as Record<string, unknown> | undefined;
    if (!revision) throw new Error('REVISION_NOT_FOUND');
    await this.createRevision(reportId, 'before-restore', '버전 복원 이전');
    const report = await this.getReport(reportId);
    await atomicWrite(
      report.contentPath,
      sanitizeReportHtml(await readFile(String(revision.snapshot_path), 'utf8')),
    );
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
  listChats(): ChatSession[] {
    return (
      this.connection
        .prepare('SELECT * FROM chat_sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC')
        .all() as Record<string, unknown>[]
    ).map(rowToChat);
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
  deleteChat(id: string): void {
    this.connection
      .prepare('UPDATE chat_sessions SET deleted_at=?,updated_at=? WHERE id=?')
      .run(now(), now(), id);
  }
  listMessages(sessionId: string): ChatMessage[] {
    return (
      this.connection
        .prepare('SELECT * FROM chat_messages WHERE session_id=? ORDER BY created_at')
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
    this.connection
      .prepare('INSERT INTO chat_messages VALUES(?,?,?,?,?,?)')
      .run(
        message.id,
        message.sessionId,
        message.role,
        message.content,
        message.state,
        message.createdAt,
      );
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
function rowToReport(row: Record<string, unknown>): Omit<Report, 'html' | 'editorJson'> {
  return {
    ...rowToSummary(row),
    personaId: row.persona_id ? String(row.persona_id) : null,
    personaConfig: String(row.persona_config ?? '{}'),
    outputOptions: JSON.parse(String(row.output_options)) as ReportOutputOptions,
    contentPath: String(row.content_path),
    editorStatePath: String(row.editor_state_path),
    currentRevisionId: row.current_revision_id ? String(row.current_revision_id) : null,
    codexThreadId: row.codex_thread_id ? String(row.codex_thread_id) : null,
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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
  };
}
