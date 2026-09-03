import { afterAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServerManager } from '../../src/main/codex/app-server-manager.js';
import { outputSchemaFor } from '../../src/main/codex/output-schema.js';
import { reportOutputSchema } from '../../src/shared/schemas/index.js';
import type { CodexEvent } from '../../src/shared/types/index.js';

const manager = new CodexAppServerManager();
let root: string | null = null;
afterAll(async () => {
  await manager.stop();
  if (root) await rm(root, { recursive: true, force: true });
});
describe('real Codex CLI smoke test', () => {
  it('discovers, authenticates, lists models, and completes a short isolated turn', async () => {
    const snapshot = await manager.refresh();
    expect(snapshot.installed).toBe(true);
    expect(snapshot.appServerSupported).toBe(true);
    expect(snapshot.authenticated).toBe(true);
    expect(snapshot.availableModels.length).toBeGreaterThan(0);
    root = await mkdtemp(path.join(os.tmpdir(), 'lg-report-codex-smoke-'));
    let response = '';
    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('CODEX_REQUEST_TIMEOUT')), 60_000);
      manager.on('event', (event: CodexEvent) => {
        if (event.type === 'delta') response += event.text ?? '';
        if (event.type === 'complete') {
          clearTimeout(timeout);
          resolve();
        }
        if (event.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(event.errorCode ?? 'CODEX_EXECUTION_FAILED'));
        }
      });
    });
    const turn = await manager.startTurn({
      taskId: 'smoke-task',
      sessionId: 'smoke-session',
      prompt: "상태 확인용 요청이다. 다른 작업이나 파일 접근 없이 '확인'이라고만 답하라.",
      cwd: root,
      threadId: null,
      model: snapshot.selectedModel,
      effort: null,
      outputSchema: null,
      writable: false,
    });
    await completed;
    expect(response.length).toBeGreaterThan(0);
    await manager.deleteThread(turn.threadId);
  }, 90_000);

  it('completes the structured-output contract used by report generation', async () => {
    const snapshot = await manager.refresh();
    root ??= await mkdtemp(path.join(os.tmpdir(), 'lg-report-codex-smoke-'));
    const writableRoot = path.join(root, 'agent-work', 'output');
    await mkdir(writableRoot, { recursive: true });
    let finalText = '';
    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('CODEX_REQUEST_TIMEOUT')), 90_000);
      manager.once('event', function onEvent(event: CodexEvent) {
        if (event.type === 'state') {
          manager.once('event', onEvent);
          return;
        }
        if (event.type === 'complete') {
          clearTimeout(timeout);
          finalText = event.text ?? '';
          resolve();
          return;
        }
        if (event.type === 'error') {
          clearTimeout(timeout);
          reject(
            new Error(`${event.errorCode ?? 'CODEX_EXECUTION_FAILED'}:${event.message ?? ''}`),
          );
          return;
        }
        manager.once('event', onEvent);
      });
    });
    const turn = await manager.startTurn({
      taskId: 'structured-smoke-task',
      sessionId: 'structured-smoke-session',
      prompt:
        '구조화 출력 검증이다. 제목과 한 문단의 안전한 HTML 본문을 만들고 나머지 배열은 비워라.',
      cwd: root,
      writableRoot,
      threadId: null,
      model: snapshot.selectedModel,
      effort: null,
      outputSchema: outputSchemaFor('generate', []),
      writable: true,
    });
    await completed;
    expect(reportOutputSchema.parse(JSON.parse(finalText))).toMatchObject({
      sourceUsage: [],
      assumptions: [],
      warnings: [],
    });
    await manager.deleteThread(turn.threadId);
  }, 120_000);
});
