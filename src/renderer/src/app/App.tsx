import { Component, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { FileText } from 'lucide-react';
import type { BootstrapState, ChatSession, PublicReport } from '../../../shared/types';
import { Sidebar } from '../components/Sidebar';
import { ReportEditor } from '../features/reports/ReportEditor';
import { NewReportWizard } from '../features/reports/NewReportWizard';
import { ChatView } from '../features/chat/ChatView';
import { SettingsView } from '../features/settings/SettingsView';
import { ConfirmDialog } from '../components/ConfirmDialog';

type View = 'home' | 'report' | 'chat' | 'settings' | 'trash';
export function App() {
  return (
    <AppErrorBoundary>
      <AppContent />
    </AppErrorBoundary>
  );
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the error boundary deliberately quiet: report/source content must not be logged.
    void error;
    void info;
  }

  render() {
    if (this.state.error)
      return (
        <div className="empty" role="alert">
          <h2>화면을 표시하지 못했습니다.</h2>
          <p>일시적인 오류일 수 있습니다. 다시 시도해 주세요.</p>
          <button className="primary" onClick={() => this.setState({ error: null })}>
            다시 시도
          </button>
        </div>
      );
    return this.props.children;
  }
}

function AppContent() {
  const [state, setState] = useState<BootstrapState | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [view, setView] = useState<View>('home');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [report, setReport] = useState<PublicReport | null>(null);
  const [chat, setChat] = useState<ChatSession | null>(null);
  const [wizard, setWizard] = useState(false);
  const [prefill, setPrefill] = useState<string | undefined>();
  const [query, setQuery] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const reportRequestSeq = useRef(0);
  const reload = async () => {
    setBootstrapError(null);
    try {
      const next = await window.lgReportAgent.bootstrap.get();
      setState(next);
      return next;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '애플리케이션을 준비하지 못했습니다.';
      setBootstrapError(message);
      throw error;
    }
  };
  useEffect(() => {
    void reload().catch(() => undefined);
  }, []);
  useEffect(
    () =>
      window.lgReportAgent.codex.onEvent((event) => {
        if (event.type === 'state' && event.snapshot)
          setState((current) => (current ? { ...current, provider: event.snapshot! } : current));
      }),
    [],
  );
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        if (event.shiftKey) void newChat();
        else setWizard(true);
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('.search')?.focus();
      }
      if (event.key === 'Escape') {
        if (!wizard) setWizard(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [state, wizard]);
  const openReport = async (id: string) => {
    const request = ++reportRequestSeq.current;
    try {
      const next = await window.lgReportAgent.reports.get(id);
      if (request !== reportRequestSeq.current) return;
      setReport(next);
    } catch (error) {
      if (request === reportRequestSeq.current)
        setBootstrapError(error instanceof Error ? error.message : '보고서를 열지 못했습니다.');
      return;
    }
    if (request !== reportRequestSeq.current) return;
    setActiveId(id);
    setView('report');
  };
  const openChat = (id: string) => {
    ++reportRequestSeq.current;
    const target = state?.chats.find((item) => item.id === id);
    if (target) {
      setChat(target);
      setActiveId(id);
      setView('chat');
    }
  };
  const newChat = async () => {
    if (!state) return;
    ++reportRequestSeq.current;
    const created = await window.lgReportAgent.chats.create();
    await reload();
    setChat(created);
    setActiveId(created.id);
    setView('chat');
  };
  if (!state)
    return (
      <div className="empty" role={bootstrapError ? 'alert' : undefined}>
        <p>{bootstrapError ?? '애플리케이션을 준비하고 있습니다.'}</p>
        {bootstrapError && (
          <button className="primary" onClick={() => void reload().catch(() => undefined)}>
            다시 시도
          </button>
        )}
      </div>
    );
  if (!state.consentAccepted)
    return (
      <Consent
        onAccept={async () => {
          await window.lgReportAgent.bootstrap.acceptConsent();
          await reload();
        }}
      />
    );
  if (!state.workspacePath)
    return (
      <WorkspaceSetup
        onSelected={async () => {
          await reload();
        }}
      />
    );
  return (
    <div className="app">
      {bootstrapError && (
        <div className="error-box" role="alert">
          동기화에 실패했습니다. {bootstrapError}{' '}
          <button className="button" onClick={() => void reload().catch(() => undefined)}>
            다시 시도
          </button>
        </div>
      )}
      <Sidebar
        reports={state.reports}
        chats={state.chats}
        activeId={activeId}
        view={view}
        query={query}
        onQuery={setQuery}
        onReport={(id) => void openReport(id)}
        onChat={openChat}
        onNewReport={() => {
          ++reportRequestSeq.current;
          setPrefill(undefined);
          setWizard(true);
        }}
        onNewChat={() => {
          void newChat();
        }}
        onSettings={() => {
          ++reportRequestSeq.current;
          setActiveId(null);
          setView('settings');
        }}
        onTrash={() => {
          ++reportRequestSeq.current;
          setActiveId(null);
          setView('trash');
        }}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      {!sidebarOpen && (
        <button
          className="sidebar-open button icon"
          aria-label="탐색 메뉴 열기"
          onClick={() => setSidebarOpen(true)}
        >
          <span aria-hidden="true">☰</span>
        </button>
      )}
      <main className="main">
        {view === 'report' && report ? (
          <ReportEditor
            report={report}
            onRefresh={async () => {
              const next = await reload();
              const current = await window.lgReportAgent.reports.get(report.id);
              setReport(current);
              return void next;
            }}
            onChanged={(updated) => setReport(updated)}
            onRemoved={() => {
              setReport(null);
              setActiveId(null);
              setView('home');
            }}
          />
        ) : view === 'chat' && chat ? (
          <ChatView
            session={chat}
            reports={state.reports}
            provider={state.provider}
            onDeleted={async () => {
              await reload();
              setView('home');
              setActiveId(null);
            }}
            onConvert={(text) => {
              setPrefill(text);
              setWizard(true);
            }}
          />
        ) : view === 'settings' ? (
          <SettingsView state={state} onChanged={(next) => setState(next)} />
        ) : view === 'trash' ? (
          <TrashView onChanged={() => void reload()} />
        ) : (
          <Home
            onNew={() => {
              ++reportRequestSeq.current;
              setWizard(true);
            }}
          />
        )}
      </main>
      {wizard && (
        <NewReportWizard
          personas={state.personas}
          provider={state.provider}
          {...(prefill !== undefined ? { prefill } : {})}
          onClose={() => setWizard(false)}
          onCreated={async (created) => {
            setWizard(false);
            await reload();
            await openReport(created.id);
          }}
        />
      )}
    </div>
  );
}

function Consent({ onAccept }: { onAccept: () => void }) {
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <FileText size={40} />
        <h1>LG Report Agent</h1>
        <p>시작하기 전에 데이터 처리 경계를 확인하십시오.</p>
        <ul>
          <li>
            보고서 생성과 AI 대화에 입력한 내용은 사용자가 인증한 Codex 계정을 통해 처리될 수
            있습니다.
          </li>
          <li>데이터 처리 정책은 사용자의 Codex/ChatGPT Workspace 정책을 따릅니다.</li>
          <li>이 애플리케이션은 별도의 API Key를 저장하지 않습니다.</li>
          <li>보고서와 애플리케이션 데이터는 사용자가 선택한 로컬 Workspace에 저장됩니다.</li>
        </ul>
        <button className="primary" onClick={onAccept}>
          확인하고 계속
        </button>
      </div>
    </div>
  );
}
function WorkspaceSetup({ onSelected }: { onSelected: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <h1>Workspace 선택</h1>
        <p>보고서, 첨부 자료, 대화, 버전 및 DB를 저장할 로컬 폴더를 선택하거나 새로 만드십시오.</p>
        <p className="muted">
          애플리케이션 설치 폴더나 Portable EXE 위치는 자동으로 데이터 저장소로 사용하지 않습니다.
        </p>
        {error && <div className="error-box">{error}</div>}
        <button
          className="primary"
          onClick={async () => {
            try {
              const path = await window.lgReportAgent.workspace.choose();
              if (path) onSelected();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Workspace를 사용할 수 없습니다.');
            }
          }}
        >
          Workspace 선택 또는 생성
        </button>
      </div>
    </div>
  );
}
function Home({ onNew }: { onNew: () => void }) {
  return (
    <div className="empty">
      <FileText size={48} />
      <h2>보고서를 선택하거나 새로 만드세요</h2>
      <p>문서를 첨부하고 목적과 독자를 지정하면 Codex가 작성 계획과 본문을 생성합니다.</p>
      <button className="primary" onClick={onNew}>
        새 보고서
      </button>
    </div>
  );
}
function TrashView({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof window.lgReportAgent.reports.list>>>(
    [],
  );
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  useEffect(() => {
    void window.lgReportAgent.reports.list({ includeDeleted: true }).then(setItems);
  }, []);
  return (
    <div className="settings">
      <h1>휴지통</h1>
      {deleteNotice && (
        <div className="notice" role="status">
          {deleteNotice}
        </div>
      )}
      {items.length === 0 ? (
        <div className="empty">
          <h2>휴지통이 비었습니다.</h2>
        </div>
      ) : (
        items.map((item) => (
          <div className="settings-section" key={item.id}>
            <strong>{item.title}</strong>
            <p className="muted">
              삭제: {item.deletedAt ? new Date(item.deletedAt).toLocaleString() : '-'}
            </p>
            <button
              className="button"
              onClick={async () => {
                await window.lgReportAgent.reports.restore(item.id);
                setItems(items.filter((v) => v.id !== item.id));
                onChanged();
              }}
            >
              복원
            </button>
            <button className="button danger" onClick={() => setPendingDelete(item.id)}>
              영구 삭제
            </button>
          </div>
        ))
      )}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="보고서 영구 삭제"
        description="영구 삭제하면 보고서 파일과 로컬 기록을 복구할 수 없습니다. 계속하시겠습니까?"
        confirmLabel="영구 삭제"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (!pendingDelete) return;
          const result = await window.lgReportAgent.reports.delete(pendingDelete);
          setItems((current) => current.filter((v) => v.id !== pendingDelete));
          setPendingDelete(null);
          onChanged();
          if (result.threadDeleteFailed) {
            setDeleteNotice('로컬 보고서는 삭제했지만 Codex Thread 삭제에는 실패했습니다.');
          }
        }}
      />
    </div>
  );
}
