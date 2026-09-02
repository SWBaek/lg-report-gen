import { FilePlus2, FileText, MessageSquarePlus, Settings, Star, Trash2 } from 'lucide-react';
import type { ChatSession, ReportSummary } from '../../../shared/types';

interface Props {
  reports: ReportSummary[];
  chats: ChatSession[];
  activeId: string | null;
  view: string;
  query: string;
  onQuery: (value: string) => void;
  onReport: (id: string) => void;
  onChat: (id: string) => void;
  onNewReport: () => void;
  onNewChat: () => void;
  onSettings: () => void;
  onTrash: () => void;
}
export function Sidebar(props: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <FileText size={22} />
        LG Report Agent
      </div>
      <button className="primary" onClick={props.onNewReport}>
        <FilePlus2 size={17} />새 보고서
      </button>
      <input
        className="search"
        aria-label="보고서와 대화 검색"
        placeholder="검색 (Ctrl+K)"
        value={props.query}
        onChange={(e) => props.onQuery(e.target.value)}
      />
      <section className="nav-section">
        <div className="nav-title">보고서</div>
        <div className="nav-list">
          {props.reports
            .filter((r) =>
              `${r.title} ${r.purpose}`.toLowerCase().includes(props.query.toLowerCase()),
            )
            .map((report) => (
              <button
                key={report.id}
                className={`nav-item ${props.activeId === report.id ? 'active' : ''}`}
                onClick={() => props.onReport(report.id)}
              >
                <FileText size={15} />
                <span>{report.title}</span>
                {report.isFavorite && <Star className="star" size={13} fill="currentColor" />}
              </button>
            ))}
        </div>
      </section>
      <section className="nav-section">
        <div className="nav-title">
          Chat
          <button className="button icon" aria-label="새 Chat" onClick={props.onNewChat}>
            <MessageSquarePlus size={15} />
          </button>
        </div>
        <div className="nav-list">
          {props.chats
            .filter((c) => c.title.toLowerCase().includes(props.query.toLowerCase()))
            .map((chat) => (
              <button
                key={chat.id}
                className={`nav-item ${props.activeId === chat.id ? 'active' : ''}`}
                onClick={() => props.onChat(chat.id)}
              >
                <span>
                  #{chat.kind === 'report' ? '보고서 AI' : '대화'} · {chat.title}
                </span>
              </button>
            ))}
        </div>
      </section>
      <div className="sidebar-bottom">
        <button
          className={`nav-item ${props.view === 'trash' ? 'active' : ''}`}
          onClick={props.onTrash}
        >
          <Trash2 size={16} />
          <span>휴지통</span>
        </button>
        <button
          className={`nav-item ${props.view === 'settings' ? 'active' : ''}`}
          onClick={props.onSettings}
        >
          <Settings size={16} />
          <span>설정</span>
        </button>
      </div>
    </aside>
  );
}
