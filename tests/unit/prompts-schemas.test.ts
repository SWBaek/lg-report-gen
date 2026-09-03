import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildPlanningPrompt,
  buildReportGenerationPrompt,
} from '../../src/shared/prompts/index.js';
import {
  planningOutputSchema,
  reportOutputSchema,
  revisionOutputSchema,
  codexTurnSchema,
  codexCancelSchema,
  externalPurposeSchema,
  importSourcesSchema,
} from '../../src/shared/schemas/index.js';
import {
  parseStructuredOutput,
  StructuredOutputError,
} from '../../src/shared/schemas/structured-output.js';
import { outputSchemaFor } from '../../src/main/codex/output-schema.js';

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
    expect(prompt).toContain('Source가 없으면');
    expect(prompt).toContain('임의 ID를 만들지 않는다');
  });
  it('validates planning/report/revision contracts', () => {
    expect(
      planningOutputSchema.safeParse({
        schemaVersion: 1,
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
        schemaVersion: 1,
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
        schemaVersion: 1,
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
      schemaVersion: 1 as const,
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
  it('emits Codex-compatible strict JSON schemas with every object property required', () => {
    for (const schema of [planningOutputSchema, reportOutputSchema, revisionOutputSchema])
      expectCodexCompatibleObjectSchema(z.toJSONSchema(schema));
  });
  it('constrains generated evidence to the report Source IDs', () => {
    const sourceId = crypto.randomUUID();
    const generated = outputSchemaFor('generate', [sourceId])!;
    const generatedProperties = generated.properties as Record<string, Record<string, unknown>>;
    const usageItem = generatedProperties.sourceUsage?.items as Record<string, unknown>;
    const usageProperties = usageItem.properties as Record<string, Record<string, unknown>>;
    expect(usageProperties.sourceId?.enum).toEqual([sourceId]);

    const withoutSources = outputSchemaFor('generate', [])!;
    const emptyProperties = withoutSources.properties as Record<string, Record<string, unknown>>;
    expect(emptyProperties.sourceUsage?.maxItems).toBe(0);

    const plan = outputSchemaFor('plan', [])!;
    const planProperties = plan.properties as Record<string, Record<string, unknown>>;
    const outlineItem = planProperties.outline?.items as Record<string, unknown>;
    const outlineProperties = outlineItem.properties as Record<string, Record<string, unknown>>;
    expect(outlineProperties.evidenceSourceIds?.maxItems).toBe(0);
  });
  it('returns a safe structured-output error for malformed content', () => {
    expect(() => parseStructuredOutput('{"title":', reportOutputSchema)).toThrow(
      StructuredOutputError,
    );
  });
  it('keeps privileged intent inputs free of paths and policy controls', () => {
    expect(
      codexTurnSchema.safeParse({
        intent: 'chat',
        sessionId: crypto.randomUUID(),
        prompt: 'hello',
        threadId: 'renderer-supplied-thread',
      }).success,
    ).toBe(false);
    expect(codexCancelSchema.safeParse({ taskId: crypto.randomUUID() }).success).toBe(true);
    expect(codexCancelSchema.safeParse({ taskId: 'not-an-id' }).success).toBe(false);
    expect(externalPurposeSchema.safeParse({ purpose: 'codexCliDocs' }).success).toBe(true);
    expect(externalPurposeSchema.safeParse({ purpose: 'https://evil.example' }).success).toBe(
      false,
    );
    expect(
      importSourcesSchema.safeParse({
        reportId: crypto.randomUUID(),
        paths: ['C:\\secret.txt'],
      }).success,
    ).toBe(false);
  });
});

function expectCodexCompatibleObjectSchema(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const schema = value as Record<string, unknown>;
  if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
    const properties = schema.properties as Record<string, unknown>;
    expect(schema.additionalProperties).toBe(false);
    expect(new Set(schema.required as string[])).toEqual(new Set(Object.keys(properties)));
    for (const property of Object.values(properties)) expectCodexCompatibleObjectSchema(property);
  }
  if (schema.items) expectCodexCompatibleObjectSchema(schema.items);
}
