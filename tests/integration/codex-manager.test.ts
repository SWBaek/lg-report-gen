import { afterEach, describe, expect, it } from 'vitest';
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexAppServerManager } from '../../src/main/codex/app-server-manager.js';
import type { CodexEvent } from '../../src/shared/types/index.js';

const roots: string[] = [];
const managers: CodexAppServerManager[] = [];
const previousMode = process.env.MOCK_CODEX_MODE;
const previousCrashMarker = process.env.MOCK_CODEX_CRASH_MARKER;
const previousAllowUnsigned = process.env.LG_REPORT_AGENT_CODEX_ALLOW_UNSIGNED_DEV;
const previousNodeEnv = process.env.NODE_ENV;
afterEach(async () => {
  for (const manager of managers) await manager.stop();
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.length = 0;
  managers.length = 0;
  if (previousMode === undefined) delete process.env.MOCK_CODEX_MODE;
  else process.env.MOCK_CODEX_MODE = previousMode;
  if (previousCrashMarker === undefined) delete process.env.MOCK_CODEX_CRASH_MARKER;
  else process.env.MOCK_CODEX_CRASH_MARKER = previousCrashMarker;
  if (previousAllowUnsigned === undefined)
    delete process.env.LG_REPORT_AGENT_CODEX_ALLOW_UNSIGNED_DEV;
  else process.env.LG_REPORT_AGENT_CODEX_ALLOW_UNSIGNED_DEV = previousAllowUnsigned;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

async function createManager(
  mode = 'normal',
  options?: ConstructorParameters<typeof CodexAppServerManager>[0],
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mock-codex-'));
  roots.push(root);
  process.env.MOCK_CODEX_MODE = mode;
  const fixture = path.resolve('tests/fixtures/mock-codex.cjs');
  const executable = path.join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex.cjs');
  if (process.platform === 'win32') {
    await writeFile(executable, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
  } else {
    await copyFile(fixture, executable);
    await chmod(executable, 0o755);
  }
  if (mode === 'crash-once') process.env.MOCK_CODEX_CRASH_MARKER = path.join(root, 'crash.marker');
  // The fixture is intentionally unsigned; accepting it is an explicit test-only override.
  process.env.NODE_ENV = 'test';
  process.env.LG_REPORT_AGENT_CODEX_ALLOW_UNSIGNED_DEV = '1';
  const manager = new CodexAppServerManager(options);
  managers.push(manager);
  manager.setConfiguredPath(executable);
  await manager.refresh();
  return { manager, root };
}

function turnInput(root: string, taskId = 'task') {
  return {
    taskId,
    sessionId: 'session',
    prompt: 'hello',
    cwd: root,
    threadId: null,
    model: null,
    effort: null,
    outputSchema: null,
    writable: false,
  } as const;
}
describe('Codex JSON-RPC broker', () => {
  it('negotiates a supported protocol and exposes client provenance without secrets', async () => {
    const { manager } = await createManager();
    expect(manager.protocolInfo).toMatchObject({
      client: { name: 'lg-report-agent', version: '1.1.0' },
      server: { name: 'mock', version: '99.0.0-test' },
      protocolVersion: 'v1',
      supported: true,
      provenance: 'codex-app-server',
    });
    expect(manager.protocolInfo.features.structuredOutput).toBe(true);
  });

  it('retries -32001 overload with bounded deterministic backoff', async () => {
    const delays: number[] = [];
    const { manager, root } = await createManager('overload-once', {
      random: () => 0.5,
      overloadBaseDelayMs: 10,
      overloadMaxDelayMs: 100,
      overloadMaxAttempts: 3,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });
    const result = await manager.startTurn(turnInput(root));
    expect(result.turnId).toBe('turn-1');
    expect(delays).toEqual([5]);
  });

  it('does not stream or expose malformed structured output', async () => {
    const { manager, root } = await createManager('malformed-structured');
    const events: CodexEvent[] = [];
    manager.on('event', (event: CodexEvent) => events.push(event));
    await manager.startTurn({
      ...turnInput(root),
      outputSchema: {
        type: 'object',
        required: ['answer'],
        properties: { answer: { type: 'string' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(events.some((event) => event.type === 'delta')).toBe(false);
    expect(events.find((event) => event.type === 'error')?.errorCode).toBe('CODEX_PROTOCOL_ERROR');
  });

  it('correlates requests, masks account, discovers models, and streams a turn', async () => {
    const { manager, root } = await createManager();
    const snapshot = manager.snapshot;
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
    const result = await manager.startTurn({ ...turnInput(work), taskId: 'task' });
    expect(result.threadId).toBe('thread-1');
    await done;
    expect(
      events
        .filter((e) => e.type === 'delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('안전한 응답');
    expect(events.find((event) => event.type === 'complete')?.text).toBe('안전한 응답');
  });

  it('reserves a starting turn before the first await and rejects a concurrent start', async () => {
    const { manager, root } = await createManager();
    const first = manager.startTurn(turnInput(root, 'first'));
    await expect(manager.startTurn(turnInput(root, 'second'))).rejects.toThrow('CODEX_BUSY');
    await first;
  });

  it('ignores out-of-order notifications and emits only one event for duplicate completion', async () => {
    const { manager, root } = await createManager('duplicate');
    const events: CodexEvent[] = [];
    manager.on('event', (event: CodexEvent) => events.push(event));
    await manager.startTurn(turnInput(root));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'delta').every((event) => event.text !== '무시'),
    ).toBe(true);
  });

  it('tombstones a cancelled turn so its late completion is ignored', async () => {
    const { manager, root } = await createManager('cancel-late');
    const events: CodexEvent[] = [];
    manager.on('event', (event: CodexEvent) => events.push(event));
    await manager.startTurn(turnInput(root));
    await manager.cancel();
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(events.some((event) => event.type === 'complete')).toBe(false);
  });

  it('resumes a persisted thread once after an app-server generation starts', async () => {
    const { manager, root } = await createManager();
    const result = await manager.startTurn({
      ...turnInput(root),
      threadId: 'persisted-thread',
    });
    expect(result.threadId).toBe('persisted-thread');
  });

  it('buffers a completion delivered in the same burst as turn/start', async () => {
    const { manager, root } = await createManager('fast');
    const events: CodexEvent[] = [];
    manager.on('event', (event: CodexEvent) => events.push(event));
    const result = await manager.startTurn(turnInput(root));
    expect(result.turnId).toBe('turn-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.filter((event) => event.type === 'complete')).toHaveLength(1);
    expect(events.find((event) => event.type === 'complete')?.text).toBe('안전한 응답');
  });

  it('reports a malformed completion as a protocol error', async () => {
    const { manager, root } = await createManager('malformed-completion');
    const errors: CodexEvent[] = [];
    manager.on('event', (event: CodexEvent) => {
      if (event.type === 'error') errors.push(event);
    });
    await manager.startTurn(turnInput(root));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(errors.map((event) => event.errorCode)).toContain('CODEX_PROTOCOL_ERROR');
  });

  it('maps an invalid output schema failure without exposing provider payloads', async () => {
    const { manager, root } = await createManager('turn-failed-schema');
    const failed = new Promise<CodexEvent>((resolve) => {
      manager.on('event', (event: CodexEvent) => {
        if (event.type === 'error') resolve(event);
      });
    });
    await manager.startTurn(turnInput(root));
    await expect(failed).resolves.toMatchObject({
      errorCode: 'CODEX_OUTPUT_SCHEMA_INVALID',
      message: '현재 앱의 AI 출력 형식이 Codex와 호환되지 않습니다. 앱을 업데이트해 주세요.',
    });
  });

  it('restarts a crashed generation and resumes after the single-flight reconnect', async () => {
    const { manager, root } = await createManager('crash-once');
    const crashed = new Promise<void>((resolve) => {
      manager.on('event', (event: CodexEvent) => {
        if (event.type === 'error' && event.errorCode === 'CODEX_PROCESS_CRASHED') resolve();
      });
    });
    await manager.startTurn(turnInput(root));
    await crashed;
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(manager.snapshot.state).toBe('ready');
    await manager.startTurn(turnInput(root, 'resumed'));
  });
});
