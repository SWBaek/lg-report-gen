import { useEffect, useRef, useState } from 'react';
import type {
  Persona,
  ProviderSnapshot,
  PublicReport,
  ReportOutputOptions,
  PublicSourceManifestEntry,
  SourceSelection,
} from '../../../../shared/types';
import {
  buildPlanningPrompt,
  buildReportGenerationPrompt,
  PROMPT_VERSIONS,
} from '../../../../shared/prompts';
import { planningOutputSchema, reportOutputSchema } from '../../../../shared/schemas';
import { parseStructuredOutput } from '../../../../shared/schemas/structured-output';
import DOMPurify from 'dompurify';
import { useAiTask } from '../../hooks/useAiTask';
import {
  initialModelReasoning,
  ModelReasoningSettings,
  reasoningLabel,
} from '../../components/ModelReasoningSettings';
import { ConfirmDialog } from '../../components/ConfirmDialog';

interface OutlineItem {
  id: string;
  heading: string;
  level: number;
  intent: string;
  evidenceSourceIds: string[];
}
interface PlanReview {
  assumptions: string[];
  questions: string[];
  warnings: string[];
  accepted: { assumptions: boolean[]; questions: boolean[]; warnings: boolean[] };
}
const DEFAULT_OPTIONS: ReportOutputOptions = {
  tone: 'standard',
  audience: 'manager',
  length: 'standard',
  format: 'balanced',
  language: 'ko',
  conclusionFirst: true,
  terminology: 'standard',
  evidence: 'standard',
  model: null,
  reasoningEffort: null,
};
export function NewReportWizard({
  personas,
  provider,
  prefill,
  onClose,
  onCreated,
}: {
  personas: Persona[];
  provider: ProviderSnapshot;
  prefill?: string;
  onClose: () => void;
  onCreated: (report: PublicReport) => void;
}) {
  const [step, setStep] = useState(1);
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState(prefill ?? '');
  const [personaId, setPersonaId] = useState(
    personas.find((p) => p.isDefault)?.id ?? personas[0]?.id ?? null,
  );
  const [options, setOptions] = useState<ReportOutputOptions>(() => initialOptions(provider));
  const [selections, setSelections] = useState<SourceSelection[]>([]);
  const [sources, setSources] = useState<PublicSourceManifestEntry[]>([]);
  const [method, setMethod] = useState<'plan' | 'immediate' | 'blank'>('plan');
  const [draft, setDraft] = useState<PublicReport | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [outline, setOutline] = useState<OutlineItem[]>([
    {
      id: crypto.randomUUID(),
      heading: '요약 및 결론',
      level: 1,
      intent: '핵심 결론과 요청사항',
      evidenceSourceIds: [],
    },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [planReview, setPlanReview] = useState<PlanReview | null>(null);
  const [warningConfirmation, setWarningConfirmation] = useState(false);
  const [closing, setClosing] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const ai = useAiTask();
  const aiRunningRef = useRef(ai.running);
  const closeRef = useRef<() => Promise<void>>(async () => undefined);
  const persona = personas.find((p) => p.id === personaId);
  const selectedModel = provider.availableModels.find((model) => model.id === options.model);
  useEffect(() => {
    aiRunningRef.current = ai.running;
  }, [ai.running]);
  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !aiRunningRef.current) {
        event.preventDefault();
        void closeRef.current();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusable();
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
    dialog.addEventListener('keydown', handleTab);
    const first = focusable()[0];
    if (first && !dialog.contains(document.activeElement)) first.focus();
    return () => dialog.removeEventListener('keydown', handleTab);
  }, [step, planReview, error, warningConfirmation]);
  useEffect(() => {
    setOptions((current) => {
      if (provider.availableModels.some((model) => model.id === current.model)) return current;
      return initialOptions(provider, current);
    });
  }, [provider.availableModels, provider.selectedModel]);
  const ensureDraft = async () => {
    if (draft) return draft;
    const created = await window.lgReportAgent.reports.create({
      title: title || '제목 없는 보고서',
      purpose,
      personaId,
      outputOptions: options,
      layoutMode: 'a4',
      html: `<h1>${escape(title || '제목 없는 보고서')}</h1><p></p>`,
    });
    setDraft(created);
    if (selections.length) {
      const imported = await window.lgReportAgent.sources.import(
        created.id,
        selections.map((selection) => selection.selectionId),
      );
      setSources(imported);
    }
    const chat = await window.lgReportAgent.chats.create(`${created.title} 작성`, created.id);
    setChatId(chat.id);
    return created;
  };
  const next = async () => {
    setError(null);
    try {
      if (step === 3) await ensureDraft();
      setStep((value) => Math.min(5, value + 1));
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리 중 오류가 발생했습니다.');
    }
  };
  const generatePlan = async (): Promise<OutlineItem[]> => {
    await ensureDraft();
    if (!chatId) throw new Error('보고서 AI Session을 준비하지 못했습니다.');
    const raw = await ai.run({
      intent: 'plan',
      sessionId: chatId,
      prompt: buildPlanningPrompt({
        request: purpose,
        persona: persona?.instructions ?? '',
        sources: JSON.stringify(
          sources.map((s) => ({
            id: s.sourceId,
            name: s.originalName,
            snapshot: s.metadata,
            sha256: s.sha256,
            warnings: s.warnings,
          })),
        ),
      }),
      displayText: '작성 계획 생성',
      model: options.model,
      effort: options.reasoningEffort,
    });
    const parsed = parseStructuredOutput(raw, planningOutputSchema);
    if (!title) setTitle(parsed.suggestedTitle);
    const nextOutline = parsed.outline.filter(isOutline);
    setOutline(nextOutline);
    setPlanReview({
      assumptions: parsed.assumptions,
      questions: parsed.questions,
      warnings: parsed.warnings,
      accepted: {
        assumptions: parsed.assumptions.map(() => false),
        questions: parsed.questions.map(() => false),
        warnings: parsed.warnings.map(() => false),
      },
    });
    return nextOutline;
  };
  const finish = async () => {
    if (method === 'plan' && planReview) {
      const { accepted, assumptions, questions, warnings } = planReview;
      const pendingReview =
        assumptions.some((_, i) => !accepted.assumptions[i]) ||
        questions.some((_, i) => !accepted.questions[i]);
      if (pendingReview) {
        setError('계획의 가정과 확인 질문을 모두 검토하고 확인해 주세요.');
        return;
      }
      if (warnings.some((_, i) => !accepted.warnings[i])) {
        setWarningConfirmation(true);
        return;
      }
    }
    await executeFinish();
  };
  const executeFinish = async () => {
    setError(null);
    try {
      const report = await ensureDraft();
      if (method === 'blank') {
        onCreated(await window.lgReportAgent.reports.get(report.id));
        return;
      }
      let generationOutline = outline;
      if (method === 'plan' && outline.length === 1 && outline[0]?.heading === '요약 및 결론')
        generationOutline = await generatePlan();
      const raw = await ai.run({
        intent: 'generate',
        sessionId: chatId!,
        prompt: buildReportGenerationPrompt({
          request: purpose,
          persona: persona?.instructions ?? '',
          options,
          outline: JSON.stringify(generationOutline),
          sources: JSON.stringify(
            sources.map((s) => ({
              id: s.sourceId,
              name: s.originalName,
              locator: s.metadata,
              warnings: s.warnings,
            })),
          ),
        }),
        displayText: '보고서 본문 생성',
        model: options.model,
        effort: options.reasoningEffort,
      });
      const parsed = parseStructuredOutput(raw, reportOutputSchema);
      const safe = DOMPurify.sanitize(parsed.htmlBody, {
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
        FORBID_ATTR: ['style'],
      });
      const saved = await window.lgReportAgent.reports.save({
        id: report.id,
        title: parsed.title || title || report.title,
        html: safe,
        editorJson: { type: 'doc', content: [] },
        layoutMode: 'a4',
        generation: {
          schemaVersion: 1,
          executiveSummary: parsed.executiveSummary,
          sourceUsage: parsed.sourceUsage,
          assumptions: parsed.assumptions,
          warnings: parsed.warnings,
          model: options.model,
          promptVersion: PROMPT_VERSIONS.generation,
          claimEvidence: parsed.sourceUsage.map((usage) => ({
            claim: usage.claimSummary,
            sourceId: usage.sourceId,
            locator: usage.locator,
            evidenceExcerpt: undefined,
          })),
        },
      });
      await window.lgReportAgent.revisions.create(report.id, 'ai-generated', '최초 AI 보고서 생성');
      onCreated(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : '보고서 생성에 실패했습니다.');
    }
  };
  const close = async () => {
    if (closing) return;
    setClosing(true);
    try {
      if (draft) {
        await window.lgReportAgent.reports.trash(draft.id);
        if (chatId) await window.lgReportAgent.chats.delete(chatId);
      }
      onClose();
      requestAnimationFrame(() => opener.current?.focus());
    } catch (e) {
      setError(e instanceof Error ? e.message : '임시 보고서를 정리하지 못했습니다.');
    } finally {
      setClosing(false);
    }
  };
  useEffect(() => {
    closeRef.current = close;
  }, [close]);
  const updateReview = (kind: keyof PlanReview['accepted'], index: number) => {
    setPlanReview((current) =>
      current
        ? {
            ...current,
            accepted: {
              ...current.accepted,
              [kind]: current.accepted[kind].map((value, i) => (i === index ? !value : value)),
            },
          }
        : current,
    );
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wizard-title"
        aria-describedby="wizard-description"
      >
        <div className="modal-head">
          <div style={{ flex: 1 }}>
            <h2 id="wizard-title">새 보고서</h2>
            <p id="wizard-description" className="sr-only">
              보고서 작성 정보를 입력하고 계획을 검토한 뒤 생성합니다. Escape로 닫을 수 있습니다.
            </p>
            <div className="steps">
              {[1, 2, 3, 4, 5].map((n) => (
                <span
                  key={n}
                  className={`step ${n <= step ? 'done' : ''}`}
                  aria-label={`${n}단계`}
                  aria-current={n === step ? 'step' : undefined}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="modal-body">
          {step === 1 && (
            <>
              <div className="field">
                <label>제목</label>
                <input
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="비워두면 AI가 제안할 수 있습니다"
                />
              </div>
              <div className="field">
                <label>보고서 목적 또는 작성 요청</label>
                <textarea
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder="보고 대상, 배경, 필요한 결정이나 결과를 적으세요"
                />
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <div className="field">
                <label>Persona</label>
                <select value={personaId ?? ''} onChange={(e) => setPersonaId(e.target.value)}>
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <p className="muted">{persona?.description}</p>
              </div>
              <div className="grid">
                <Option
                  label="문체"
                  value={options.tone}
                  values={[
                    ['concise', '간결'],
                    ['standard', '표준'],
                    ['detailed', '상세'],
                  ]}
                  onChange={(tone) =>
                    setOptions({ ...options, tone: tone as ReportOutputOptions['tone'] })
                  }
                />
                <Option
                  label="독자"
                  value={options.audience}
                  values={[
                    ['executive', '임원'],
                    ['manager', '관리자'],
                    ['practitioner', '실무자'],
                    ['expert', '전문가'],
                  ]}
                  onChange={(audience) =>
                    setOptions({
                      ...options,
                      audience: audience as ReportOutputOptions['audience'],
                    })
                  }
                />
                <Option
                  label="분량"
                  value={options.length}
                  values={[
                    ['one-page', '1페이지'],
                    ['short', '짧게'],
                    ['standard', '표준'],
                    ['detailed', '상세'],
                  ]}
                  onChange={(length) =>
                    setOptions({ ...options, length: length as ReportOutputOptions['length'] })
                  }
                />
                <Option
                  label="표현"
                  value={options.format}
                  values={[
                    ['narrative', '서술 중심'],
                    ['table', '표 중심'],
                    ['bullets', '핵심 항목'],
                    ['balanced', '균형형'],
                  ]}
                  onChange={(format) =>
                    setOptions({ ...options, format: format as ReportOutputOptions['format'] })
                  }
                />
                <Option
                  label="언어"
                  value={options.language}
                  values={[
                    ['ko', '한국어'],
                    ['en', '영어'],
                    ['bilingual', '한영 병기'],
                  ]}
                  onChange={(language) =>
                    setOptions({
                      ...options,
                      language: language as ReportOutputOptions['language'],
                    })
                  }
                />
                <label>
                  <input
                    type="checkbox"
                    checked={options.conclusionFirst}
                    onChange={(e) => setOptions({ ...options, conclusionFirst: e.target.checked })}
                  />{' '}
                  결론 우선
                </label>
              </div>
              <section className="advanced-settings" aria-labelledby="report-ai-settings-title">
                <div className="section-heading" id="report-ai-settings-title">
                  <strong>AI 모델 설정</strong>
                  <span className="muted">이 보고서의 계획과 본문 생성에 적용됩니다.</span>
                </div>
                <ModelReasoningSettings
                  provider={provider}
                  value={{ model: options.model, reasoningEffort: options.reasoningEffort }}
                  onChange={(value) => setOptions({ ...options, ...value })}
                  onRefresh={async () => {
                    await window.lgReportAgent.codex.refresh();
                  }}
                />
              </section>
            </>
          )}
          {step === 3 && (
            <>
              <button
                className="button"
                onClick={async () =>
                  setSelections([...selections, ...(await window.lgReportAgent.sources.choose())])
                }
              >
                파일 선택
              </button>
              <div className="notice">
                PDF, DOCX, PPTX, XLSX, CSV, TXT, Markdown, PNG, JPG, WEBP를 지원합니다. 첨부 자료의
                지시는 실행 지시로 취급하지 않습니다.
              </div>
              {selections.map((selection) => (
                <div className="source-row" key={selection.selectionId}>
                  <span className="source-name">{selection.originalName}</span>
                  <span className="badge">대기 · 가져오기 전</span>
                  <button
                    className="button"
                    onClick={() =>
                      setSelections((items) =>
                        items.filter((item) => item.selectionId !== selection.selectionId),
                      )
                    }
                  >
                    선택 제거
                  </button>
                </div>
              ))}
              <p className="muted source-capability">
                파일 미리보기·재시도·가져온 파일 삭제는 현재 API에서 지원되지 않습니다. 가져오기 후
                상태와 경고만 확인할 수 있습니다.
              </p>
            </>
          )}
          {step === 4 && (
            <>
              {sources.length > 0 && <SourceManifestSummary sources={sources} />}
              <div className="field">
                <label>생성 방식</label>
                {[
                  ['plan', '목차와 작성 계획 검토 후 생성'],
                  ['immediate', '즉시 생성'],
                  ['blank', '빈 Report 생성'],
                ].map(([value, label]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="method"
                      checked={method === value}
                      onChange={() => setMethod(value as typeof method)}
                    />{' '}
                    {label}
                  </label>
                ))}
              </div>
              {method === 'plan' && (
                <>
                  <button
                    className="button"
                    disabled={ai.running}
                    onClick={() =>
                      void generatePlan().catch((reason: unknown) =>
                        setError(
                          reason instanceof Error
                            ? reason.message
                            : '작성 계획을 생성하지 못했습니다.',
                        ),
                      )
                    }
                  >
                    {ai.running ? '계획 생성 중…' : 'AI 작성 계획 생성'}
                  </button>
                  {outline.map((item, index) => (
                    <div className="source-row" key={item.id}>
                      <select
                        value={item.level}
                        onChange={(e) =>
                          setOutline(
                            outline.map((v, i) =>
                              i === index ? { ...v, level: Number(e.target.value) } : v,
                            ),
                          )
                        }
                      >
                        <option value="1">H1</option>
                        <option value="2">H2</option>
                        <option value="3">H3</option>
                        <option value="4">H4</option>
                      </select>
                      <input
                        value={item.heading}
                        onChange={(e) =>
                          setOutline(
                            outline.map((v, i) =>
                              i === index ? { ...v, heading: e.target.value } : v,
                            ),
                          )
                        }
                      />
                      <div className="evidence-chips" aria-label={`${item.heading} 근거 Source`}>
                        {item.evidenceSourceIds.length > 0 ? (
                          item.evidenceSourceIds.map((sourceId) => {
                            const source = sources.find(
                              (candidate) => candidate.sourceId === sourceId,
                            );
                            return (
                              <span className="chip" key={sourceId}>
                                근거: {source?.originalName ?? sourceId.slice(0, 8)}
                              </span>
                            );
                          })
                        ) : (
                          <span className="muted">연결된 근거 없음</span>
                        )}
                      </div>
                      <input
                        value={item.intent}
                        onChange={(e) =>
                          setOutline(
                            outline.map((v, i) =>
                              i === index ? { ...v, intent: e.target.value } : v,
                            ),
                          )
                        }
                      />
                      <button
                        className="button"
                        onClick={() => setOutline(outline.filter((_, i) => i !== index))}
                      >
                        삭제
                      </button>
                    </div>
                  ))}
                  <button
                    className="button"
                    onClick={() =>
                      setOutline([
                        ...outline,
                        {
                          id: crypto.randomUUID(),
                          heading: '새 항목',
                          level: 2,
                          intent: '',
                          evidenceSourceIds: [],
                        },
                      ])
                    }
                  >
                    항목 추가
                  </button>
                  {planReview && <PlanReviewPanel review={planReview} onToggle={updateReview} />}
                </>
              )}
            </>
          )}
          {step === 5 && (
            <>
              <h3>검토 및 시작</h3>
              <p>
                <strong>{title || '제목 없음'}</strong>
              </p>
              <p>{purpose || '목적 미입력'}</p>
              <p>
                {persona?.name} ·{' '}
                {method === 'plan'
                  ? '계획 검토'
                  : method === 'immediate'
                    ? '즉시 생성'
                    : '빈 보고서'}{' '}
                · Source {selections.length}개
              </p>
              {selectedModel && (
                <p className="muted">
                  {selectedModel.displayName} · Reasoning{' '}
                  {reasoningLabel(
                    options.reasoningEffort ?? selectedModel.defaultReasoningEffort ?? '',
                  )}
                </p>
              )}
              <div className="notice">
                보고서 생성과 AI 대화 입력은 사용자가 인증한 Codex 계정을 통해 처리될 수 있습니다.
              </div>
              {ai.running && (
                <div className="message assistant">
                  <strong>보고서를 생성하고 있습니다…</strong>
                  <span className="muted">
                    {' '}
                    구조화된 응답 수신 {formatCharacters(ai.stream.length)}
                  </span>
                </div>
              )}
            </>
          )}
          {error && <div className="error-box">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="button" disabled={ai.running || closing} onClick={() => void close()}>
            취소
          </button>
          {step > 1 && (
            <button className="button" disabled={ai.running} onClick={() => setStep(step - 1)}>
              이전
            </button>
          )}
          {step < 5 ? (
            <button
              className="primary"
              disabled={step === 1 && !purpose.trim()}
              onClick={() => void next()}
            >
              다음
            </button>
          ) : ai.running ? (
            <button className="button danger" onClick={() => void ai.cancel()}>
              생성 취소
            </button>
          ) : (
            <button className="primary" onClick={() => void finish()}>
              생성 시작
            </button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={warningConfirmation}
        title="검토하지 않은 주의사항이 있습니다."
        description="주의사항을 확인하지 않고 보고서를 생성하시겠습니까?"
        confirmLabel="그래도 생성"
        onCancel={() => setWarningConfirmation(false)}
        onConfirm={() => {
          setWarningConfirmation(false);
          void executeFinish();
        }}
      />
    </div>
  );
}

function PlanReviewPanel({
  review,
  onToggle,
}: {
  review: PlanReview;
  onToggle: (kind: keyof PlanReview['accepted'], index: number) => void;
}) {
  const groups: Array<[keyof PlanReview['accepted'], string, string[]]> = [
    ['assumptions', '가정 — 사실로 확정하기 전 검토', review.assumptions],
    ['questions', '확인 질문 — 답이 필요한 항목', review.questions],
    ['warnings', '주의사항 — 생성 전 확인', review.warnings],
  ];
  return (
    <section className="plan-review" aria-labelledby="plan-review-title">
      <h3 id="plan-review-title">작성 계획 검토</h3>
      <p className="muted">각 항목을 읽고 확인하면 생성 단계로 진행할 수 있습니다.</p>
      {groups.map(([kind, label, items]) => (
        <fieldset className={`review-group ${kind === 'warnings' ? 'warning' : ''}`} key={kind}>
          <legend>{label}</legend>
          {items.length === 0 ? (
            <p className="muted">없음</p>
          ) : (
            items.map((item, index) => (
              <label className="review-item" key={`${kind}-${index}`}>
                <input
                  type="checkbox"
                  checked={review.accepted[kind][index] ?? false}
                  onChange={() => onToggle(kind, index)}
                />
                <span>{item}</span>
              </label>
            ))
          )}
        </fieldset>
      ))}
    </section>
  );
}

function SourceManifestSummary({ sources }: { sources: PublicSourceManifestEntry[] }) {
  return (
    <section className="source-manifest" aria-labelledby="source-manifest-title">
      <h3 id="source-manifest-title">첨부 Source 상태</h3>
      {sources.map((source) => (
        <div className="source-card" key={source.sourceId}>
          <div className="source-card-head">
            <strong className="source-name">{source.originalName}</strong>
            <span className={`badge status-${source.extractionStatus}`}>
              {sourceStatusLabel(source.extractionStatus)}
            </span>
          </div>
          <div className="source-meta">
            <span>크기 {formatBytes(source.size)}</span>
            <span title={source.sha256}>SHA-256 {source.sha256.slice(0, 12)}…</span>
            {source.warnings.length > 0 && (
              <span className="warning">경고 {source.warnings.length}건</span>
            )}
          </div>
          {source.warnings.length > 0 && (
            <ul className="source-warnings">
              {source.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <div className="source-actions">
            <button
              className="button"
              disabled
              title="현재 API에서 Source 미리보기를 지원하지 않습니다."
            >
              미리보기 (지원 안 함)
            </button>
            <button
              className="button"
              disabled
              title="현재 API에서 Source 재시도를 지원하지 않습니다."
            >
              재시도 (지원 안 함)
            </button>
            <button
              className="button"
              disabled
              title="현재 API에서 가져온 Source 삭제를 지원하지 않습니다."
            >
              삭제 (지원 안 함)
            </button>
          </div>
        </div>
      ))}
      <p className="muted">
        파일 내용은 로컬 Workspace에서 추출되며, 아래 상태는 현재 가져오기 결과의 요약입니다.
      </p>
    </section>
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '알 수 없음';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
function sourceStatusLabel(status: PublicSourceManifestEntry['extractionStatus']): string {
  return {
    pending: '대기',
    extracting: '추출 중',
    ready: '준비됨',
    partial: '부분 추출',
    failed: '실패',
  }[status];
}
function Option({
  label,
  value,
  values,
  disabled = false,
  emptyLabel,
  onChange,
}: {
  label: string;
  value: string;
  values: string[][];
  disabled?: boolean;
  emptyLabel?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <select
        aria-label={label}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {values.length === 0 && <option value="">{emptyLabel ?? '선택 항목 없음'}</option>}
        {values.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}
function initialOptions(
  provider: ProviderSnapshot,
  base: ReportOutputOptions = DEFAULT_OPTIONS,
): ReportOutputOptions {
  const ai = initialModelReasoning(provider, base);
  return {
    ...base,
    ...ai,
  };
}
function formatCharacters(value: number): string {
  return value > 0 ? `${value.toLocaleString()}자` : '대기 중';
}
function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function isOutline(value: unknown): value is OutlineItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as OutlineItem).id === 'string' &&
    typeof (value as OutlineItem).heading === 'string' &&
    typeof (value as OutlineItem).intent === 'string' &&
    typeof (value as OutlineItem).level === 'number' &&
    Array.isArray((value as OutlineItem).evidenceSourceIds)
  );
}
