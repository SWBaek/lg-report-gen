import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServerManager } from '../../src/main/codex/app-server-manager.js';
import type { CodexEvent } from '../../src/shared/types/index.js';

const roots: string[] = [];
const managers: CodexAppServerManager[] = [];
afterEach(async () => {
  for (const manager of managers) await manager.stop();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
  managers.length = 0;
});
describe('Codex JSON-RPC broker', () => {
  it.runIf(process.platform === 'win32')(
    'correlates requests, masks account, discovers models, and streams a turn',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'mock-codex-'));
      roots.push(root);
      const wrapper = path.join(root, 'codex.cmd');
      const fixture = path.resolve('tests/fixtures/mock-codex.cjs');
      await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
      const manager = new CodexAppServerManager();
      managers.push(manager);
      manager.setConfiguredPath(wrapper);
      const snapshot = await manager.refresh();
      expect(snapshot.state).toBe('ready');
      expect(snapshot.maskedAccount).toBe('us***@example.com');
      expect(snapshot.selectedModel).toBe('dynamic-model');
      expect(snapshot.availableModels[0]?.defaultReasoningEffort).toBe('medium');
      expect(snapshot.availableModels[0]?.reasoningEfforts).toEqual(['low', 'medium', 'high']);
      const events: CodexEvent[] = [];
      manager.on('event', (event: CodexEvent) => events.push(event));
      const done = new Promise<void>((resolve) =>
        manager.on('event', (event: CodexEvent) => {
          if (event.type === 'complete') resolve();
        }),
      );
      const work = path.join(root, 'agent-work');
      await import('node:fs/promises').then((fs) => fs.mkdir(work));
      const result = await manager.startTurn({
        taskId: 'task',
        sessionId: 'session',
        prompt: 'hello',
        cwd: work,
        threadId: null,
        model: null,
        effort: null,
        outputSchema: null,
        writable: false,
      });
      expect(result.threadId).toBe('thread-1');
      await done;
      expect(
        events
          .filter((e) => e.type === 'delta')
          .map((e) => e.text)
          .join(''),
      ).toBe('안전한 응답');
      expect(events.find((event) => event.type === 'complete')?.text).toBe('안전한 응답');
    },
  );
});
