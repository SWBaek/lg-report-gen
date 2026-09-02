import { useEffect, useRef, useState } from 'react';
import type { CodexEvent } from '../../../shared/types';

export function useAiTask() {
  const [running, setRunning] = useState(false);
  const [stream, setStream] = useState('');
  const [error, setError] = useState<string | null>(null);
  const taskRef = useRef<string | null>(null);
  const resolver = useRef<((value: string) => void) | null>(null);
  const rejecter = useRef<((reason: Error) => void) | null>(null);
  const streamRef = useRef('');
  const cleanup = () => {
    resolver.current = null;
    rejecter.current = null;
    taskRef.current = null;
  };
  useEffect(
    () =>
      window.lgReportAgent.codex.onEvent((event: CodexEvent) => {
        if (event.taskId !== taskRef.current) return;
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
      }),
    [],
  );
  const run = async (input: unknown): Promise<string> => {
    if (running) throw new Error('AI 작업이 이미 실행 중입니다.');
    setRunning(true);
    setStream('');
    streamRef.current = '';
    setError(null);
    const { taskId } = await window.lgReportAgent.codex.turn(input);
    taskRef.current = taskId;
    return new Promise<string>((resolve, reject) => {
      resolver.current = resolve;
      rejecter.current = reject;
    });
  };
  const cancel = async () => {
    await window.lgReportAgent.codex.cancel();
  };
  return { running, stream, error, run, cancel, setStream };
}
