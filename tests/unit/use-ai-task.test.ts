// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApi } from '../../src/shared/contracts/api.js';
import type { CodexEvent } from '../../src/shared/types/index.js';
import { useAiTask } from '../../src/renderer/src/hooks/useAiTask.js';

const sessionId = 'a637dd41-1bec-4bfa-b05c-314a318c241d';
const taskId = 'e3d48860-a7a0-4bff-b5dc-e936ec01eaec';
const input = { intent: 'generate' as const, sessionId, prompt: '보고서 생성' };

describe('useAiTask', () => {
  let listener: (event: CodexEvent) => void;
  let turn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    turn = vi.fn();
    Object.defineProperty(window, 'lgReportAgent', {
      configurable: true,
      value: {
        codex: {
          turn,
          cancel: vi.fn(),
          onEvent: vi.fn((next: (event: CodexEvent) => void) => {
            listener = next;
            return vi.fn();
          }),
        },
      } as unknown as DesktopApi,
    });
  });

  it('replays a terminal event received before the turn IPC returns its task id', async () => {
    let resolveTurn!: (value: { taskId: string }) => void;
    turn.mockReturnValue(
      new Promise<{ taskId: string }>((resolve) => {
        resolveTurn = resolve;
      }),
    );
    const { result } = renderHook(() => useAiTask());
    let completion!: Promise<string>;
    await act(async () => {
      completion = result.current.run(input);
      listener({ type: 'complete', taskId, sessionId, text: '{"ok":true}' });
      resolveTurn({ taskId });
      await expect(completion).resolves.toBe('{"ok":true}');
    });
    expect(result.current.running).toBe(false);
  });

  it('leaves running state and surfaces the error when turn startup rejects', async () => {
    turn.mockRejectedValue(new Error('CODEX_BUSY'));
    const { result } = renderHook(() => useAiTask());
    await act(async () => {
      await expect(result.current.run(input)).rejects.toThrow('CODEX_BUSY');
    });
    expect(result.current.running).toBe(false);
    expect(result.current.error).toBe('CODEX_BUSY');
  });
});
