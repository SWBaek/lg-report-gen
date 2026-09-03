import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodexEvent } from '../../../shared/types/index.js';
import type { CodexTurnInput } from '../../../shared/contracts/api.js';

export function useAiTask() {
  const [running, setRunning] = useState(false);
  const [stream, setStream] = useState('');
  const [error, setError] = useState<string | null>(null);
  const taskRef = useRef<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const resolver = useRef<((value: string) => void) | null>(null);
  const rejecter = useRef<((reason: Error) => void) | null>(null);
  const streamRef = useRef('');
  const runningRef = useRef(false);
  const startingRef = useRef(false);
  const deferredEventsRef = useRef<CodexEvent[]>([]);
  const cleanup = useCallback(() => {
    resolver.current = null;
    rejecter.current = null;
    taskRef.current = null;
    sessionRef.current = null;
    runningRef.current = false;
  }, []);
  const handleEvent = useCallback(
    (event: CodexEvent) => {
      if (event.taskId !== taskRef.current) {
        if (startingRef.current && event.taskId && deferredEventsRef.current.length < 256)
          deferredEventsRef.current.push(event);
        return;
      }
      if (event.type === 'delta') {
        streamRef.current += event.text ?? '';
        setStream(streamRef.current);
      }
      if (event.type === 'complete') {
        if (event.text !== undefined) {
          streamRef.current = event.text;
          setStream(event.text);
        }
        setRunning(false);
        resolver.current?.(streamRef.current);
        cleanup();
      }
      if (event.type === 'error') {
        setRunning(false);
        const message = event.message ?? 'AI 작업에 실패했습니다.';
        setError(message);
        rejecter.current?.(new Error(message));
        cleanup();
      }
    },
    [cleanup],
  );
  useEffect(
    () =>
      window.lgReportAgent.codex.onEvent((event: CodexEvent) => {
        handleEvent(event);
      }),
    [handleEvent],
  );
  const run = async (input: CodexTurnInput): Promise<string> => {
    if (runningRef.current) throw new Error('AI 작업이 이미 실행 중입니다.');
    runningRef.current = true;
    startingRef.current = true;
    deferredEventsRef.current = [];
    setRunning(true);
    setStream('');
    streamRef.current = '';
    setError(null);
    try {
      const { taskId } = await window.lgReportAgent.codex.turn(input);
      taskRef.current = taskId;
      sessionRef.current = input.sessionId;
    } catch (reason) {
      startingRef.current = false;
      setRunning(false);
      const failure =
        reason instanceof Error ? reason : new Error('AI 작업을 시작하지 못했습니다.');
      setError(failure.message);
      cleanup();
      throw failure;
    }
    return new Promise<string>((resolve, reject) => {
      resolver.current = resolve;
      rejecter.current = reject;
      startingRef.current = false;
      const deferred = deferredEventsRef.current.splice(0);
      for (const event of deferred) handleEvent(event);
    });
  };
  const cancel = async () => {
    await window.lgReportAgent.codex.cancel({
      ...(taskRef.current ? { taskId: taskRef.current } : {}),
      ...(sessionRef.current ? { sessionId: sessionRef.current } : {}),
    });
  };
  return { running, stream, error, run, cancel, setStream };
}
