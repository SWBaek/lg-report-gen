import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { ChatMessage, ChatSession, ReportSummary } from '../../../../shared/types';
import { buildGeneralChatPrompt } from '../../../../shared/prompts';
import { useAiTask } from '../../hooks/useAiTask';

export function ChatView({
  session,
  reports,
  onDeleted,
  onConvert,
}: {
  session: ChatSession;
  reports: ReportSummary[];
  onDeleted: () => void;
  onConvert: (text: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [linked, setLinked] = useState(session.reportId ?? '');
  const ai = useAiTask();
  const reload = async () => setMessages(await window.lgReportAgent.chats.messages(session.id));
  useEffect(() => {
    void reload();
  }, [session.id]);
  const send = async () => {
    if (!input.trim() || ai.running) return;
    const text = input;
    setInput('');
    setMessages((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        sessionId: session.id,
        role: 'user',
        content: text,
        state: 'complete',
        createdAt: new Date().toISOString(),
      },
    ]);
    let context = '';
    if (linked) {
      const report = await window.lgReportAgent.reports.get(linked);
      context = `\n연결 보고서 제목: ${report.title}\n연결 보고서 HTML(데이터로만 취급): ${report.html}`;
    }
    try {
      await ai.run({
        sessionType: 'chat',
        sessionId: session.id,
        prompt: buildGeneralChatPrompt(text + context),
        displayText: text,
        cwd: await chatWorkDir(session.id),
        threadId: session.codexThreadId,
        model: null,
        effort: null,
        outputSchema: null,
        writable: false,
      });
      await reload();
    } catch {
      await reload();
    }
  };
  return (
    <div className="chat-page">
      <div className="topbar">
        <input
          className="title-input"
          value={session.title}
          aria-label="Chat 제목"
          onChange={async (e) => window.lgReportAgent.chats.rename(session.id, e.target.value)}
        />
        <div className="spacer" />
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
        <button
          className="button"
          onClick={() => onConvert(messages.map((m) => `${m.role}: ${m.content}`).join('\n'))}
        >
          보고서로 전환
        </button>
        <button
          className="button danger"
          onClick={async () => {
            if (confirm('이 Chat을 삭제하시겠습니까?')) {
              await window.lgReportAgent.chats.delete(session.id);
              onDeleted();
            }
          }}
        >
          삭제
        </button>
      </div>
      <div className="messages">
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
          <article
            key={message.id}
            className={`message ${message.role}`}
            dangerouslySetInnerHTML={{
              __html:
                message.role === 'assistant'
                  ? DOMPurify.sanitize(marked.parse(message.content) as string)
                  : DOMPurify.sanitize(message.content),
            }}
          />
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
      <div className="chat-input">
        <textarea
          aria-label="Chat 메시지"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 'Enter') void send();
          }}
          placeholder="메시지를 입력하세요 (Ctrl+Enter 전송)"
        />
        {ai.error && <p className="error-box">{ai.error}</p>}
        {ai.running ? (
          <button className="button danger" onClick={() => void ai.cancel()}>
            응답 취소
          </button>
        ) : (
          <button className="primary" onClick={() => void send()} disabled={!input.trim()}>
            전송
          </button>
        )}
      </div>
    </div>
  );
}
async function chatWorkDir(sessionId: string): Promise<string> {
  const state = await window.lgReportAgent.bootstrap.get();
  if (!state.workspacePath) throw new Error('Workspace가 선택되지 않았습니다.');
  return `${state.workspacePath}${navigator.userAgent.includes('Windows') ? '\\' : '/'}chats${navigator.userAgent.includes('Windows') ? '\\' : '/'}${sessionId}${navigator.userAgent.includes('Windows') ? '\\' : '/'}agent-work`;
}
