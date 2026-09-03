import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  createWorkspaceSnapshot,
  ensureWorkspace,
  restoreWorkspaceSnapshotDryRun,
} from '../../src/main/workspace/manager.js';
import { AppDatabase } from '../../src/main/database/database.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
});
const options = {
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
} as const;
async function database() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lg-agent-db-'));
  roots.push(root);
  const paths = await ensureWorkspace(root);
  const db = new AppDatabase(paths);
  await db.open();
  return db;
}
describe('SQLite repositories', () => {
  it('migrates, seeds personas, and performs report lifecycle', async () => {
    const db = await database();
    expect(db.listPersonas()).toHaveLength(8);
    const report = await db.createReport({
      title: '테스트',
      purpose: '목적',
      personaId: null,
      outputOptions: options,
      layoutMode: 'a4',
      html: '<h1>안전</h1><script>x</script>',
    });
    expect((await db.getReport(report.id)).html).toBe('<h1>안전</h1>');
    db.favoriteReport(report.id, true);
    expect(db.listReports()[0]?.isFavorite).toBe(true);
    db.renameReport(report.id, '변경');
    expect((await db.getReport(report.id)).title).toBe('변경');
    db.trashReport(report.id);
    expect(db.listReports(true)).toHaveLength(1);
    db.restoreReport(report.id);
    expect(db.listReports()).toHaveLength(1);
    const duplicate = await db.duplicateReport(report.id);
    expect(duplicate.id).not.toBe(report.id);
    await db.deleteReport(duplicate.id);
    expect(db.listReports()).toHaveLength(1);
    db.close();
  });
  it('creates and restores revisions without losing the previous state', async () => {
    const db = await database();
    const report = await db.createReport({
      title: '버전',
      purpose: '',
      personaId: null,
      outputOptions: options,
      layoutMode: 'web',
      html: '<p>처음</p>',
    });
    const first = db.listRevisions(report.id)[0]!;
    await db.saveReport({
      id: report.id,
      title: '버전',
      html: '<p>변경</p>',
      editorJson: { type: 'doc' },
      layoutMode: 'web',
    });
    await db.createRevision(report.id, 'manual', '수동');
    expect(db.listRevisions(report.id).length).toBe(2);
    const restored = await db.restoreRevision(report.id, first.id);
    expect(restored.html).toBe('<p>처음</p>');
    expect(db.listRevisions(report.id).length).toBe(4);
    db.close();
  });
  it('keeps Tiptap JSON canonical and stores a complete revision envelope', async () => {
    const db = await database();
    const report = await db.createReport({
      title: 'Canonical',
      purpose: '',
      personaId: null,
      outputOptions: options,
      layoutMode: 'web',
      html: '<h1>제목</h1><p>본문</p>',
    });
    expect((report.editorJson as { content: unknown[] }).content.length).toBeGreaterThan(0);
    expect(report.htmlProjectionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.contentPath).toContain(`${path.sep}reports${path.sep}${report.id}${path.sep}`);
    const editorEnvelope = JSON.parse(
      await readFile(path.join(path.dirname(report.contentPath), 'editor.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(editorEnvelope.schemaVersion).toBe(1);
    expect(editorEnvelope.htmlProjectionHash).toBe(report.htmlProjectionHash);
    const revision = db.listRevisions(report.id)[0]!;
    expect(revision.editorJson).toEqual(report.editorJson);
    expect(revision.html).toBe(report.html);
    expect(revision.outputOptions).toEqual(options);
    db.close();
  });
  it('parses sanitized HTML into Tiptap without regex tag stripping or double entity decoding', async () => {
    const db = await database();
    const report = await db.createReport({
      title: 'DOM 변환',
      purpose: '',
      personaId: null,
      outputOptions: options,
      layoutMode: 'web',
      html: '<h2><strong>제목</strong></h2><p>&amp;lt;script&amp;gt;</p><script>alert(1)</script>',
    });
    const document = report.editorJson as {
      type: string;
      content: Array<{ type: string; attrs?: { level?: number }; content?: unknown[] }>;
    };
    expect(document.content[0]).toMatchObject({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: '제목', marks: [{ type: 'bold' }] }],
    });
    expect(JSON.stringify(document)).toContain('&lt;script&gt;');
    expect(JSON.stringify(document)).not.toContain('alert(1)');
    db.close();
  });
  it('saves generated content while quarantining invented source references', async () => {
    const db = await database();
    const report = await db.createReport({
      title: '근거 없음',
      purpose: '',
      personaId: null,
      outputOptions: options,
      layoutMode: 'web',
      html: '<p>초안</p>',
    });
    const inventedSourceId = randomUUID();
    const saved = await db.saveReport({
      id: report.id,
      title: '생성 완료',
      html: '<p>생성 본문</p>',
      editorJson: { type: 'doc', content: [] },
      layoutMode: 'web',
      generation: {
        schemaVersion: 1,
        executiveSummary: '요약',
        sourceUsage: [
          { sourceId: inventedSourceId, locator: 'page 1', claimSummary: '검증 불가 주장' },
        ],
        assumptions: [],
        warnings: [],
        model: null,
        promptVersion: 'generation-v1',
        sourceSnapshotHashes: {},
        claimEvidence: [
          {
            claim: '검증 불가 주장',
            sourceId: inventedSourceId,
            locator: 'page 1',
          },
        ],
      },
    });
    expect(saved.title).toBe('생성 완료');
    expect(saved.html).toBe('<p>생성 본문</p>');
    expect(saved.latestGeneration?.sourceUsage).toEqual([]);
    expect(saved.latestGeneration?.claimEvidence).toEqual([]);
    expect(saved.latestGeneration?.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('현재 보고서에 없는 Source'),
        expect.stringContaining('주장-근거'),
      ]),
    );
    db.close();
  });
  it('preserves generation evidence backed by a readable report Source snapshot', async () => {
    const db = await database();
    const report = await db.createReport({
      title: '근거 있음',
      purpose: '',
      personaId: null,
      outputOptions: options,
      layoutMode: 'web',
      html: '<p>초안</p>',
    });
    const sourceId = randomUUID();
    const sourceDirectory = path.join(path.dirname(report.contentPath), 'source-extracted');
    const extractedPath = path.join(sourceDirectory, `${sourceId}.json`);
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(extractedPath, JSON.stringify({ locator: 'page 1' }));
    db.saveSource(report.id, {
      sourceId,
      originalName: 'evidence.txt',
      storedPath: `reports/${report.id}/source-originals/evidence.txt`,
      mimeType: 'text/plain',
      size: 8,
      sha256: 'a'.repeat(64),
      extractionStatus: 'ready',
      extractedPath: `reports/${report.id}/source-extracted/${sourceId}.json`,
      metadata: {},
      warnings: [],
      createdAt: new Date().toISOString(),
    });
    const saved = await db.saveReport({
      id: report.id,
      title: report.title,
      html: '<p>근거 기반 본문</p>',
      editorJson: { type: 'doc', content: [] },
      layoutMode: 'web',
      generation: {
        schemaVersion: 1,
        executiveSummary: '요약',
        sourceUsage: [{ sourceId, locator: 'page 1', claimSummary: '근거 기반 주장' }],
        assumptions: [],
        warnings: [],
        model: null,
        promptVersion: 'generation-v1',
        sourceSnapshotHashes: {},
        claimEvidence: [],
      },
    });
    expect(saved.latestGeneration?.sourceUsage).toEqual([
      { sourceId, locator: 'page 1', claimSummary: '근거 기반 주장' },
    ]);
    expect(saved.latestGeneration?.claimEvidence).toEqual([
      {
        claim: '근거 기반 주장',
        sourceId,
        locator: 'page 1',
        evidenceExcerpt: undefined,
      },
    ]);
    expect(saved.latestGeneration?.sourceSnapshotHashes[sourceId]).toMatch(/^[0-9a-f]{64}$/);
    db.close();
  });
  it('rolls back a staged pair during startup reconciliation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lg-agent-reconcile-'));
    roots.push(root);
    const paths = await ensureWorkspace(root);
    const db = new AppDatabase(paths);
    await db.open();
    const report = await db.createReport({
      title: '복구',
      purpose: '',
      personaId: null,
      outputOptions: options,
      layoutMode: 'web',
      html: '<p>원본</p>',
    });
    db.close();
    const operationId = '11111111-1111-4111-8111-111111111111';
    const stage = path.join(path.dirname(report.contentPath), '.staging', operationId);
    await mkdir(stage, { recursive: true });
    await writeFile(path.join(stage, 'report.html'), '<p>중단</p>');
    const raw = new Database(paths.database);
    raw
      .prepare(
        'INSERT INTO operation_journal(id,operation,target,state,started_at,phase,stage_path,backup_path,payload) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        operationId,
        'save-report',
        `reports/${report.id}/report.html`,
        'staged',
        new Date().toISOString(),
        'staged',
        stage,
        path.join(path.dirname(stage), `${operationId}.backup`),
        '{}',
      );
    raw.close();
    const reopened = new AppDatabase(paths);
    await reopened.open();
    expect(await readFile(report.contentPath, 'utf8')).toBe('<p>원본</p>');
    const check = new Database(paths.database, { readonly: true });
    expect(
      (
        check.prepare('SELECT state FROM operation_journal WHERE id=?').get(operationId) as {
          state: string;
        }
      ).state,
    ).toBe('rolled_back');
    check.close();
    reopened.close();
  });
  it('surfaces missing canonical content instead of returning an empty document', async () => {
    const db = await database();
    const report = await db.createReport({
      title: '읽기 오류',
      purpose: '',
      personaId: null,
      outputOptions: options,
      layoutMode: 'web',
      html: '<p>내용</p>',
    });
    await rm(report.contentPath);
    await expect(db.getReport(report.id)).rejects.toThrow('REPORT_CONTENT_READ_FAILED');
    db.close();
  });
  it('takes an online backup on reopen of an existing WAL database', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lg-agent-backup-'));
    roots.push(root);
    const paths = await ensureWorkspace(root);
    const first = new AppDatabase(paths);
    await first.open();
    first.addMessage((await first.createChat('백업', null)).id, 'user', '상태', 'complete');
    first.close();
    const second = new AppDatabase(paths);
    await second.open();
    expect((await readdir(paths.backups)).some((name) => name.startsWith('app-'))).toBe(true);
    second.close();
  });
  it('exports a full hash manifest and reports tampering during restore dry-run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lg-agent-snapshot-'));
    roots.push(root);
    const paths = await ensureWorkspace(root);
    const db = new AppDatabase(paths);
    await db.open();
    const report = await db.createReport({
      title: '스냅샷',
      purpose: '',
      personaId: null,
      outputOptions: options,
      layoutMode: 'web',
      html: '<p>보존</p>',
    });
    const snapshot = await createWorkspaceSnapshot(paths);
    expect(snapshot.manifest.mode).toBe('full');
    expect(snapshot.manifest.files.some((file) => file.path === 'app.db')).toBe(true);
    expect(snapshot.manifest.files.some((file) => file.path.endsWith('/report.html'))).toBe(true);
    expect((await restoreWorkspaceSnapshotDryRun(paths, snapshot.directory)).valid).toBe(true);
    await writeFile(report.contentPath.replace(root, snapshot.directory), '<p>변조</p>');
    const check = await restoreWorkspaceSnapshotDryRun(paths, snapshot.directory);
    expect(check.valid).toBe(false);
    expect(check.files.modified).toContain(`reports/${report.id}/report.html`);
    db.close();
  });
  it('uses durable SQLite settings, escaped Korean search, cursor pages, and message sequences', async () => {
    const db = await database();
    const chat = await db.createChat('검색', null);
    db.addMessage(chat.id, 'user', '첫째', 'complete');
    db.addMessage(chat.id, 'assistant', '둘째', 'complete');
    expect(db.listMessages(chat.id).map((message) => message.content)).toEqual(['첫째', '둘째']);
    const connection = (db as unknown as { db: Database.Database }).db;
    expect(connection.pragma('synchronous', { simple: true })).toBe(2);
    expect(
      (
        connection.prepare('SELECT sequence FROM chat_messages ORDER BY sequence').all() as Array<{
          sequence: number;
        }>
      ).map((row) => row.sequence),
    ).toEqual([1, 2]);
    await db.createReport({
      title: '100%_한국어',
      purpose: '목적',
      personaId: null,
      outputOptions: options,
      layoutMode: 'web',
      html: '<p>본문</p>',
    });
    // `%` is treated as a literal query character, not as a wildcard.
    expect(db.listReports(false, '%').map((item) => item.title)).toEqual(['100%_한국어']);
    expect(db.listReportsPage({ limit: 1 }).items).toHaveLength(1);
    db.close();
  });
  it('keeps cursor listing within a loose 2,000-report regression budget', async () => {
    const db = await database();
    const connection = (db as unknown as { db: Database.Database }).db;
    const insert = connection.prepare(
      'INSERT INTO reports(id,title,purpose,persona_id,output_options,layout_mode,content_path,editor_state_path,canonical_schema_version,html_projection_hash,editor_json_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    const stamp = new Date().toISOString();
    connection.transaction(() => {
      for (let index = 0; index < 2_000; index++) {
        const id = randomUUID();
        insert.run(
          id,
          `보고서 ${index}`,
          'benchmark',
          null,
          JSON.stringify(options),
          'web',
          `reports/${id}/report.html`,
          `reports/${id}/editor.json`,
          1,
          '',
          '',
          stamp,
          stamp,
        );
      }
    })();
    const started = performance.now();
    const page = db.listReportsPage({ limit: 100, query: '보고서' });
    expect(page.items).toHaveLength(100);
    expect(page.nextCursor).toBeTruthy();
    // Keep this intentionally loose for Windows CI and debug builds.
    expect(performance.now() - started).toBeLessThan(2_000);
    db.close();
  });
  it('persists chats and messages separately from Codex threads', async () => {
    const db = await database();
    const chat = await db.createChat('대화', null);
    expect(chat.model).toBeNull();
    const configured = db.updateChatAiSettings(chat.id, 'dynamic-model', 'high');
    expect(configured.model).toBe('dynamic-model');
    expect(configured.reasoningEffort).toBe('high');
    db.addMessage(chat.id, 'user', '질문', 'complete');
    db.addMessage(chat.id, 'assistant', '응답', 'complete');
    expect(db.listMessages(chat.id).map((m) => m.content)).toEqual(['질문', '응답']);
    db.renameChat(chat.id, '변경');
    expect(db.listChats()[0]?.title).toBe('변경');
    expect(db.listChats()[0]?.model).toBe('dynamic-model');
    db.deleteChat(chat.id);
    expect(db.listChats()).toHaveLength(0);
    db.close();
  });
});
