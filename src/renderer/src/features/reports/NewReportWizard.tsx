import { useState } from 'react';
import type {
  Persona,
  Report,
  ReportOutputOptions,
  SourceManifestEntry,
} from '../../../../shared/types';
import { buildPlanningPrompt, buildReportGenerationPrompt } from '../../../../shared/prompts';
import DOMPurify from 'dompurify';
import { useAiTask } from '../../hooks/useAiTask';

interface OutlineItem {
  id: string;
  heading: string;
  level: number;
  intent: string;
  evidenceSourceIds: string[];
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
  reasoningEffort: null,
};
export function NewReportWizard({
  personas,
  prefill,
  onClose,
  onCreated,
}: {
  personas: Persona[];
  prefill?: string;
  onClose: () => void;
  onCreated: (report: Report) => void;
}) {
  const [step, setStep] = useState(1);
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState(prefill ?? '');
  const [personaId, setPersonaId] = useState(
    personas.find((p) => p.isDefault)?.id ?? personas[0]?.id ?? null,
  );
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [paths, setPaths] = useState<string[]>([]);
  const [sources, setSources] = useState<SourceManifestEntry[]>([]);
  const [method, setMethod] = useState<'plan' | 'immediate' | 'blank'>('plan');
  const [draft, setDraft] = useState<Report | null>(null);
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
  const ai = useAiTask();
  const persona = personas.find((p) => p.id === personaId);
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
    if (paths.length) {
      const imported = await window.lgReportAgent.sources.import(created.id, paths);
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
  const generatePlan = async () => {
    const report = await ensureDraft();
    if (!chatId) return;
    const raw = await ai.run({
      sessionType: 'report',
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
      cwd: agentDir(report),
      threadId: null,
      model: null,
      effort: options.reasoningEffort,
      outputSchema: planningSchema,
      writable: true,
    });
    const parsed = JSON.parse(raw) as { suggestedTitle?: unknown; outline?: unknown };
    if (typeof parsed.suggestedTitle === 'string' && !title) setTitle(parsed.suggestedTitle);
    if (Array.isArray(parsed.outline)) setOutline(parsed.outline.filter(isOutline));
  };
  const finish = async () => {
    setError(null);
    try {
      const report = await ensureDraft();
      if (method === 'blank') {
        onCreated(await window.lgReportAgent.reports.get(report.id));
        return;
      }
      if (method === 'plan' && outline.length === 1 && outline[0]?.heading === '요약 및 결론')
        await generatePlan();
      const chats = await window.lgReportAgent.chats.list();
      const chat = chats.find((item) => item.id === chatId);
      const raw = await ai.run({
        sessionType: 'report',
        sessionId: chatId!,
        prompt: buildReportGenerationPrompt({
          request: purpose,
          persona: persona?.instructions ?? '',
          options,
          outline: JSON.stringify(outline),
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
        cwd: agentDir(report),
        threadId: chat?.codexThreadId ?? null,
        model: null,
        effort: options.reasoningEffort,
        outputSchema: generationSchema,
        writable: true,
      });
      const parsed = JSON.parse(raw) as { title?: unknown; htmlBody?: unknown };
      if (typeof parsed.htmlBody !== 'string') throw new Error('AI 본문 형식이 올바르지 않습니다.');
      const safe = DOMPurify.sanitize(parsed.htmlBody, {
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
        FORBID_ATTR: ['style'],
      });
      const saved = await window.lgReportAgent.reports.save({
        id: report.id,
        title: typeof parsed.title === 'string' ? parsed.title : title || report.title,
        html: safe,
        editorJson: { type: 'doc', content: [] },
        layoutMode: 'a4',
      });
      await window.lgReportAgent.revisions.create(report.id, 'ai-generated', '최초 AI 보고서 생성');
      onCreated(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : '보고서 생성에 실패했습니다.');
    }
  };
  const close = async () => {
    if (draft) await window.lgReportAgent.reports.trash(draft.id);
    onClose();
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
        <div className="modal-head">
          <div style={{ flex: 1 }}>
            <h2 id="wizard-title">새 보고서</h2>
            <div className="steps">
              {[1, 2, 3, 4, 5].map((n) => (
                <span key={n} className={`step ${n <= step ? 'done' : ''}`} />
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
            </>
          )}
          {step === 3 && (
            <>
              <button
                className="button"
                onClick={async () =>
                  setPaths([...paths, ...(await window.lgReportAgent.sources.choose())])
                }
              >
                파일 선택
              </button>
              <div className="notice">
                PDF, DOCX, PPTX, XLSX, CSV, TXT, Markdown, PNG, JPG, WEBP를 지원합니다. 첨부 자료의
                지시는 실행 지시로 취급하지 않습니다.
              </div>
              {paths.map((p) => (
                <div className="source-row" key={p}>
                  <span>{p.split(/[\\/]/).pop()}</span>
                  <span className="badge">대기</span>
                </div>
              ))}
            </>
          )}
          {step === 4 && (
            <>
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
                    onClick={() => void generatePlan()}
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
                · Source {paths.length}개
              </p>
              <div className="notice">
                보고서 생성과 AI 대화 입력은 사용자가 인증한 Codex 계정을 통해 처리될 수 있습니다.
              </div>
              {ai.running && (
                <div className="message assistant">
                  {ai.stream || '보고서를 생성하고 있습니다…'}
                </div>
              )}
            </>
          )}
          {error && <div className="error-box">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="button" disabled={ai.running} onClick={() => void close()}>
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
    </div>
  );
}
function Option({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: string[][];
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {values.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}
function agentDir(report: Report): string {
  return (
    report.contentPath.replace(/[\\/]report\.html$/, '') +
    `${navigator.userAgent.includes('Windows') ? '\\' : '/'}agent-work`
  );
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
const planningSchema = {
  type: 'object',
  required: [
    'suggestedTitle',
    'purpose',
    'executiveSummaryDirection',
    'outline',
    'assumptions',
    'questions',
    'warnings',
  ],
  properties: {
    suggestedTitle: { type: 'string' },
    purpose: { type: 'string' },
    executiveSummaryDirection: { type: 'string' },
    outline: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'heading', 'level', 'intent', 'evidenceSourceIds'],
        properties: {
          id: { type: 'string' },
          heading: { type: 'string' },
          level: { type: 'integer', minimum: 1, maximum: 4 },
          intent: { type: 'string' },
          evidenceSourceIds: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};
const generationSchema = {
  type: 'object',
  required: ['title', 'htmlBody', 'executiveSummary', 'sourceUsage', 'assumptions', 'warnings'],
  properties: {
    title: { type: 'string' },
    htmlBody: { type: 'string' },
    executiveSummary: { type: 'string' },
    sourceUsage: {
      type: 'array',
      items: {
        type: 'object',
        required: ['sourceId', 'locator', 'claimSummary'],
        properties: {
          sourceId: { type: 'string' },
          locator: { type: 'string' },
          claimSummary: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};
