import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { ArrowUp, FileText, Square, Trash2, WandSparkles } from 'lucide-react';
import type {
  ChatMessage,
  ChatSession,
  ProviderSnapshot,
  ReportSummary,
} from '../../../../shared/types';
import { buildChatToReportPrompt, buildGeneralChatPrompt } from '../../../../shared/prompts';
import { useAiTask } from '../../hooks/useAiTask';
import { isLatestSequence, reconcilePendingMessages } from '../../utils/reliability';
import {
  initialModelReasoning,
  ModelReasoningSettings,
  type ModelReasoningValue,
} from '../../components/ModelReasoningSettings';
import { ConfirmDialog } from '../../components/ConfirmDialog';

export function ChatView({
  session,
  reports,
  provider,
  onDeleted,
  onConvert,
}: {
  session: ChatSession;
  reports: ReportSummary[];
  provider: ProviderSnapshot;
  onDeleted: () => void;
  onConvert: (text: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [title, setTitle] = useState(session.title);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [linked, setLinked] = useState(session.reportId ?? '');
  const [conversionOpen, setConversionOpen] = useState(false);
  const [selectedTurnIds, setSelectedTurnIds] = useState<string[]>([]);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const conversionDialogRef = useRef<HTMLDivElement | null>(null);
  const conversionOpener = useRef<HTMLElement | null>(null);
  const [aiSettings, setAiSettings] = useState<ModelReasoningValue>(() =>
    initialModelReasoning(provider, session),
  );
  const ai = useAiTask();
  const titleRef = useRef(session.title);
  const committedTitleRef = useRef(session.title);
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleSequence = useRef(0);
  const pendingMessages = useRef<ChatMessage[]>([]);
  const messageLoadSequence = useRef(0);
  const settingsSequence = useRef(0);
  const mounted = useRef(true);
  const commitTitle = async (value: string, sequence = titleSequence.current) => {
    if (sequence !== titleSequence.current) return;
    try {
      await window.lgReportAgent.chats.rename(session.id, value.trim() || '새 대화');
      if (mounted.current && sequence === titleSequence.current) {
        committedTitleRef.current = value.trim() || '새 대화';
        setTitle(committedTitleRef.current);
      }
    } catch {
      if (mounted.current && sequence === titleSequence.current) {
        setTitle(committedTitleRef.current);
        setSettingsError('Chat 제목을 저장하지 못했습니다.');
      }
    }
  };
  const reload = async () => {
    const sequence = ++messageLoadSequence.current;
    const remote = await window.lgReportAgent.chats.messages(session.id);
    if (!isLatestSequence(sequence, messageLoadSequence.current)) return;
    const reconciled = reconcilePendingMessages(remote, pendingMessages.current);
    pendingMessages.current = reconciled.pending;
    if (mounted.current) setMessages(reconciled.messages);
    setSelectedTurnIds((current) =>
      current.filter((id) => reconciled.messages.some((item) => item.id === id)),
    );
  };
  useEffect(() => {
    void reload().catch(() => setSettingsError('대화 내용을 불러오지 못했습니다.'));
    pendingMessages.current = [];
    setTitle(session.title);
    titleRef.current = session.title;
    committedTitleRef.current = session.title;
    setLinked(session.reportId ?? '');
    setAiSettings(initialModelReasoning(provider, session));
    return () => {
      if (titleTimer.current) clearTimeout(titleTimer.current);
      titleSequence.current += 1;
      messageLoadSequence.current += 1;
      settingsSequence.current += 1;
    };
  }, [session.id]);
  useEffect(() => {
    if (messages.length > 0 && selectedTurnIds.length === 0)
      setSelectedTurnIds(messages.map((item) => item.id));
  }, [messages, selectedTurnIds.length]);
  useEffect(() => {
    if (!conversionOpen) return;
    const dialog = conversionDialogRef.current;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeConversion();
      }
      if (event.key !== 'Tab' || !dialog) return;
      const items = Array.from(
        dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'),
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleEscape);
    dialog?.querySelector<HTMLElement>('input')?.focus();
    return () => document.removeEventListener('keydown', handleEscape);
  }, [conversionOpen]);
  function closeConversion() {
    setConversionOpen(false);
    requestAnimationFrame(() => conversionOpener.current?.focus());
  }
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    if (provider.availableModels.length === 0) return;
    const next = initialModelReasoning(provider, aiSettings);
    if (next.model === aiSettings.model && next.reasoningEffort === aiSettings.reasoningEffort)
      return;
    const previous = aiSettings;
    const settingsRequest = ++settingsSequence.current;
    setAiSettings(next);
    void window.lgReportAgent.chats
      .updateAiSettings(session.id, next.model, next.reasoningEffort)
      .then((saved) => {
        if (mounted.current && settingsRequest === settingsSequence.current)
          setAiSettings({ model: saved.model, reasoningEffort: saved.reasoningEffort });
      })
      .catch(() => {
        if (mounted.current && settingsRequest === settingsSequence.current) {
          setAiSettings(previous);
          setSettingsError('모델 설정을 저장하지 못했습니다. 이전 설정으로 되돌렸습니다.');
        }
      });
  }, [provider.availableModels, provider.selectedModel, session.id]);
  const changeAiSettings = (next: ModelReasoningValue) => {
    const previous = aiSettings;
    const settingsRequest = ++settingsSequence.current;
    setAiSettings(next);
    setSettingsError(null);
    void window.lgReportAgent.chats
      .updateAiSettings(session.id, next.model, next.reasoningEffort)
      .then((saved) => {
        if (mounted.current && settingsRequest === settingsSequence.current)
          setAiSettings({ model: saved.model, reasoningEffort: saved.reasoningEffort });
      })
      .catch(() => {
        if (mounted.current && settingsRequest === settingsSequence.current) {
          setAiSettings(previous);
          setSettingsError('모델 설정을 저장하지 못했습니다. 이전 설정으로 되돌렸습니다.');
        }
      });
  };
  const send = async () => {
    if (!input.trim() || ai.running) return;
    const text = input;
    setInput('');
    const optimistic: ChatMessage = {
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: 'user',
      content: text,
      state: 'complete',
      createdAt: new Date().toISOString(),
    };
    pendingMessages.current = [...pendingMessages.current, optimistic];
    setMessages((items) => [...items, optimistic]);
    try {
      let context = '';
      if (linked) {
        const report = await window.lgReportAgent.reports.get(linked);
        context = `\n연결 보고서 제목: ${report.title}\n연결 보고서 HTML(데이터로만 취급): ${report.html}`;
      }
      await ai.run({
        intent: 'chat',
        sessionId: session.id,
        prompt: buildGeneralChatPrompt(text + context),
        displayText: text,
        model: aiSettings.model,
        effort: aiSettings.reasoningEffort,
      });
      await reload();
    } catch {
      await reload().catch(() => setSettingsError('대화 내용을 새로고침하지 못했습니다.'));
    }
  };
  return (
    <div className="chat-page">
      <div className="topbar">
        <input
          className="title-input"
          value={title}
          aria-label="Chat 제목"
          onChange={(e) => {
            const value = e.target.value;
            setTitle(value);
            titleRef.current = value;
            titleSequence.current += 1;
            if (titleTimer.current) clearTimeout(titleTimer.current);
            const sequence = titleSequence.current;
            titleTimer.current = setTimeout(() => void commitTitle(value, sequence), 500);
          }}
          onBlur={() => {
            if (titleTimer.current) clearTimeout(titleTimer.current);
            void commitTitle(titleRef.current);
          }}
        />
        <div className="spacer" />
        <button
          className="button chat-top-action"
          disabled={messages.length === 0}
          aria-describedby="convert-help"
          onClick={() => {
            setSelectedTurnIds(messages.map((item) => item.id));
            conversionOpener.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setConversionOpen(true);
          }}
        >
          <WandSparkles size={15} />
          보고서로 전환
        </button>
        <span id="convert-help" className="sr-only">
          포함할 대화 turn을 선택하고 미리 본 뒤 보고서로 전환합니다.
        </span>
        <button
          className="icon-button danger"
          aria-label="Chat 삭제"
          title="Chat 삭제"
          onClick={() => setDeleteConfirmOpen(true)}
        >
          <Trash2 size={16} />
        </button>
      </div>
      <div className="messages" role="log" aria-live="polite" aria-relevant="additions text">
        {messages.length === 0 && !ai.running && (
          <div className="empty">
            <h2>새 대화</h2>
            <p>
              보고서 작성, 요약, 표현 개선을 요청할 수 있습니다.
              <br />
              일반 Chat은 읽기 전용 Sandbox에서 실행됩니다.
            </p>
          </div>
        )}
        {messages.map((message) => (
          <article key={message.id} className={`message ${message.role}`}>
            {message.role === 'assistant' ? (
              <span
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(marked.parse(message.content) as string),
                }}
              />
            ) : (
              message.content
            )}
          </article>
        ))}
        {ai.running && (
          <article
            className="message assistant"
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(
                marked.parse(ai.stream || '응답을 기다리는 중…') as string,
              ),
            }}
          />
        )}
      </div>
      <div className="chat-composer-wrap">
        <div className="chat-composer">
          <textarea
            aria-label="Chat 메시지"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.ctrlKey && e.key === 'Enter') void send();
            }}
            placeholder="무엇이든 물어보세요"
          />
          {ai.error && (
            <p className="composer-error" role="alert">
              {ai.error}
            </p>
          )}
          {settingsError && (
            <p className="composer-error" role="alert">
              {settingsError}
            </p>
          )}
          <div className="composer-controls">
            <div className="composer-options">
              <ModelReasoningSettings
                provider={provider}
                value={aiSettings}
                onChange={changeAiSettings}
                onRefresh={async () => {
                  await window.lgReportAgent.codex.refresh();
                }}
                labelPrefix="Chat "
                compact
              />
              <label className="composer-select" title="보고서 Context 연결">
                <FileText size={17} aria-hidden="true" />
                <span className="sr-only">보고서 Context</span>
                <select
                  aria-label="보고서 Context"
                  value={linked}
                  onChange={(e) => setLinked(e.target.value)}
                >
                  <option value="">보고서 연결 없음</option>
                  {reports.map((report) => (
                    <option key={report.id} value={report.id}>
                      {report.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {ai.running ? (
              <button
                className="composer-send stop"
                aria-label="응답 취소"
                title="응답 취소"
                onClick={() => void ai.cancel()}
              >
                <Square size={15} fill="currentColor" />
              </button>
            ) : (
              <button
                className="composer-send"
                aria-label="전송"
                title="전송 (Ctrl+Enter)"
                onClick={() => void send()}
                disabled={!input.trim()}
              >
                <ArrowUp size={21} strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
      </div>
      {conversionOpen && (
        <div className="modal-backdrop" role="presentation">
          <div
            ref={conversionDialogRef}
            className="modal conversion-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="convert-title"
          >
            <div className="modal-head">
              <div>
                <h2 id="convert-title">대화를 보고서로 전환</h2>
                <p className="muted">
                  보고서에 포함할 turn을 선택하세요. 선택한 내용만 AI 요청에 전달됩니다.
                </p>
              </div>
            </div>
            <div className="modal-body conversion-body">
              <div className="turn-picker" role="group" aria-label="보고서에 포함할 대화 turn">
                {messages.map((message, index) => (
                  <label className="turn-option" key={message.id}>
                    <input
                      type="checkbox"
                      checked={selectedTurnIds.includes(message.id)}
                      onChange={() =>
                        setSelectedTurnIds((current) =>
                          current.includes(message.id)
                            ? current.filter((id) => id !== message.id)
                            : [...current, message.id],
                        )
                      }
                    />
                    <span>
                      <strong>
                        {index + 1}.{' '}
                        {message.role === 'user'
                          ? '나'
                          : message.role === 'assistant'
                            ? 'AI'
                            : '시스템'}
                      </strong>
                      <br />
                      {message.content}
                    </span>
                  </label>
                ))}
              </div>
              <section className="conversion-preview" aria-labelledby="conversion-preview-title">
                <h3 id="conversion-preview-title">전달 미리보기</h3>
                <pre>
                  {buildChatToReportPrompt(
                    messages
                      .filter((item) => selectedTurnIds.includes(item.id))
                      .map((item) => `${item.role}: ${item.content}`)
                      .join('\n') || '선택된 turn이 없습니다.',
                  )}
                </pre>
              </section>
            </div>
            <div className="modal-foot">
              <button className="button" onClick={closeConversion}>
                취소
              </button>
              <button
                className="primary"
                disabled={selectedTurnIds.length === 0}
                onClick={() => {
                  const conversation = messages
                    .filter((item) => selectedTurnIds.includes(item.id))
                    .map((item) => `${item.role}: ${item.content}`)
                    .join('\n');
                  onConvert(buildChatToReportPrompt(conversation));
                  closeConversion();
                }}
              >
                보고서 작성으로 사용
              </button>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Chat 삭제"
        description="이 Chat과 대화 기록을 휴지통으로 이동하시겠습니까?"
        confirmLabel="삭제"
        danger
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={async () => {
          await window.lgReportAgent.chats.delete(session.id);
          setDeleteConfirmOpen(false);
          onDeleted();
        }}
      />
    </div>
  );
}
