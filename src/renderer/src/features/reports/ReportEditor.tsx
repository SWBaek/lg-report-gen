import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import DOMPurify from 'dompurify';
import { diffWords } from 'diff';
import type { z } from 'zod';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Bot,
  Download,
  FileClock,
  ImagePlus,
  Italic,
  List,
  ListOrdered,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Copy,
  Paperclip,
  Printer,
  Quote,
  Redo2,
  Save,
  Star,
  Table2,
  Trash2,
  UnderlineIcon,
  Undo2,
} from 'lucide-react';
import type {
  ChatMessage,
  ChatSession,
  PublicReport,
  PublicRevision,
} from '../../../../shared/types';
import { buildReportRevisionPrompt } from '../../../../shared/prompts';
import {
  planningOutputSchema,
  reportOutputSchema,
  revisionOutputSchema,
} from '../../../../shared/schemas';
import { parseStructuredOutput } from '../../../../shared/schemas/structured-output';
import { useAiTask } from '../../hooks/useAiTask';

interface Props {
  report: PublicReport;
  onRefresh: () => Promise<void>;
  onChanged: (report: PublicReport) => void;
  onRemoved: () => void;
}
interface Proposal {
  html: string;
  summary: string[];
  assumptions: string[];
  warnings: string[];
  baseHash: string;
}
export function ReportEditor({ report, onRefresh, onChanged, onRemoved }: Props) {
  const [title, setTitle] = useState(report.title);
  const [layout, setLayout] = useState(report.layoutMode);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'failed'>('saved');
  const [aiOpen, setAiOpen] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [prompt, setPrompt] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [revisions, setRevisions] = useState<PublicRevision[]>([]);
  const [syncConflict, setSyncConflict] = useState(false);
  const syncConflictRef = useRef(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const editorRef = useRef<NonNullable<ReturnType<typeof useEditor>> | null>(null);
  const titleRef = useRef(title);
  const layoutRef = useRef(layout);
  const reportIdRef = useRef(report.id);
  const lastSyncedHtmlRef = useRef(DOMPurify.sanitize(report.html));
  const lastSyncedHashRef = useRef<string | null>(null);
  const lastSyncedVersionRef = useRef(`${report.updatedAt}:${report.currentRevisionId ?? ''}`);
  const syncGeneration = useRef(0);
  const saveSequence = useRef(0);
  const changeSequence = useRef(0);
  const chatLoadSequence = useRef(0);
  const reportGeneration = useRef(0);
  const onChangedRef = useRef(onChanged);
  const saveRef = useRef<() => Promise<PublicReport | undefined>>(async () => undefined);
  const exportRef = useRef<() => Promise<void>>(async () => undefined);
  const ai = useAiTask();
  useEffect(() => {
    titleRef.current = title;
  }, [title]);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);
  useEffect(() => {
    const sequence = ++chatLoadSequence.current;
    void window.lgReportAgent.chats
      .list()
      .then(async (chats) => {
        const existing = chats.find(
          (item) => item.kind === 'report' && item.reportId === report.id,
        );
        if (!existing) {
          if (sequence === chatLoadSequence.current) {
            setSession(null);
            setMessages([]);
          }
          return;
        }
        const nextMessages = await window.lgReportAgent.chats.messages(existing.id);
        if (sequence !== chatLoadSequence.current) return;
        setSession(existing);
        setMessages(nextMessages);
      })
      .catch(() => {
        if (sequence === chatLoadSequence.current) setSession(null);
      });
    return () => {
      chatLoadSequence.current += 1;
    };
  }, [report.id]);
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Image.configure({ allowBase64: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: DOMPurify.sanitize(report.html),
    editorProps: { attributes: { 'aria-label': '보고서 편집기' } },
    onUpdate: () => {
      dirty.current = true;
      changeSequence.current += 1;
      if (syncConflictRef.current) return;
      setSaveState('saving');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void saveRef.current(), 700);
    },
  });
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);
  const save = useCallback(async (): Promise<PublicReport | undefined> => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return undefined;
    const requestSequence = ++saveSequence.current;
    const requestChangeSequence = changeSequence.current;
    const reportId = reportIdRef.current;
    const html = DOMPurify.sanitize(currentEditor.getHTML());
    const payload = {
      id: reportId,
      title: titleRef.current.trim() || '제목 없는 보고서',
      html,
      editorJson: currentEditor.getJSON(),
      layoutMode: layoutRef.current,
    };
    if (mounted.current) setSaveState('saving');
    try {
      const updated = await window.lgReportAgent.reports.save(payload);
      // A slower response must never overwrite the result of a newer save.
      if (
        !mounted.current ||
        requestSequence !== saveSequence.current ||
        reportIdRef.current !== reportId
      )
        return updated;
      lastSyncedHtmlRef.current = html;
      lastSyncedHashRef.current = await hash(html);
      lastSyncedVersionRef.current = `${updated.updatedAt}:${updated.currentRevisionId ?? ''}`;
      if (requestChangeSequence === changeSequence.current) {
        dirty.current = false;
        syncConflictRef.current = false;
        setSyncConflict(false);
      }
      setSaveState('saved');
      onChangedRef.current(updated);
      return updated;
    } catch {
      if (mounted.current && requestSequence === saveSequence.current) setSaveState('failed');
      return undefined;
    }
  }, []);
  saveRef.current = save;
  useEffect(() => {
    if (reportIdRef.current !== report.id) reportGeneration.current += 1;
    const incomingHtml = DOMPurify.sanitize(report.html);
    const incomingVersion = `${report.updatedAt}:${report.currentRevisionId ?? ''}`;
    const idChanged = reportIdRef.current !== report.id;
    const generation = ++syncGeneration.current;
    void hash(incomingHtml).then((incomingHash) => {
      if (!mounted.current || generation !== syncGeneration.current) return;
      const versionChanged = incomingVersion !== lastSyncedVersionRef.current;
      const contentChanged =
        versionChanged ||
        incomingHash !== lastSyncedHashRef.current ||
        incomingHtml !== lastSyncedHtmlRef.current;
      if (contentChanged && dirty.current && !idChanged) {
        syncConflictRef.current = true;
        setSyncConflict(true);
        return;
      }
      if (idChanged && dirty.current) {
        if (timer.current) clearTimeout(timer.current);
        // Capture the previous report before switching the editor to the new one.
        void saveRef.current();
      }
      reportIdRef.current = report.id;
      setTitle(report.title);
      setLayout(report.layoutMode);
      titleRef.current = report.title;
      layoutRef.current = report.layoutMode;
      if (contentChanged || idChanged) {
        editorRef.current?.commands.setContent(incomingHtml, { emitUpdate: false });
        dirty.current = false;
        changeSequence.current += 1;
      }
      lastSyncedHtmlRef.current = incomingHtml;
      lastSyncedHashRef.current = incomingHash;
      lastSyncedVersionRef.current = incomingVersion;
      syncConflictRef.current = false;
      setSyncConflict(false);
    });
  }, [report, editor]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveRef.current();
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        void exportRef.current();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      // Flush the latest editor/title/layout refs even while React is unmounting.
      if (dirty.current) void saveRef.current();
    };
  }, []);
  const ensureSession = async (): Promise<ChatSession> => {
    if (session) return session;
    const created = await window.lgReportAgent.chats.create(`${title} AI 수정`, report.id);
    setSession(created);
    return created;
  };
  const requestRevision = async (request = prompt) => {
    if (!editor || !request.trim() || ai.running) return;
    const targetGeneration = reportGeneration.current;
    const current = DOMPurify.sanitize(editor.getHTML());
    const baseHash = await hash(current);
    const sources = await window.lgReportAgent.sources.list(report.id);
    const chat = await ensureSession();
    setMessages((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        sessionId: chat.id,
        role: 'user',
        content: request,
        state: 'complete',
        createdAt: new Date().toISOString(),
      },
    ]);
    setPrompt('');
    try {
      const raw = await ai.run({
        intent: 'revise',
        sessionId: chat.id,
        prompt: buildReportRevisionPrompt({
          request,
          persona: report.personaConfig,
          html: current,
          baseHash,
          sources: JSON.stringify(
            sources.map((source) => ({
              id: source.sourceId,
              name: source.originalName,
              snapshot: source.metadata,
              sha256: source.sha256,
            })),
          ),
        }),
        displayText: request,
        model: report.outputOptions.model,
        effort: report.outputOptions.reasoningEffort,
      });
      const parsed = parseStructuredOutput(raw, revisionOutputSchema);
      if (targetGeneration !== reportGeneration.current) return;
      const html = DOMPurify.sanitize(parsed.updatedHtml, {
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
        FORBID_ATTR: ['style'],
      });
      const summaries = parsed.changeSummary;
      setProposal({
        html,
        summary: summaries,
        assumptions: parsed.assumptions,
        warnings: parsed.warnings,
        baseHash,
      });
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          sessionId: chat.id,
          role: 'assistant',
          content: summaries.join('\n'),
          state: 'complete',
          createdAt: new Date().toISOString(),
        },
      ]);
    } catch (error) {
      if (targetGeneration !== reportGeneration.current) return;
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          sessionId: chat.id,
          role: 'assistant',
          content: error instanceof Error ? error.message : 'AI 수정에 실패했습니다.',
          state: 'failed',
          createdAt: new Date().toISOString(),
        },
      ]);
    }
  };
  const applyProposal = async () => {
    if (!proposal || !editor) return;
    const current = DOMPurify.sanitize(editor.getHTML());
    if ((await hash(current)) !== proposal.baseHash) {
      alert('AI 작업 중 보고서가 변경되어 자동 적용할 수 없습니다. 다시 생성하십시오.');
      return;
    }
    await window.lgReportAgent.revisions.create(report.id, 'before-ai', 'AI 수정 적용 이전');
    editor.commands.setContent(proposal.html);
    await save();
    await window.lgReportAgent.revisions.create(report.id, 'after-ai', 'AI 수정 적용 후');
    setProposal(null);
    await onRefresh();
  };
  const restoreRevision = async (revisionId: string) => {
    const targetReportId = report.id;
    const targetGeneration = reportGeneration.current;
    if (dirty.current) {
      const proceed = confirm(
        '저장되지 않은 편집 내용이 있습니다. 현재 내용을 버리고 복원하시겠습니까?',
      );
      if (!proceed) return;
    }
    const restored = await window.lgReportAgent.revisions.restore(report.id, revisionId);
    if (targetGeneration !== reportGeneration.current || reportIdRef.current !== targetReportId)
      return;
    const restoredHtml = DOMPurify.sanitize(restored.html);
    editor?.commands.setContent(restoredHtml, { emitUpdate: false });
    dirty.current = false;
    changeSequence.current += 1;
    lastSyncedHtmlRef.current = restoredHtml;
    lastSyncedHashRef.current = await hash(restoredHtml);
    lastSyncedVersionRef.current = `${restored.updatedAt}:${restored.currentRevisionId ?? ''}`;
    setSyncConflict(false);
    syncConflictRef.current = false;
    setSaveState('saved');
    onChanged(restored);
    setRevisions([]);
  };
  const exportReport = async (format: 'html' | 'pdf') => {
    await save();
    const preflight = await window.lgReportAgent.reports.exportPreflight(report.id, format);
    if (preflight.warnings.length > 0) {
      const details = preflight.warnings.map((warning) => `· ${warning.message}`).join('\n');
      if (!confirm(`내보내기 전 확인이 필요합니다.\n${details}\n\n계속하시겠습니까?`)) return;
    }
    const target = await window.lgReportAgent.reports.export(
      report.id,
      format,
      preflight.reservationToken,
    );
    if (target) alert(`${format.toUpperCase()}을 내보냈습니다.\n${target}`);
  };
  const exportHtml = () => exportReport('html');
  exportRef.current = exportHtml;
  const addImage = async () => {
    const selections = await window.lgReportAgent.sources.choose();
    if (!selections[0]) return;
    const entries = await window.lgReportAgent.sources.import(report.id, [
      selections[0].selectionId,
    ]);
    const src = entries[0]?.metadata.editorSrc;
    if (typeof src === 'string')
      editor
        ?.chain()
        .focus()
        .setImage({ src, alt: entries[0]?.originalName ?? '이미지' })
        .run();
  };
  if (!editor) return <div className="empty">편집기를 준비하고 있습니다.</div>;
  return (
    <div className="main">
      <div className="content">
        <div className="topbar">
          <input
            className="title-input"
            aria-label="보고서 제목"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              titleRef.current = e.target.value;
              dirty.current = true;
              changeSequence.current += 1;
              setSaveState('saving');
            }}
            onBlur={() => void saveRef.current()}
          />
          <button
            className="button icon"
            aria-label="즐겨찾기"
            onClick={async () => {
              await window.lgReportAgent.reports.favorite(report.id, !report.isFavorite);
              await onRefresh();
            }}
          >
            <Star size={17} fill={report.isFavorite ? 'currentColor' : 'none'} />
          </button>
          <span
            className={`status ${saveState === 'failed' ? 'error' : ''}`}
            role="status"
            aria-live="polite"
          >
            {saveState === 'saved' ? '저장됨' : saveState === 'saving' ? '저장 중…' : '저장 실패'}
          </span>
          <div className="spacer" />
          <button
            className="button"
            onClick={() => {
              const nextLayout = layout === 'a4' ? 'web' : 'a4';
              setLayout(nextLayout);
              layoutRef.current = nextLayout;
              dirty.current = true;
              changeSequence.current += 1;
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => void saveRef.current(), 700);
            }}
          >
            {layout === 'a4' ? 'A4' : 'Web'}
          </button>
          <button
            className="button"
            aria-label="버전 저장"
            onClick={async () => {
              await save();
              await window.lgReportAgent.revisions.create(report.id, 'manual', '사용자 버전 저장');
              setRevisions(await window.lgReportAgent.revisions.list(report.id));
            }}
          >
            <Save size={15} />
            <span className="button-label">버전 저장</span>
          </button>
          <button
            className="button"
            aria-label="버전 이력"
            onClick={async () => setRevisions(await window.lgReportAgent.revisions.list(report.id))}
          >
            <FileClock size={15} />
            <span className="button-label">이력</span>
          </button>
          <button className="button" aria-label="HTML 내보내기" onClick={() => void exportHtml()}>
            <Download size={15} />
            <span className="button-label">HTML</span>
          </button>
          <button
            className="button"
            aria-label="PDF 내보내기"
            onClick={() => void exportReport('pdf')}
          >
            <Download size={15} />
            <span className="button-label">PDF</span>
          </button>
          <button
            className="button icon"
            aria-label="Source 보기"
            title="Source 보기"
            onClick={async () => {
              const sources = await window.lgReportAgent.sources.list(report.id);
              alert(
                sources.length
                  ? sources
                      .map(
                        (source) =>
                          `${source.originalName} · ${source.extractionStatus}${source.warnings.length ? ` · ${source.warnings.join(', ')}` : ''}`,
                      )
                      .join('\n')
                  : '연결된 Source가 없습니다.',
              );
            }}
          >
            <Paperclip size={16} />
          </button>
          <button
            className="button icon"
            aria-label="보고서 복제"
            title="보고서 복제"
            onClick={async () => {
              const copy = await window.lgReportAgent.reports.duplicate(report.id);
              await onRefresh();
              alert(`복제했습니다: ${copy.title}`);
            }}
          >
            <Copy size={16} />
          </button>
          <button
            className="button icon danger"
            aria-label="보고서 삭제"
            title="보고서 삭제"
            onClick={async () => {
              if (confirm('이 보고서를 휴지통으로 이동하시겠습니까?')) {
                await window.lgReportAgent.reports.trash(report.id);
                await onRefresh();
                onRemoved();
              }
            }}
          >
            <Trash2 size={16} />
          </button>
          <button className="button icon" aria-label="인쇄" onClick={() => window.print()}>
            <Printer size={16} />
          </button>
          <button className="button icon" aria-label="AI 패널" onClick={() => setAiOpen(!aiOpen)}>
            {aiOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </button>
        </div>
        <EditorToolbar editor={editor} onImage={addImage} />
        {syncConflict && (
          <div className="error-box" role="alert">
            다른 변경 사항이 감지되어 현재 편집 내용을 유지했습니다. 저장하거나 새로고침 후 다시
            확인하세요.
          </div>
        )}
        {report.latestGeneration &&
          (report.latestGeneration.assumptions.length > 0 ||
            report.latestGeneration.warnings.length > 0) && (
            <div className="notice" role="note" aria-label="AI 생성 검토 정보">
              <strong>AI 생성 검토 정보</strong>
              {report.latestGeneration.executiveSummary && (
                <div>임원 요약: {report.latestGeneration.executiveSummary}</div>
              )}
              {report.latestGeneration.assumptions.length > 0 && (
                <div>가정: {report.latestGeneration.assumptions.join(' · ')}</div>
              )}
              {report.latestGeneration.warnings.length > 0 && (
                <div>주의: {report.latestGeneration.warnings.join(' · ')}</div>
              )}
              {report.latestGeneration.claimEvidence.length > 0 && (
                <div>
                  근거 연결:{' '}
                  {report.latestGeneration.claimEvidence
                    .map((entry) => `${entry.claim} → ${entry.sourceId} (${entry.locator})`)
                    .join(' · ')}
                </div>
              )}
            </div>
          )}
        {revisions.length > 0 && (
          <div className="notice">
            버전 이력 {revisions.length}개{' '}
            <button className="button" onClick={() => setRevisions([])}>
              닫기
            </button>
            {revisions.slice(0, 5).map((revision) => (
              <button
                className="button"
                key={revision.id}
                onClick={() => void restoreRevision(revision.id)}
              >
                복원 · {new Date(revision.createdAt).toLocaleString()}
              </button>
            ))}
          </div>
        )}
        <div className="workspace">
          <div className={`editor-wrap ${layout}`}>
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>
      {aiOpen && (
        <aside className="ai-panel">
          <div className="panel-head">
            <Bot size={18} /> AI 수정
          </div>
          <div className="messages">
            {messages.length === 0 && (
              <p className="muted">
                현재 보고서를 바꾸는 수정안을 요청하세요. 결과는 검토 후에만 적용됩니다.
              </p>
            )}
            {messages.map((message) => (
              <div className={`message ${message.role}`} key={message.id}>
                {displayMessage(message.content)}
              </div>
            ))}
            {ai.running && (
              <div className="message assistant">
                수정안을 생성하고 있습니다…{' '}
                <span className="muted">
                  {ai.stream.length > 0
                    ? `구조화된 응답 ${ai.stream.length.toLocaleString()}자 수신`
                    : '응답 대기 중'}
                </span>
              </div>
            )}
            {proposal && (
              <div>
                <strong>변경 미리보기</strong>
                <ul>
                  {proposal.summary.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                {proposal.assumptions.length > 0 && (
                  <div className="muted">가정: {proposal.assumptions.join(' · ')}</div>
                )}
                {proposal.warnings.length > 0 && (
                  <div className="warning">주의: {proposal.warnings.join(' · ')}</div>
                )}
                <div className="diff-preview">
                  {diffWords(editor.getHTML(), proposal.html).map((part, index) => (
                    <span
                      key={index}
                      className={part.added ? 'diff-add' : part.removed ? 'diff-remove' : ''}
                    >
                      {part.value}
                    </span>
                  ))}
                </div>
                <div className="modal-foot">
                  <button className="button" onClick={() => setProposal(null)}>
                    거절
                  </button>
                  <button className="primary" onClick={() => void applyProposal()}>
                    적용
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="chat-input">
            <div className="quick">
              {[
                '더 간결하게',
                '임원용으로 변경',
                '표로 정리',
                '근거를 명확히',
                '영문으로 변환',
              ].map((item) => (
                <button key={item} onClick={() => void requestRevision(item)}>
                  {item}
                </button>
              ))}
            </div>
            <textarea
              aria-label="AI 수정 요청"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.ctrlKey && e.key === 'Enter') void requestRevision();
              }}
              placeholder="수정 요청을 입력하세요"
            />
            {ai.running ? (
              <button className="button danger" onClick={() => void ai.cancel()}>
                취소
              </button>
            ) : (
              <button
                className="primary"
                disabled={!prompt.trim() || (!session && false)}
                onClick={() => void requestRevision()}
              >
                수정안 생성
              </button>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

function EditorToolbar({
  editor,
  onImage,
}: {
  editor: ReturnType<typeof useEditor> extends infer T ? NonNullable<T> : never;
  onImage: () => void;
}) {
  const command = (label: string, icon: React.ReactNode, active: boolean, action: () => void) => (
    <button
      className={`button icon ${active ? 'active' : ''}`}
      aria-label={label}
      title={label}
      onClick={action}
    >
      {icon}
    </button>
  );
  return (
    <div className="toolbar">
      {command('실행 취소', <Undo2 size={15} />, false, () => editor.chain().focus().undo().run())}
      {command('다시 실행', <Redo2 size={15} />, false, () => editor.chain().focus().redo().run())}
      <select
        aria-label="문단 유형"
        value={
          editor.isActive('heading', { level: 1 })
            ? '1'
            : editor.isActive('heading', { level: 2 })
              ? '2'
              : editor.isActive('heading', { level: 3 })
                ? '3'
                : editor.isActive('heading', { level: 4 })
                  ? '4'
                  : 'p'
        }
        onChange={(e) => {
          const value = e.target.value;
          if (value === 'p') editor.chain().focus().setParagraph().run();
          else
            editor
              .chain()
              .focus()
              .toggleHeading({ level: Number(value) as 1 | 2 | 3 | 4 })
              .run();
        }}
      >
        <option value="p">본문</option>
        <option value="1">제목 1</option>
        <option value="2">제목 2</option>
        <option value="3">제목 3</option>
        <option value="4">제목 4</option>
      </select>
      {command('굵게', <Bold size={15} />, editor.isActive('bold'), () =>
        editor.chain().focus().toggleBold().run(),
      )}
      {command('기울임', <Italic size={15} />, editor.isActive('italic'), () =>
        editor.chain().focus().toggleItalic().run(),
      )}
      {command('밑줄', <UnderlineIcon size={15} />, editor.isActive('underline'), () =>
        editor.chain().focus().toggleUnderline().run(),
      )}
      {command('왼쪽 정렬', <AlignLeft size={15} />, editor.isActive({ textAlign: 'left' }), () =>
        editor.chain().focus().setTextAlign('left').run(),
      )}
      {command(
        '가운데 정렬',
        <AlignCenter size={15} />,
        editor.isActive({ textAlign: 'center' }),
        () => editor.chain().focus().setTextAlign('center').run(),
      )}
      {command(
        '오른쪽 정렬',
        <AlignRight size={15} />,
        editor.isActive({ textAlign: 'right' }),
        () => editor.chain().focus().setTextAlign('right').run(),
      )}
      {command('글머리표', <List size={15} />, editor.isActive('bulletList'), () =>
        editor.chain().focus().toggleBulletList().run(),
      )}
      {command('번호 목록', <ListOrdered size={15} />, editor.isActive('orderedList'), () =>
        editor.chain().focus().toggleOrderedList().run(),
      )}
      {command('인용', <Quote size={15} />, editor.isActive('blockquote'), () =>
        editor.chain().focus().toggleBlockquote().run(),
      )}
      {command('표 삽입', <Table2 size={15} />, false, () =>
        editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      )}
      {editor.isActive('table') && (
        <>
          <button className="button" onClick={() => editor.chain().focus().addRowAfter().run()}>
            행+
          </button>
          <button className="button" onClick={() => editor.chain().focus().deleteRow().run()}>
            행-
          </button>
          <button className="button" onClick={() => editor.chain().focus().addColumnAfter().run()}>
            열+
          </button>
          <button className="button" onClick={() => editor.chain().focus().deleteColumn().run()}>
            열-
          </button>
        </>
      )}
      {command('이미지 삽입', <ImagePlus size={15} />, false, onImage)}
      {command('구분선', <Minus size={15} />, false, () =>
        editor.chain().focus().setHorizontalRule().run(),
      )}
      <button
        className="button"
        onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
      >
        서식 지우기
      </button>
    </div>
  );
}
async function hash(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function displayMessage(content: string): string {
  const revision = safeStructuredParse(content, revisionOutputSchema);
  if (revision) return revision.changeSummary.join('\n');
  const generated = safeStructuredParse(content, reportOutputSchema);
  if (generated) return generated.executiveSummary;
  const plan = safeStructuredParse(content, planningOutputSchema);
  if (plan) return `작성 계획: ${plan.suggestedTitle}`;
  return content;
}
function safeStructuredParse<T>(content: string, schema: z.ZodType<T>): T | null {
  try {
    return parseStructuredOutput(content, schema);
  } catch {
    return null;
  }
}
