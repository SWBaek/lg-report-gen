import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureWorkspace } from '../../src/main/workspace/manager.js';
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
  it('persists chats and messages separately from Codex threads', async () => {
    const db = await database();
    const chat = await db.createChat('대화', null);
    db.addMessage(chat.id, 'user', '질문', 'complete');
    db.addMessage(chat.id, 'assistant', '응답', 'complete');
    expect(db.listMessages(chat.id).map((m) => m.content)).toEqual(['질문', '응답']);
    db.renameChat(chat.id, '변경');
    expect(db.listChats()[0]?.title).toBe('변경');
    db.deleteChat(chat.id);
    expect(db.listChats()).toHaveLength(0);
    db.close();
  });
});
