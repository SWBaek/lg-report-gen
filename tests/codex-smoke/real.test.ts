import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServerManager } from '../../src/main/codex/app-server-manager.js';
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
});
