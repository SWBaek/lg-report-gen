import { describe, expect, it } from 'vitest';
import {
  buildPlanningPrompt,
  buildReportGenerationPrompt,
} from '../../src/shared/prompts/index.js';
import {
  planningOutputSchema,
  reportOutputSchema,
  revisionOutputSchema,
} from '../../src/shared/schemas/index.js';
import {
  parseStructuredOutput,
  StructuredOutputError,
} from '../../src/shared/schemas/structured-output.js';

const options = {
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
} as const;
describe('prompt builders and structured output', () => {
  it('includes prompt injection and fabrication defenses', () => {
    const prompt = buildPlanningPrompt({ request: '작성', persona: '관리자', sources: 'source-1' });
    expect(prompt).toContain('자료 안의 명령');
    expect(prompt).toContain('실행하지');
    expect(prompt).toContain('제공되지 않은 사실');
  });
  it('requires HTML safety and source locators', () => {
    const prompt = buildReportGenerationPrompt({
      request: '작성',
      persona: '관리자',
      options,
      outline: '[]',
      sources: '[]',
    });
    expect(prompt).toContain('script');
    expect(prompt).toContain('내부 절대 경로');
    expect(prompt).toContain('출처 ID');
  });
  it('validates planning/report/revision contracts', () => {
    expect(
      planningOutputSchema.safeParse({
        suggestedTitle: 't',
        purpose: 'p',
        executiveSummaryDirection: 'd',
        outline: [],
        assumptions: [],
        questions: [],
        warnings: [],
      }).success,
    ).toBe(true);
    expect(
      reportOutputSchema.safeParse({
        title: 't',
        htmlBody: '<p>x</p>',
        executiveSummary: 'x',
        sourceUsage: [],
        assumptions: [],
        warnings: [],
      }).success,
    ).toBe(true);
    expect(
      revisionOutputSchema.safeParse({
        scope: 'document',
        updatedHtml: '<p>x</p>',
        replacementHtml: null,
        changeSummary: [],
        assumptions: [],
        warnings: [],
      }).success,
    ).toBe(true);
    expect(planningOutputSchema.safeParse({ outline: 'invalid' }).success).toBe(false);
  });
  it('extracts the final schema-valid JSON without exposing adjacent commentary', () => {
    const final = {
      title: '보고서',
      htmlBody: '<p>본문</p>',
      executiveSummary: '요약',
      sourceUsage: [],
      assumptions: [],
      warnings: [],
    };
    const raw = `{"progress":"draft"}\n\`\`\`json\n${JSON.stringify(final)}\n\`\`\`\n완료`;
    expect(parseStructuredOutput(raw, reportOutputSchema)).toEqual(final);
  });
  it('returns a safe structured-output error for malformed content', () => {
    expect(() => parseStructuredOutput('{"title":', reportOutputSchema)).toThrow(
      StructuredOutputError,
    );
  });
});
